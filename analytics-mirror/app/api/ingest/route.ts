import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { ensureSchema, ensureEventsSchema, ensureSpanSchema } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    // Per-event guard: the Pi advances its cursor on our 2xx, so a batch-level failure would
    // silently lose the whole batch. Skip a bad row, keep the rest.
    for (const e of events.slice(0, 500)) {
      try {
        const pumpId = e?.pump_id;
        const evTs = Number(e?.ts);
        if (!pumpId || !evTs) continue; // pump_id + ts are NOT NULL / meaningful
        const sourceId = e?.source_id == null ? null : Number(e.source_id);
        const detail =
          e?.detail == null ? null
          : typeof e.detail === "string" ? e.detail
          : JSON.stringify(e.detail);
        await sql`INSERT INTO pump_events
          (pump_id, source_id, ts, type, code, severity, message, detail)
          VALUES (${String(pumpId)}, ${sourceId}, ${evTs}, ${e?.type ?? null},
                  ${e?.code ?? null}, ${e?.severity ?? null}, ${e?.message ?? null},
                  ${detail}::jsonb)
          ON CONFLICT (pump_id, source_id) DO NOTHING`;
        eventsStored++;
      } catch (err) {
        console.error("event ingest row skipped:", err);
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
    for (const s of spanRows.slice(0, 1000)) {
      try {
        const sTs = Number(s?.ts);
        const name = s?.name;
        if (!sTs || !name) continue;
        const sourceId = s?.source_id == null ? null : Number(s.source_id);
        await sql`INSERT INTO span_readings (source_id, ts, circuit_id, name, power_w)
          VALUES (${sourceId}, ${sTs}, ${s?.circuit_id ?? null}, ${String(name)}, ${s?.power_w ?? null})
          ON CONFLICT (source_id) DO NOTHING`;
        spanStored++;
      } catch (err) {
        console.error("span ingest row skipped:", err);
      }
    }
    await sql`DELETE FROM span_readings WHERE ts < ${ts - 90 * 86400}`;
  }

  return NextResponse.json({ ok: true, stored: pumps.length, events: eventsStored, span: spanStored });
}
