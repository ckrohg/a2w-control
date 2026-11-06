/**
 * @purpose #190 — the planner's READ-ONLY status for the 6bb home app's Heating card. PLANNER_READ_TOKEN is accepted on
 * exactly one route, GET /api/status, which reports the backup call, the failsafe lease, the thermal and storm blocks and
 * whether the outage feed answers. It has no side effects and returns no secrets. Unset = the route is 404 for everyone;
 * a token equal to another planner secret disables the route with a logged error — never an exit, because this process
 * controls the house. Pure (no server, no env reads) so readstatus.test.ts covers every branch; index.ts wires it.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Supply } from "./generator";

/** Constant-time compare (as hub/src/auth.ts): hashing first means no length leak and no throw. "" never matches. */
export function constantTimeEqual(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface ReadGate {
  /** false: GET /api/status answers 404 to everyone */
  enabled: boolean;
  token: string;
  /** set when the token was refused at startup (logged by index.ts) */
  error: string | null;
}

/** Decide once at startup. `others` are the planner's other secrets by env name; a clash disables the route. Both sides
 *  are trimmed first: a pasted trailing newline must neither hide a clash nor lock out the bearer (extractBearer trims). */
export function readGate(readToken: string | undefined, others: Record<string, string | undefined>): ReadGate {
  const token = (readToken ?? "").trim();
  if (!token) return { enabled: false, token: "", error: null };
  for (const [name, value] of Object.entries(others)) {
    if (value && constantTimeEqual(token, value.trim())) {
      return { enabled: false, token: "", error: `PLANNER_READ_TOKEN equals ${name} — the read-only app would hold that secret. `
        + "GET /api/status is DISABLED until it is set to a different value (openssl rand -hex 32); everything else runs normally." };
    }
  }
  return { enabled: true, token, error: null };
}

/** The bearer from an Authorization header, or "" (an empty bearer never authorizes). */
export function extractBearer(header: string | undefined): string {
  const m = /^Bearer\s+(.+)$/i.exec((header ?? "").trim());
  return m ? m[1].trim() : "";
}

export function readAuthorized(gate: ReadGate, header: string | undefined): boolean {
  if (!gate.enabled) return false;
  const got = extractBearer(header);
  return got !== "" && constantTimeEqual(got, gate.token);
}

export interface ReadStatus {
  /** called = the HBX's own backup-element call at the last poll; kWh = SPAN cloud, the element circuit, trailing 60 min */
  backup: { called: boolean | null; spanBufferTankKwhLastHour: number | null };
  /** armed = the Pi shows a live revert lease on EVERY configured pump (null = Phase B off / not seen yet); leaseUntil =
   *  the earliest expiry across them, null if any pump has none */
  failsafe: { armed: boolean | null; leaseUntil: string | null };
  thermal: Record<string, unknown>;
  storm: Record<string, unknown>;
  outageSignal: "ok" | "unavailable";
}

export interface ReadStatusInput {
  backupCalled: boolean | null;
  backupKwhLastHour: number | null;
  /** null = Phase B disabled. pumpIds = the configured pumps: leaseUntilS only holds the ones a verify has seen */
  phaseB: { pumpIds: string[]; lastResults: Record<string, string>; leaseUntilS: Record<string, number | null> } | null;
  thermal: Record<string, unknown>;
  storm: Record<string, unknown>;
  /** generator.ts OutageFeed.supply(): "unknown", or an `assumed` grid, = the feed has not answered recently */
  outageSupply: { supply: Supply; assumed: boolean };
  nowMs: number;
}

export function buildReadStatus(i: ReadStatusInput): ReadStatus {
  // the same predicate as /api/readiness's failsafe element, so the two never disagree
  const noLease = Object.values(i.phaseB?.lastResults ?? {}).some((v) => /NO LEASE ARMED/.test(String(v)));
  const leases = (i.phaseB?.pumpIds ?? []).map((id) => i.phaseB?.leaseUntilS[id]);
  const live = leases.filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  const earliest = live.length > 0 && live.length === leases.length ? Math.min(...live) : null;
  // true = a live lease on every configured pump; false = any pump has none or an expired one (one unarmed pump is not a
  // failsafe); null = Phase B off or no pump seen yet
  const armed = !i.phaseB ? null : noLease ? false : leases.every((s) => s === undefined) ? null
    : earliest != null && earliest * 1000 > i.nowMs;
  return {
    backup: { called: i.backupCalled, spanBufferTankKwhLastHour: i.backupKwhLastHour },
    failsafe: { armed, leaseUntil: earliest == null ? null : new Date(earliest * 1000).toISOString() },
    thermal: i.thermal,
    storm: i.storm,
    outageSignal: i.outageSupply.supply === "unknown" || i.outageSupply.assumed ? "unavailable" : "ok",
  };
}

/**
 * The whole route: null when `url` is not /api/status OR the gate is off — the caller carries on to its usual 404, so an
 * unset token answers exactly as before the route existed — else the answer. `build` runs only for an authorized
 * GET/HEAD. PLANNER_API_TOKEN does NOT open this route and the read token opens nothing else.
 */
export function routeReadStatus(gate: ReadGate, method: string | undefined, url: string | undefined,
                                authorization: string | undefined, build: () => ReadStatus): { status: number; body: unknown } | null {
  if ((url ?? "").split("?")[0] !== "/api/status") return null;
  if (!gate.enabled) return null;
  if (!readAuthorized(gate, authorization)) return { status: 401, body: { error: "unauthorized" } };
  if (method !== "GET" && method !== "HEAD") return { status: 405, body: { error: "method not allowed" } };
  return { status: 200, body: build() };
}
