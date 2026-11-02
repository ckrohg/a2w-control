import { NextResponse } from "next/server";
import { sql, query } from "@/lib/sql";
import { ensureSchema, ensureEventsSchema, ensureSpanSchema, ensureSpanArmSchema,
  ensureSystemSchema } from "@/lib/db";
import { parseSnapshotTs, parsePumps, parseEvents, parseSpanRows, parseSpanArmEvents,
  parseSystem } from "@/lib/ingest-parse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Headroom over the Pi exporter's 10s client timeout, so a large catch-up batch is never
// cut off mid-flight and left to retry forever.
export const maxDuration = 60;

// The Pi POSTs a state snapshot here every ~60s. Bearer-token auth (INGEST_TOKEN) — the
// only unauthenticated-by-cookie route, because the Pi has no cookie. Read-only mirror:
// this never sends anything back to the Pi.
//
// All field validation/normalisation lives in lib/ingest-parse.ts (pure, tested); this file
// is only the SQL. Anything the parsers drop was unstorable, and dropping it is what keeps
// one bad row from turning the whole push into a 500 the exporter retries forever.
export async function POST(req: Request) {
  const token = process.env.INGEST_TOKEN;
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const ts = parseSnapshotTs(body);
  // A pump with no id is dropped by parsePumps, not fatal: before, it threw inside the
  // readings INSERT (pump_id NOT NULL), the response was a 500, the Pi's cursor never
  // advanced, and the same batch retried forever. 400 only when NO valid pump is left.
  const pumps = parsePumps(body);
  if (!ts || !pumps.length) {
    return NextResponse.json({ error: "empty snapshot" }, { status: 400 });
  }

  await ensureSchema();
  for (const p of pumps) {
    if (p.full) {
      await sql`INSERT INTO pump_snapshots (pump_id, ts, name, snapshot)
        VALUES (${p.id}, ${ts}, ${p.name}, ${p.full})
        ON CONFLICT (pump_id) DO UPDATE SET
          ts = EXCLUDED.ts, name = EXCLUDED.name, snapshot = EXCLUDED.snapshot`;
    }
    await sql`INSERT INTO readings
      (ts, pump_id, name, online, state, mode_kind, setpoint_c, inlet_c, outlet_c,
       ambient_c, power_w, active_faults, error_rate)
      VALUES (${ts}, ${p.id}, ${p.name}, ${p.online}, ${p.state},
              ${p.modeKind}, ${p.setpointC}, ${p.inletC},
              ${p.outletC}, ${p.ambientC}, ${p.powerW},
              ${p.activeFaults}, ${p.errorRate})`;
  }
  // retention: keep ~90 days (free-tier friendly)
  await sql`DELETE FROM readings WHERE ts < ${ts - 90 * 86400}`;

  // Events feed (bridge/exporter.py): the Pi attaches new local events keyed by
  // source_id = its own event id. ON CONFLICT DO NOTHING makes re-sends idempotent.
  // Wrapped so a malformed batch never fails the telemetry ingest above.
  let eventsStored = 0;
  const rows = parseEvents(body);
  if (rows.length) {
    try { await ensureEventsSchema(); }
    catch (err) { console.error("events schema ensure failed (telemetry unaffected):", err); }
    // Validated above; insert the whole batch in ONE round-trip. Per-row inserts made
    // a backlog undrainable: 500 rows meant 500 sequential round-trips, which blew the Pi's
    // 10s client timeout, so its cursor never advanced and the same batch retried forever.
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

  // SPAN local circuit-power feed (bridge/span_local.py via exporter): high-res instantPowerW
  // for the "Buffer Tank" element + the "Air-Water" heat pumps. Same idempotent, batch-safe
  // pattern as events — dedup on source_id (the Pi's span_samples.id), skip a bad row.
  let spanStored = 0;
  const sRows = parseSpanRows(body);
  if (sRows.length) {
    try { await ensureSpanSchema(); }
    catch (err) { console.error("span schema ensure failed (telemetry unaffected):", err); }
    // Same batching as events, and for the same reason — this is the feed that actually
    // deadlocked. After the 2026-08-20 outage the Pi had ~13k span samples queued; at one
    // round-trip per row a 500-row push could not finish inside its 10s timeout, so the
    // cursor never advanced and the backlog was permanently stuck.
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
    await sql`DELETE FROM span_readings WHERE ts < ${ts - 90 * 86400}`;
  }

  // Backup-element ARM feed: shadow/live decision events + current relay/intent snapshot. Returns
  // span_arm_desired (the owner's portal toggle) so the bridge applies it. Same batch-safe pattern
  // as events and span: one UNNEST round-trip, per-row fallback so a bad row is skipped, not
  // retried. (This feed used to insert one row per round-trip — the very pattern blamed above.)
  let spanArmStored = 0;
  let spanArmDesired: boolean | null = null;
  try {
    await ensureSpanArmSchema();
    const aRows = parseSpanArmEvents(body);
    if (aRows.length) {
      try {
        await query(
          `INSERT INTO span_arm_events (source_id, ts, circuit_id, relay_state, armed, live, action, detail)
           SELECT * FROM UNNEST($1::bigint[], $2::double precision[], $3::text[], $4::text[],
                                $5::boolean[], $6::boolean[], $7::text[], $8::text[])
           ON CONFLICT (source_id) DO NOTHING`,
          [aRows.map((r) => r.sourceId), aRows.map((r) => r.eTs), aRows.map((r) => r.circuitId),
           aRows.map((r) => r.relayState), aRows.map((r) => r.armed), aRows.map((r) => r.live),
           aRows.map((r) => r.action), aRows.map((r) => r.detail)],
        );
        spanArmStored = aRows.length;
      } catch (err) {
        console.error("span_arm batch insert failed, falling back to per-row:", err);
        for (const r of aRows) {
          try {
            await sql`INSERT INTO span_arm_events (source_id, ts, circuit_id, relay_state, armed, live, action, detail)
              VALUES (${r.sourceId}, ${r.eTs}, ${r.circuitId}, ${r.relayState}, ${r.armed},
                      ${r.live}, ${r.action}, ${r.detail})
              ON CONFLICT (source_id) DO NOTHING`;
            spanArmStored++;
          } catch (e2) { console.error("span_arm event skipped:", e2); }
        }
      }
    }
    const st = (body as { span_arm?: Record<string, unknown> | null } | null)?.span_arm;
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
    const sys = parseSystem(body);
    if (sys) {
      await ensureSystemSchema();
      await sql`INSERT INTO system_stats
        (ts, cpu_pct, load1, load5, load15, ncpu, mem_used_pct, mem_total_mb, mem_avail_mb,
         disk_used_pct, disk_free_gb, disk_total_gb, cpu_temp_c, uptime_s)
        VALUES (${sys.ts}, ${sys.cpuPct}, ${sys.load1},
                ${sys.load5}, ${sys.load15}, ${sys.ncpu},
                ${sys.memUsedPct}, ${sys.memTotalMb}, ${sys.memAvailMb},
                ${sys.diskUsedPct}, ${sys.diskFreeGb}, ${sys.diskTotalGb},
                ${sys.cpuTempC}, ${sys.uptimeS})
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
