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
