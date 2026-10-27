/**
 * @purpose Pure, tested parsing for the Pi's /api/ingest push. Every field the route stores
 * is validated and normalised here, with no I/O, so app/api/ingest/route.ts is only SQL.
 *
 * Why the row-level filtering matters: ingest is the Pi's ONLY telemetry path into the
 * mirror, and the exporter advances its cursor only on a 2xx. A single row that throws
 * inside an INSERT turns the whole push into a 500, the cursor never moves, and the same
 * batch is retried forever (the 2026-08-20 backlog was exactly this shape). So anything
 * that cannot be stored is dropped HERE, and its siblings still go in.
 *
 * Caps (500 events, 1000 span rows, 500 arm events) bound one push to what fits inside
 * the Pi's 10 s client timeout; the exporter sends the rest on the next cycle.
 */

export type PumpRow = {
  id: string; name: string | null; online: boolean; state: string | null;
  modeKind: string | null; setpointC: number | null; inletC: number | null;
  outletC: number | null; ambientC: number | null; powerW: number | null;
  activeFaults: number | null; errorRate: number | null;
  /** JSON text of the pump's full cached snapshot, or null when none was attached. */
  full: string | null;
};

export type EventRow = {
  pumpId: string; sourceId: number | null; evTs: number;
  type: string | null; code: string | null; severity: string | null;
  message: string | null;
  /** JSON text (strings pass through untouched — they are stored as jsonb). */
  detail: string | null;
};

export type SpanRow = {
  sourceId: number | null; sTs: number; circuitId: string | null;
  name: string; powerW: number | null;
};

export type SpanArmEventRow = {
  sourceId: number | null; eTs: number; circuitId: string | null; relayState: string | null;
  armed: boolean; live: boolean; action: string | null; detail: string | null;
};

export type SystemRow = {
  ts: number; cpuPct: number | null; load1: number | null; load5: number | null;
  load15: number | null; ncpu: number | null; memUsedPct: number | null;
  memTotalMb: number | null; memAvailMb: number | null; diskUsedPct: number | null;
  diskFreeGb: number | null; diskTotalGb: number | null; cpuTempC: number | null;
  uptimeS: number | null;
};

export const EVENTS_CAP = 500;
export const SPAN_CAP = 1000;
export const SPAN_ARM_EVENTS_CAP = 500;

/** A positive, finite epoch-seconds timestamp from a number or numeric string; else null. */
function tsOf(v: unknown): number | null {
  if (typeof v !== "number" && typeof v !== "string") return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** A finite number from a number or numeric string; null for absent or unparseable. */
function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Text the way node-postgres would have sent it: strings as-is, objects as JSON, else String(). */
function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** A non-empty id from a string or finite number (pump_id / event pump_id are TEXT NOT NULL). */
function idOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The snapshot timestamp every readings row is stamped with; null means "empty snapshot". */
export function parseSnapshotTs(body: unknown): number | null {
  const b = obj(body);
  return b ? tsOf(b.ts) : null;
}

/**
 * The pumps in a snapshot. An entry with no string/number id is DROPPED — readings.pump_id is
 * NOT NULL, so it could never be stored, and until now it threw inside the INSERT and turned
 * the whole push into a retried-forever 500. Its siblings are kept.
 */
export function parsePumps(body: unknown): PumpRow[] {
  const b = obj(body);
  return arr(b?.pumps).flatMap((raw): PumpRow[] => {
    const p = obj(raw);
    const id = p ? idOf(p.id) : null;
    if (!p || id === null) return [];
    const full = obj(p.full);
    return [{
      id,
      name: text(p.name),
      online: !!p.online,
      state: text(p.state),
      modeKind: text(p.mode_kind),
      setpointC: num(p.setpoint_c),
      inletC: num(p.inlet_c),
      outletC: num(p.outlet_c),
      ambientC: num(p.ambient_c),
      powerW: num(p.power_w),
      activeFaults: num(p.active_faults),
      errorRate: num(p.error_rate),
      full: full ? JSON.stringify(full) : null,
    }];
  });
}

/** Events feed: first 500, each needs a pump_id and a numeric ts; detail is JSON text or null. */
export function parseEvents(body: unknown): EventRow[] {
  const b = obj(body);
  return arr(b?.events).slice(0, EVENTS_CAP).flatMap((raw): EventRow[] => {
    const e = obj(raw);
    const pumpId = e ? idOf(e.pump_id) : null;
    const evTs = e ? tsOf(e.ts) : null;
    if (!e || pumpId === null || evTs === null) return [];
    return [{
      pumpId,
      sourceId: num(e.source_id),
      evTs,
      type: text(e.type),
      code: text(e.code),
      severity: text(e.severity),
      message: text(e.message),
      detail: e.detail == null ? null
        : typeof e.detail === "string" ? e.detail
        : JSON.stringify(e.detail),
    }];
  });
}

/** SPAN circuit-power feed: first 1000, each needs a numeric ts and a name. */
export function parseSpanRows(body: unknown): SpanRow[] {
  const b = obj(body);
  return arr(b?.span).slice(0, SPAN_CAP).flatMap((raw): SpanRow[] => {
    const s = obj(raw);
    const sTs = s ? tsOf(s.ts) : null;
    const name = s ? text(s.name) : null;
    if (!s || sTs === null || !name) return [];
    return [{
      sourceId: num(s.source_id),
      sTs,
      circuitId: text(s.circuit_id),
      name,
      powerW: num(s.power_w),
    }];
  });
}

/** Backup-element ARM decision events: first 500, each needs a numeric ts; armed/live as booleans. */
export function parseSpanArmEvents(body: unknown): SpanArmEventRow[] {
  const b = obj(body);
  return arr(b?.span_arm_events).slice(0, SPAN_ARM_EVENTS_CAP).flatMap((raw): SpanArmEventRow[] => {
    const e = obj(raw);
    const eTs = e ? tsOf(e.ts) : null;
    if (!e || eTs === null) return [];
    return [{
      sourceId: num(e.source_id),
      eTs,
      circuitId: text(e.circuit_id),
      relayState: text(e.relay_state),
      armed: !!e.armed,
      live: !!e.live,
      action: text(e.action),
      detail: text(e.detail),
    }];
  });
}

/** Pi system health: null unless `system` is an object with a numeric ts. */
export function parseSystem(body: unknown): SystemRow | null {
  const b = obj(body);
  const sys = obj(b?.system);
  const ts = sys ? tsOf(sys.ts) : null;
  if (!sys || ts === null) return null;
  return {
    ts,
    cpuPct: num(sys.cpu_pct), load1: num(sys.load1), load5: num(sys.load5), load15: num(sys.load15),
    ncpu: num(sys.ncpu), memUsedPct: num(sys.mem_used_pct), memTotalMb: num(sys.mem_total_mb),
    memAvailMb: num(sys.mem_avail_mb), diskUsedPct: num(sys.disk_used_pct),
    diskFreeGb: num(sys.disk_free_gb), diskTotalGb: num(sys.disk_total_gb),
    cpuTempC: num(sys.cpu_temp_c), uptimeS: num(sys.uptime_s),
  };
}
