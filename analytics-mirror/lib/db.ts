import { sql } from "@vercel/postgres";

// One reading row per pump per push. The Pi sends a snapshot every ~60s; the time series
// accumulates here. Idempotent create — cheap to call before an insert.
export async function ensureSchema() {
  await sql`CREATE TABLE IF NOT EXISTS readings (
    id BIGSERIAL PRIMARY KEY,
    ts DOUBLE PRECISION NOT NULL,
    pump_id TEXT NOT NULL,
    name TEXT,
    online BOOLEAN,
    state TEXT,
    mode_kind TEXT,
    setpoint_c REAL,
    inlet_c REAL,
    outlet_c REAL,
    ambient_c REAL,
    power_w REAL,
    active_faults INT,
    error_rate REAL
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_readings_pump_ts ON readings (pump_id, ts)`;
  // Latest-only full snapshot per pump (parameters, per-stage details, status/switch
  // words) — attached by the Pi every ~5 min; feeds the Advanced view + register baseline.
  await sql`CREATE TABLE IF NOT EXISTS pump_snapshots (
    pump_id TEXT PRIMARY KEY,
    ts DOUBLE PRECISION NOT NULL,
    name TEXT,
    snapshot JSONB NOT NULL
  )`;
}

export type Reading = {
  ts: number; pump_id: string; name: string | null; online: boolean;
  state: string | null; mode_kind: string | null; setpoint_c: number | null;
  inlet_c: number | null; outlet_c: number | null; ambient_c: number | null;
  power_w: number | null; active_faults: number | null; error_rate: number | null;
};

export async function recentReadings(hours: number): Promise<Reading[]> {
  const since = Date.now() / 1000 - hours * 3600;
  const { rows } = await sql<Reading>`
    SELECT ts, pump_id, name, online, state, mode_kind, setpoint_c, inlet_c, outlet_c,
           ambient_c, power_w, active_faults, error_rate
    FROM readings WHERE ts >= ${since} ORDER BY ts ASC`;
  return rows;
}

// Cloud mirror of the Pi's local `events` table (bridge/store.py): faults on/off, write
// audit rows, comm events, and state/runtime edges. The Pi ships new events on each push
// (bridge/exporter.py) keyed by source_id = the Pi's own event id, so re-sends are idempotent.
export async function ensureEventsSchema() {
  await sql`CREATE TABLE IF NOT EXISTS pump_events (
    id BIGSERIAL PRIMARY KEY,
    pump_id TEXT NOT NULL,
    source_id BIGINT,
    ts DOUBLE PRECISION NOT NULL,
    type TEXT,
    code TEXT,
    severity TEXT,
    message TEXT,
    detail JSONB,
    UNIQUE(pump_id, source_id)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_pump_events_ts ON pump_events (ts DESC)`;
}

export type Event = {
  id: number; pump_id: string; source_id: number | null; ts: number;
  type: string | null; code: string | null; severity: string | null;
  message: string | null; detail: unknown;
};

export type EventFilter = "all" | "faults" | "writes" | "runtime";

// Mirrors the Pi UI's All/Faults/Writes/Runtime tabs. faults = fault edges; writes = the
// *_write audit rows; runtime = state/runtime edges (compressor cycles, defrost, elec-heat).
export async function recentEvents({ filter, limit }: { filter: EventFilter; limit: number }): Promise<Event[]> {
  let rows: Event[];
  if (filter === "faults") {
    ({ rows } = await sql<Event>`
      SELECT id, pump_id, source_id, ts, type, code, severity, message, detail FROM pump_events
      WHERE type IN ('fault_on','fault_off') ORDER BY ts DESC LIMIT ${limit}`);
  } else if (filter === "writes") {
    ({ rows } = await sql<Event>`
      SELECT id, pump_id, source_id, ts, type, code, severity, message, detail FROM pump_events
      WHERE type LIKE '%\\_write' ORDER BY ts DESC LIMIT ${limit}`);
  } else if (filter === "runtime") {
    ({ rows } = await sql<Event>`
      SELECT id, pump_id, source_id, ts, type, code, severity, message, detail FROM pump_events
      WHERE type = 'state' ORDER BY ts DESC LIMIT ${limit}`);
  } else {
    ({ rows } = await sql<Event>`
      SELECT id, pump_id, source_id, ts, type, code, severity, message, detail FROM pump_events
      ORDER BY ts DESC LIMIT ${limit}`);
  }
  return rows;
}
