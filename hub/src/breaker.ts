/**
 * @purpose Pure pieces of the hub's POST /api/breaker relay (remote SPAN breaker control, owner
 * decision 2026-10-18): body validation, the ack deadline, and whether the connected bridge
 * can take the command at all. Kept out of index.ts (which starts a server on import) so the
 * rules have unit tests; the auth + relay wiring is covered by breaker.e2e.test.ts.
 *
 * The bridge enforces every safety rule itself (allowlist, 60 s floor, CLOSE in a finally,
 * global lock, never two heat pumps off, read-back). The hub only refuses what it can see is
 * malformed, so a bad request never reaches the house.
 */

export const BREAKER_ACTIONS = ["power_cycle", "close", "open"] as const;
export type BreakerAction = (typeof BREAKER_ACTIONS)[number];

/** Owner decision 2026-10-18: the minimum off time for any toggle-off is 60 s. The bridge's
 *  config can raise it, never lower it; the hub mirrors the floor so the deadline math holds. */
export const MIN_OFF_S = 60;
export const MAX_OFF_S = 600;

export interface BreakerCommand {
  circuit: string;
  op: BreakerAction;
  off_s: number;
  /** audit label the bridge records ("hub:<source>"): the dashboard by default, "backup-gate" for the planner's live
   *  backup-element gate. A label, not a permission — every caller needs the client bearer AND the arm token. */
  source: string;
}

export const DEFAULT_BREAKER_SOURCE = "armed-dashboard";
const SOURCE_RE = /^[a-z][a-z0-9-]{0,31}$/;

export type Validated = { ok: true; cmd: BreakerCommand } | { ok: false; detail: string };

export function validateBreakerBody(body: unknown): Validated {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.circuit !== "string" || b.circuit.trim().length === 0 || b.circuit.length > 80) {
    return { ok: false, detail: "circuit is required (string, ≤ 80 chars)" };
  }
  if (typeof b.action !== "string" || !(BREAKER_ACTIONS as readonly string[]).includes(b.action)) {
    return { ok: false, detail: `action must be one of ${BREAKER_ACTIONS.join(" | ")}` };
  }
  let offS = MIN_OFF_S;
  if (b.off_s !== undefined && b.off_s !== null) {
    if (typeof b.off_s !== "number" || !Number.isFinite(b.off_s)) {
      return { ok: false, detail: "off_s must be a number when provided" };
    }
    if (b.off_s < MIN_OFF_S || b.off_s > MAX_OFF_S) {
      return { ok: false, detail: `off_s must be within [${MIN_OFF_S}, ${MAX_OFF_S}] seconds` };
    }
    offS = b.off_s;
  }
  let source = DEFAULT_BREAKER_SOURCE;
  if (b.source !== undefined && b.source !== null) {
    if (typeof b.source !== "string" || !SOURCE_RE.test(b.source)) {
      return { ok: false, detail: "source must be a short lowercase label ([a-z][a-z0-9-]{0,31}) when provided" };
    }
    source = b.source;
  }
  return { ok: true, cmd: { circuit: b.circuit.trim(), op: b.action as BreakerAction, off_s: offS, source } };
}

/** How long to wait for the Pi's ack: a power cycle holds off_s before it can answer. */
export function breakerAckTimeoutMs(cmd: BreakerCommand, graceMs: number): number {
  return (cmd.op === "power_cycle" ? cmd.off_s * 1000 : 0) + graceMs;
}

/** A bridge that predates breaker control never acks the action (it ignores unknown actions
 *  by design), which would leave the dashboard waiting a full minute and a half for nothing.
 *  New bridges advertise `capabilities: ["breaker"]` in every state frame. */
export function bridgeSupportsBreaker(lastState: { capabilities?: unknown } | null): boolean {
  return !!lastState && Array.isArray(lastState.capabilities) && lastState.capabilities.includes("breaker");
}

/** Env-overridable grace (tests use a short one); malformed values fall back to the default. */
export function parseGraceMs(raw: string | undefined, fallback = 30_000): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 100 && n <= 600_000 ? n : fallback;
}
