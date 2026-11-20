// @purpose The ONE relay behind every planner write proxy under app/api/planner/ (boost, autonomy,
// identification, sanitize, restore, target, storm POST). Each route keeps its own isAuthed() gate and
// any route-specific shaping, then hands the path + body here. This file owns: the PLANNER_URL /
// PLANNER_API_TOKEN gate (503), trailing-slash trimming, the bearer header (the token never reaches the
// browser), no-store, JSON parsing that tolerates a non-JSON upstream body, the 502 for a failed
// connection, and — new with this file — a timeout that answers 504 instead of letting a stalled planner
// hold the Vercel function until the platform kills it (the dashboard then saw a platform error page,
// not JSON, and every control button hung together). Returns a plain { status, body } so routes stay
// testable without Next; they wrap it in NextResponse.json. The planner /health GET readers live in
// lib/planner-health.ts and are deliberately NOT routed through here.

/**
 * Default per-request budget for a planner write: 25 s.
 * Every route that relays through here exports `maxDuration = 30`, so the platform never cuts the function off
 * before this timer answers (the project already raises maxDuration elsewhere: ingest 60, hub/breaker 120).
 * 25 s covers a slow-but-successful target write (SensorLinx PATCH plus read-back, each bounded at 30 s
 * planner-side, normally a few seconds), which an 8 s budget would have reported as "timed out" although it
 * landed. A 504 means "no answer in time", NOT "the write did not happen": the planner keeps processing it,
 * so the client should re-read status rather than blindly retry. Pass `timeoutMs` to override per call; keep
 * it below the route's maxDuration.
 */
export const DEFAULT_PLANNER_TIMEOUT_MS = 25_000;

export type PlannerProxyInit = { method: "GET" | "POST"; body?: string };

export type PlannerProxyDeps = {
  /** fetch to use (tests stub it); defaults to the global fetch at call time. */
  fetchImpl?: typeof fetch;
  /** Where PLANNER_URL / PLANNER_API_TOKEN are read from; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Budget for the whole round trip (connect + headers + body); defaults to DEFAULT_PLANNER_TIMEOUT_MS. */
  timeoutMs?: number;
};

export type PlannerProxyResult = { status: number; body: unknown };

const NOT_CONFIGURED: PlannerProxyResult = { status: 503, body: { error: "planner not configured" } };

/** Marker for our own timer firing, so the catch can tell a timeout from a connection failure. */
class PlannerTimeout extends Error {
  constructor(ms: number) { super(`planner gave no answer in ${ms} ms`); this.name = "PlannerTimeout"; }
}

/**
 * POST (or GET) `path` on the planner with the bearer token and return the planner's status + parsed body.
 * - env missing → 503 { error: "planner not configured" }, fetch never called
 * - planner answered → its status passed through (202 arming, 400/409/422/501 refusals, …); a body that is not
 *   JSON becomes {} with the upstream status kept
 * - no answer within timeoutMs → 504 { error: "planner timed out" } (the request is aborted; see the note on
 *   DEFAULT_PLANNER_TIMEOUT_MS — the planner may still complete the write)
 * - fetch threw for any other reason (DNS, refused, reset) → 502 { error: "planner unreachable", detail }
 * `Content-Type: application/json` is sent only when a body is given, as the routes always did.
 */
export async function forwardToPlanner(
  path: string,
  init: PlannerProxyInit,
  deps: PlannerProxyDeps = {},
): Promise<PlannerProxyResult> {
  const env = deps.env ?? process.env;
  const base = env.PLANNER_URL;
  const token = env.PLANNER_API_TOKEN;
  if (!base || !token) return NOT_CONFIGURED;

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS;
  const url = `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;

  // Our own timer rather than AbortSignal.timeout alone: the signal still goes to fetch so a real
  // connection is torn down, but the race is what guarantees a 504 even if the fetch never settles.
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ctl.abort(); reject(new PlannerTimeout(timeoutMs)); }, timeoutMs);
  });

  try {
    const res = await Promise.race([
      fetchImpl(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body,
        cache: "no-store",
        signal: ctl.signal,
      }),
      timedOut,
    ]);
    // The body read shares the budget: a planner that sent headers then stalled is still a timeout.
    const body = await Promise.race([res.json().catch(() => ({})), timedOut]);
    if (ctl.signal.aborted) throw new PlannerTimeout(timeoutMs);
    return { status: res.status, body };
  } catch (e) {
    if (e instanceof PlannerTimeout || ctl.signal.aborted) {
      return { status: 504, body: { error: "planner timed out", detail: "no answer in time; the write may still have landed, so re-check status before retrying" } };
    }
    return { status: 502, body: { error: "planner unreachable", detail: String(e) } };
  } finally {
    clearTimeout(timer);
  }
}
