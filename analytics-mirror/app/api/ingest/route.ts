import { NextResponse } from "next/server";
import { sql, query } from "@/lib/sql";
import { ensureSchema, ensureEventsSchema, ensureSpanSchema, ensureSpanArmSchema,
  ensureSystemSchema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Headroom over the Pi exporter's 10s client timeout, so a large catch-up batch is never
// cut off mid-flight and left to retry forever.
export const maxDuration = 60;

// The Pi POSTs a state snapshot here every ~60s. Bearer-token auth (INGEST_TOKEN) — the
// only unauthenticated-by-cookie route, because the Pi has no cookie. Read-only mirror:
// this never sends anything back to the Pi.
export async function POST(req: Request) {
  const token = process.env.INGEST_TOKEN;
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const ts = Number(body?.ts);
  const pumps = Array.isArray(body?.pumps) ? body.pumps : [];
  if (!ts || !pumps.length) {
    return NextResponse.json({ error: "empty snapshot" }, { status: 400 });
  }

  await ensureSchema();
  for (const p of pumps) {
    if (p.full && typeof p.full === "object") {
      await sql`INSERT INTO pump_snapshots (pump_id, ts, name, snapshot)
        VALUES (${p.id}, ${ts}, ${p.name ?? null}, ${JSON.stringify(p.full)})
        ON CONFLICT (pump_id) DO UPDATE SET
          ts = EXCLUDED.ts, name = EXCLUDED.name, snapshot = EXCLUDED.snapshot`;
    }
    await sql`INSERT INTO readings
      (ts, pump_id, name, online, state, mode_kind, setpoint_c, inlet_c, outlet_c,
       ambient_c, power_w, active_faults, error_rate)
      VALUES (${ts}, ${p.id}, ${p.name ?? null}, ${!!p.online}, ${p.state ?? null},
              ${p.mode_kind ?? null}, ${p.setpoint_c ?? null}, ${p.inlet_c ?? null},
              ${p.outlet_c ?? null}, ${p.ambient_c ?? null}, ${p.power_w ?? null},
              ${p.active_faults ?? null}, ${p.error_rate ?? null})`;
  }
  // retention: keep ~90 days (free-tier friendly)
  await sql`DELETE FROM readings WHERE ts < ${ts - 90 * 86400}`;

  // Events feed (bridge/exporter.py): the Pi attaches new local events keyed by
  // source_id = its own event id. ON CONFLICT DO NOTHING makes re-sends idempotent.
  // Wrapped so a malformed batch never fails the telemetry ingest above.
  let eventsStored = 0;
  const events = Array.isArray(body?.events) ? body.events : [];
  if (events.length) {
    try { await ensureEventsSchema(); }
    catch (err) { console.error("events schema ensure failed (telemetry unaffected):", err); }
    // Validate first, then insert the whole batch in ONE round-trip. Per-row inserts made
    // a backlog undrainable: 500 rows meant 500 sequential round-trips, which blew the Pi's
    // 10s client timeout, so its cursor never advanced and the same batch retried forever.
    type EventRow = {
      pumpId: string; sourceId: number | null; evTs: number;
      type: string | null; code: string | null; severity: string | null;
      message: string | null; detail: string | null;
    };
    const rows: EventRow[] = events.slice(0, 500).flatMap((e: any): EventRow[] => {
      const pumpId = e?.pump_id;
      const evTs = Number(e?.ts);
      if (!pumpId || !evTs) return []; // pump_id + ts are NOT NULL / meaningful
      return [{
        pumpId: String(pumpId),
        sourceId: e?.source_id == null ? null : Number(e.source_id),
        evTs,
        type: e?.type ?? null,
        code: e?.code ?? null,
        severity: e?.severity ?? null,
        message: e?.message ?? null,
        detail: e?.detail == null ? null
          : typeof e.detail === "string" ? e.detail
          : JSON.stringify(e.detail),
      }];
    });
    if (rows.length) {
      const insertBatch = () => query(
        `INSERT INTO pump_events (pump_id, source_id, ts, type, code, severity, message, detail)
         SELECT * FROM UNNEST($1::text[], $2::bigint[], $3::double precision[], $4::text[],
                              $5::text[], $6::text[], $7::text[], $8::jsonb[])
         ON CONFLICT (pump_id, source_id) DO NOTHING`,
        [rows.map((r) => r.pumpId), rows.map((r) => r.sourceId), rows.map((r) => r.evTs),
         rows.map((r) => r.type), rows.map((r) => r.code), rows.map((r) => r.severity),
         rows.map((r) => r.message), rows.map((r) => r.detail)],
      );
      try {
        await insertBatch();
        eventsStored = rows.length;
      } catch (err) {
        // One malformed row would otherwise poison the batch forever — the same deadlock
        // in a new costume. Fall back to per-row so the bad row is skipped, not retried.
        console.error("event batch insert failed, falling back to per-row:", err);
        for (const r of rows) {
          try {
            await sql`INSERT INTO pump_events
              (pump_id, source_id, ts, type, code, severity, message, detail)
              VALUES (${r.pumpId}, ${r.sourceId}, ${r.evTs}, ${r.type},
                      ${r.code}, ${r.severity}, ${r.message}, ${r.detail}::jsonb)
              ON CONFLICT (pump_id, source_id) DO NOTHING`;
            eventsStored++;
          } catch (e2) {
            console.error("event ingest row skipped:", e2);
          }
        }
      }
    }
  }

  // SPAN local circuit-power feed (bridge/span_local.py via exporter): high-res instantPowerW
  // for the "Buffer Tank" element + the "Air-Water" heat pumps. Same idempotent, batch-safe
  // pattern as events — dedup on source_id (the Pi's span_samples.id), skip a bad row.
  let spanStored = 0;
  const spanRows = Array.isArray(body?.span) ? body.span : [];
  if (spanRows.length) {
    try { await ensureSpanSchema(); }
    catch (err) { console.error("span schema ensure failed (telemetry unaffected):", err); }
    // Same batching as events, and for the same reason — this is the feed that actually
    // deadlocked. After the 2026-08-20 outage the Pi had ~13k span samples queued; at one
    // round-trip per row a 500-row push could not finish inside its 10s timeout, so the
    // cursor never advanced and the backlog was permanently stuck.
    type SpanRow = {
      sourceId: number | null; sTs: number; circuitId: string | null;
      name: string; powerW: number | null;
    };
    const sRows: SpanRow[] = spanRows.slice(0, 1000).flatMap((s: any): SpanRow[] => {
      const sTs = Number(s?.ts);
      const name = s?.name;
      if (!sTs || !name) return [];
      return [{
        sourceId: s?.source_id == null ? null : Number(s.source_id),
        sTs,
        circuitId: s?.circuit_id ?? null,
        name: String(name),
        powerW: s?.power_w ?? null,
      }];
    });
    if (sRows.length) {
      try {
        await query(
          `INSERT INTO span_readings (source_id, ts, circuit_id, name, power_w)
           SELECT * FROM UNNEST($1::bigint[], $2::double precision[], $3::text[], $4::text[], $5::real[])
           ON CONFLICT (source_id) DO NOTHING`,
          [sRows.map((r) => r.sourceId), sRows.map((r) => r.sTs), sRows.map((r) => r.circuitId),
           sRows.map((r) => r.name), sRows.map((r) => r.powerW)],
        );
        spanStored = sRows.length;
      } catch (err) {
        console.error("span batch insert failed, falling back to per-row:", err);
        for (const r of sRows) {
          try {
            await sql`INSERT INTO span_readings (source_id, ts, circuit_id, name, power_w)
              VALUES (${r.sourceId}, ${r.sTs}, ${r.circuitId}, ${r.name}, ${r.powerW})
              ON CONFLICT (source_id) DO NOTHING`;
            spanStored++;
          } catch (e2) {
            console.error("span ingest row skipped:", e2);
          }
        }
      }
    }
    await sql`DELETE FROM span_readings WHERE ts < ${ts - 90 * 86400}`;
  }

  // Backup-element ARM feed: shadow/live decision events + current relay/intent snapshot. Returns
  // span_arm_desired (the owner's portal toggle) so the bridge applies it. Same batch-safe pattern.
  let spanArmStored = 0;
  let spanArmDesired: boolean | null = null;
  try {
    await ensureSpanArmSchema();
    for (const e of (Array.isArray(body?.span_arm_events) ? body.span_arm_events : []).slice(0, 500)) {
      try {
        const eTs = Number(e?.ts);
        if (!eTs) continue;
        const sid = e?.source_id == null ? null : Number(e.source_id);
        await sql`INSERT INTO span_arm_events (source_id, ts, circuit_id, relay_state, armed, live, action, detail)
          VALUES (${sid}, ${eTs}, ${e?.circuit_id ?? null}, ${e?.relay_state ?? null}, ${!!e?.armed},
                  ${!!e?.live}, ${e?.action ?? null}, ${e?.detail ?? null})
          ON CONFLICT (source_id) DO NOTHING`;
        spanArmStored++;
      } catch (err) { console.error("span_arm event skipped:", err); }
    }
    const st = body?.span_arm;
    if (st && typeof st === "object") {
      await sql`INSERT INTO span_arm_state (id, ts, circuit, relay_state, controllable, armed, live, updated_at)
        VALUES (1, ${Number(st.ts) || null}, ${st.circuit ?? null}, ${st.relay_state ?? null},
                ${st.controllable ?? null}, ${st.armed ?? null}, ${st.live ?? null}, now())
        ON CONFLICT (id) DO UPDATE SET ts = EXCLUDED.ts, circuit = EXCLUDED.circuit,
          relay_state = EXCLUDED.relay_state, controllable = EXCLUDED.controllable,
          armed = EXCLUDED.armed, live = EXCLUDED.live, updated_at = now()`;
    }
    const dr = await sql`SELECT desired_armed FROM span_arm_state WHERE id = 1`;
    spanArmDesired = dr.rowCount ? (dr.rows[0].desired_armed as boolean | null) : null;
    await sql`DELETE FROM span_arm_events WHERE ts < ${ts - 90 * 86400}`;
  } catch (err) {
    console.error("span_arm ingest failed (telemetry unaffected):", err);
  }

  // Pi system health (bridge/sysstat.py via exporter): the latest CPU/RAM/temp/disk row.
  // Single upsert keyed on ts; wrapped so a malformed payload never fails the telemetry above.
  let systemStored = false;
  try {
    const sys = body?.system;
    if (sys && typeof sys === "object" && Number(sys.ts)) {
      await ensureSystemSchema();
      await sql`INSERT INTO system_stats
        (ts, cpu_pct, load1, load5, load15, ncpu, mem_used_pct, mem_total_mb, mem_avail_mb,
         disk_used_pct, disk_free_gb, disk_total_gb, cpu_temp_c, uptime_s)
        VALUES (${Number(sys.ts)}, ${sys.cpu_pct ?? null}, ${sys.load1 ?? null},
                ${sys.load5 ?? null}, ${sys.load15 ?? null}, ${sys.ncpu ?? null},
                ${sys.mem_used_pct ?? null}, ${sys.mem_total_mb ?? null}, ${sys.mem_avail_mb ?? null},
                ${sys.disk_used_pct ?? null}, ${sys.disk_free_gb ?? null}, ${sys.disk_total_gb ?? null},
                ${sys.cpu_temp_c ?? null}, ${sys.uptime_s ?? null})
        ON CONFLICT (ts) DO NOTHING`;
      await sql`DELETE FROM system_stats WHERE ts < ${ts - 90 * 86400}`;
      systemStored = true;
    }
  } catch (err) {
    console.error("system_stats ingest failed (telemetry unaffected):", err);
  }

  return NextResponse.json({
    ok: true, stored: pumps.length, events: eventsStored, span: spanStored,
    span_arm: spanArmStored, span_arm_desired: spanArmDesired, system: systemStored,
  });
}
