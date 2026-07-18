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

// Cloud mirror of the Pi's local `span_samples` (bridge/store.py): high-res instantPowerW per
// SPAN circuit — the "Buffer Tank" backup element + the "Air-Water" heat pumps. Shipped on each
// push keyed by source_id = the Pi's span_samples.id, so re-sends are idempotent.
export async function ensureSpanSchema() {
  await sql`CREATE TABLE IF NOT EXISTS span_readings (
    id BIGSERIAL PRIMARY KEY,
    source_id BIGINT UNIQUE,
    ts DOUBLE PRECISION NOT NULL,
    circuit_id TEXT,
    name TEXT NOT NULL,
    power_w REAL
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_span_readings_name_ts ON span_readings (name, ts)`;
}

export type SpanReading = { ts: number; circuit_id: string | null; name: string; power_w: number | null };

export async function recentSpanReadings(hours: number, name?: string): Promise<SpanReading[]> {
  const since = Date.now() / 1000 - hours * 3600;
  const { rows } = name
    ? await sql<SpanReading>`SELECT ts, circuit_id, name, power_w FROM span_readings
        WHERE ts >= ${since} AND name = ${name} ORDER BY ts ASC`
    : await sql<SpanReading>`SELECT ts, circuit_id, name, power_w FROM span_readings
        WHERE ts >= ${since} ORDER BY ts ASC`;
  return rows;
}

// Backup-element ARM (spec: knowledge/reference/span-backup-arm-spec.md). span_arm_events = the
// shadow/live decision stream (idempotent on source_id); span_arm_state = single-row current relay+
// intent snapshot + the owner's desired_armed (the portal toggle writes it; the ingest echoes it to
// the bridge). Phase 1 is SHADOW — nothing on SPAN is toggled.
export async function ensureSpanArmSchema() {
  await sql`CREATE TABLE IF NOT EXISTS span_arm_events (
    id BIGSERIAL PRIMARY KEY, source_id BIGINT UNIQUE, ts DOUBLE PRECISION NOT NULL,
    circuit_id TEXT, relay_state TEXT, armed BOOLEAN, live BOOLEAN, action TEXT, detail TEXT
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_span_arm_events_ts ON span_arm_events (ts DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS span_arm_state (
    id INT PRIMARY KEY DEFAULT 1, ts DOUBLE PRECISION, circuit TEXT, relay_state TEXT,
    controllable BOOLEAN, armed BOOLEAN, live BOOLEAN, desired_armed BOOLEAN,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
}
export type SpanArmEvent = { ts: number; relay_state: string | null; armed: boolean; live: boolean; action: string; detail: string | null };
export async function recentSpanArmEvents(hours: number, limit = 100): Promise<SpanArmEvent[]> {
  const since = Date.now() / 1000 - hours * 3600;
  const { rows } = await sql<SpanArmEvent>`SELECT ts, relay_state, armed, live, action, detail
    FROM span_arm_events WHERE ts >= ${since} ORDER BY ts DESC LIMIT ${limit}`;
  return rows;
}
export type SpanArmState = { ts: number | null; circuit: string | null; relay_state: string | null; controllable: boolean | null; armed: boolean | null; live: boolean | null; desired_armed: boolean | null };
export async function getSpanArmState(): Promise<SpanArmState | null> {
  const { rows } = await sql<SpanArmState>`SELECT ts, circuit, relay_state, controllable, armed, live, desired_armed
    FROM span_arm_state WHERE id = 1`;
  return rows[0] ?? null;
}
export async function setSpanArmDesired(desired: boolean): Promise<void> {
  await ensureSpanArmSchema();
  await sql`INSERT INTO span_arm_state (id, desired_armed, updated_at) VALUES (1, ${desired}, now())
    ON CONFLICT (id) DO UPDATE SET desired_armed = ${desired}, updated_at = now()`;
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

// Pi system-health mirror (bridge/sysstat.py → exporter): CPU%, load, RAM, disk-on-DB-volume,
// SoC temp, uptime. The Pi attaches its latest row each push; we keep the time series here for
// the Advanced-page "Pi health" card. Latest-per-push upsert (id=ts) keeps it append-only-ish.
export async function ensureSystemSchema() {
  await sql`CREATE TABLE IF NOT EXISTS system_stats (
    ts DOUBLE PRECISION PRIMARY KEY,
    cpu_pct REAL, load1 REAL, load5 REAL, load15 REAL, ncpu INT,
    mem_used_pct REAL, mem_total_mb INT, mem_avail_mb INT,
    disk_used_pct REAL, disk_free_gb REAL, disk_total_gb REAL,
    cpu_temp_c REAL, uptime_s REAL
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_system_stats_ts ON system_stats (ts DESC)`;
}

export type SystemStat = {
  ts: number; cpu_pct: number | null; load1: number | null; load5: number | null;
  load15: number | null; ncpu: number | null; mem_used_pct: number | null;
  mem_total_mb: number | null; mem_avail_mb: number | null; disk_used_pct: number | null;
  disk_free_gb: number | null; disk_total_gb: number | null; cpu_temp_c: number | null;
  uptime_s: number | null;
};

export async function latestSystemStat(): Promise<SystemStat | null> {
  const { rows } = await sql<SystemStat>`
    SELECT ts, cpu_pct, load1, load5, load15, ncpu, mem_used_pct, mem_total_mb,
           mem_avail_mb, disk_used_pct, disk_free_gb, disk_total_gb, cpu_temp_c, uptime_s
    FROM system_stats ORDER BY ts DESC LIMIT 1`;
  return rows[0] ?? null;
}

export async function recentSystemStats(hours: number): Promise<SystemStat[]> {
  const since = Date.now() / 1000 - hours * 3600;
  const { rows } = await sql<SystemStat>`
    SELECT ts, cpu_pct, load1, load5, load15, ncpu, mem_used_pct, mem_total_mb,
           mem_avail_mb, disk_used_pct, disk_free_gb, disk_total_gb, cpu_temp_c, uptime_s
    FROM system_stats WHERE ts >= ${since} ORDER BY ts ASC`;
  return rows;
}
