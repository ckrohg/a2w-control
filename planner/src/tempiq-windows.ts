/**
 * @purpose a2w#137 — our half of gtm#1596 / gtm#1616 Part C: tell TempIQ WHEN we were driving the
 * buffer, so its passive learners quarantine those hours instead of fitting our perturbation as the
 * house behaving. (U4 fitted the as-found tank temperature back as a zone "requirement" from exactly
 * this kind of contaminated data — TempIQv2#2043.) Posts to POST /api/insights/experiment-windows.
 *
 * GRAIN: one window per commanded-target EPISODE, not one per PATCH. An episode opens at an accepted
 * `set_target` (autopilot, dashboard, boost — every path funnels through writes.ts) and closes at the
 * next event that replaces the curve: our next accepted set_target or restore, or a FOREIGN dbt/mbt
 * write seen by the drift detector (an hbx_config_versions row without `_source`). Between those
 * events the device holds OUR curve — including through a planner outage — so an open window is
 * correctly still active (TempIQ treats endedAt:null as "until now"; a crashed writer fails safe).
 * That is why an outage is NOT a "not driving" gap here: the curve does not revert when the planner
 * dies. It reverts when someone restores it, and that is a row we see.
 *
 * QUARANTINE-ONLY. Every window here carries assignment:null. None of these writes is a randomised
 * probe — the autopilot raises the target because zones are calling, so "commanded" is not
 * "exogenous" (codex critical #1 on TempIQv2#2043). The identification arm (kind awt_identification
 * with a drawn assignment) is a separate driver behind gtm#1616 Parts A/B; sending it through this
 * path without a real draw would be refused server-side (identification_requires_assignment).
 *
 * KIND = what a learner must treat differently (a 140 °F soak is not a demand-following raise):
 *   autopilot → sanitize | storm | bank | autopilot   (from the plan reason that produced the write)
 *   dashboard → storm (inside an armed storm window — the storm-precharge cron posts /api/storm/arm
 *               and THEN /api/hbx/boost) | boost (an hbx_boosts row was created by the write) | manual
 * DOSE: commandedTargetF from the write; achievedAwtF = mean tank_f over the window; compliance = the
 * share of samples whose OPERATIVE target sits within 3 °F of the commanded one (adoption is
 * asynchronous — the device re-reads the curve at its next reheat cycle — so early samples honestly
 * count against it); outdoor band = min/max outdoor over the window; zoneIds = the calling,
 * buffer-served zones from the floor snapshot nearest the open (empty in summer: no floor proposed).
 * For a still-open window the band and stats cover what has elapsed so far; TempIQ's upsert only
 * updates endedAt / achievedAwtF / compliance on close, so the band is "conditions at open".
 *
 * IDEMPOTENT + DURABLE. TempIQ upserts on (property, externalId) and only the closing fields update,
 * so re-posting is safe. tempiq_window_posts remembers what was posted and which windows are still
 * open, so the backfill (July → now) drains in ≤500-window batches and each later tick posts only
 * new episodes and newly-closable ones. A per-window validation rejection is recorded and NOT
 * retried (it is deterministic); a transport failure is retried next tick with nothing marked.
 * Fail-soft like every TempIQ hop: never throws, never touches the control loop. Flag-gated:
 * TEMPIQ_WINDOWS_ENABLED=1 + TEMPIQ_SURFACE_TOKEN.
 *
 * Phase B is deliberately NOT posted: it drives the pump setpoint to (operative tank target + I1
 * margin), so it carries no AWT perturbation independent of the tank-target window that already
 * covers the same minutes. Posting a window per lease renewal would be noise with no new information.
 * Writes with source 'identification' are NOT posted either: the identification driver posts those
 * minutes itself as awt_identification windows with their drawn assignment (identify.ts).
 */
import { DEFAULT_OPTS } from "./shadow";

export type WindowKind = "autopilot" | "sanitize" | "storm" | "bank" | "boost" | "manual";

// TempIQ's schema allows 500 per POST, but its JSON body limit does not: the first live tick
// (2026-09-29 18:30Z) got HTTP 413 on a 500-window batch (~200 KB). 100 windows ≈ 40 KB clears
// the limit with margin; 20 batches/tick keeps the backfill at ≤2000 windows per tick.
const BATCH = 100;
const MAX_BATCHES_PER_TICK = 20;
const WASHOUT_MIN = 30;          // the buffer adoption lag — the device re-reads the curve next reheat cycle
export const WINDOW_SOURCE = "a2w-planner";

/** One accepted curve write, with the correlates the classifier needs (store.pendingCurveWrites). */
export interface PendingCurveWrite {
  id: number;
  ts: Date;
  source: string;
  action: "set_target" | "restore";
  requested: unknown;
  detail: string | null;
  /** Parsed server-side from the accepted detail ("target 128°F commanded …"); null if unparseable. */
  commandedTargetF: number | null;
  /** The next curve-replacing event (our write OR a foreign one); null = still our curve. */
  closedAt: Date | null;
  /** autopilot_log reason correlated to this target (autopilot writes only; null if none). */
  reason: string | null;
  /** A storm_events window covered the write. */
  stormActive: boolean;
  /** An hbx_boosts row was created by this write. */
  boostMatched: boolean;
}

export interface WindowStats {
  achievedAwtF: number | null;
  compliance: number | null;
  outdoorLowF: number | null;
  outdoorHighF: number | null;
  samples: number;
}

export interface WindowPost {
  writeId: number;
  externalId: string;
  kind: string;
  closedAt: Date | null;
  lastError: string | null;
}

/** The slice of Store this module needs — structural, so the assertion suite can hand it a fake. */
export interface WindowStore {
  pendingCurveWrites(limit: number): Promise<PendingCurveWrite[]>;
  windowStats(from: Date, to: Date | null, commandedTargetF: number | null): Promise<WindowStats>;
  zoneFloorSnapshotNear(ts: Date): Promise<unknown | null>;
  markWindowPosts(posts: WindowPost[]): Promise<void>;
}

export function externalIdFor(writeId: number): string {
  return `a2w-hbx-write-${writeId}`;
}

/**
 * The commanded target of an accepted set_target. The detail names it exactly ("target 128°F
 * commanded (curve 130/126 → …"); the requested curve's midpoint is the fallback and is only within
 * ±2 °F — the near-flat band is solved so its OUTPUT at the current outdoor equals the target, not
 * centred on it (writes.ts). A rejected write's `{target_f}` shape is honoured too.
 */
export function parseCommandedTargetF(detail: string | null, requested: unknown): number | null {
  const m = detail?.match(/^target (-?\d+(?:\.\d+)?)°F commanded/);
  if (m) return Number(m[1]);
  const r = requested as { dbt?: unknown; mbt?: unknown; target_f?: unknown } | null | undefined;
  if (typeof r?.target_f === "number" && Number.isFinite(r.target_f)) return r.target_f;
  if (typeof r?.dbt === "number" && typeof r?.mbt === "number" && Number.isFinite(r.dbt) && Number.isFinite(r.mbt)) {
    return Math.round((r.dbt + r.mbt) / 2);
  }
  return null;
}

export interface KindInputs {
  source: string;
  reason: string | null;
  stormActive: boolean;
  boostMatched: boolean;
  commandedTargetF: number | null;
}

export function classifyKind(w: KindInputs, strictCapF: number = DEFAULT_OPTS.strictCapF): WindowKind {
  if (w.source === "autopilot") {
    const r = w.reason ?? "";
    // Order matters: "storm mode: banking heat (…)" names both — the storm is the cause.
    if (/sanitize|pasteuriz|soak/i.test(r)) return "sanitize";
    if (/storm/i.test(r)) return "storm";
    if (/\bbank|pre-?charge/i.test(r)) return "bank";
    // autopilot_log dedups unchanged decisions, so a write can lack a correlated reason. Only the
    // sanitize soak sits above the everyday strictCap, so the target alone still separates it.
    if (w.reason === null && w.commandedTargetF !== null && w.commandedTargetF > strictCapF) return "sanitize";
    return "autopilot";
  }
  if (w.stormActive) return "storm";
  if (w.boostMatched) return "boost";
  return "manual";
}

/** Calling, buffer-served zones out of a floor snapshot's `zones` jsonb (demand.ts ZoneFloor[]). */
export function callingZoneIds(zones: unknown): string[] {
  if (!Array.isArray(zones)) return [];
  const out: string[] = [];
  for (const z of zones) {
    if (!z || typeof z !== "object") continue;
    const zz = z as { zoneId?: unknown; calling?: unknown; awtF?: unknown };
    if (typeof zz.zoneId === "string" && zz.zoneId.length > 0 && zz.calling === true && zz.awtF != null) out.push(zz.zoneId);
  }
  return out;
}

export interface WindowPayload {
  externalId: string;
  kind: WindowKind;
  startedAt: string;
  endedAt: string | null;
  zoneIds: string[];
  assignment: null;
  washoutMin: number;
  source: string;
  commandedTargetF?: number;
  achievedAwtF?: number;
  compliance?: number;
  outdoorBandLowF?: number;
  outdoorBandHighF?: number;
}

const round = (v: number, places: number): number => {
  const p = 10 ** places;
  return Math.round(v * p) / p;
};
// TempIQ's schema ranges (°F 32..212, compliance 0..1, outdoor −60..130). A value outside them would
// 400 the WHOLE batch, so an out-of-range stat is dropped from the payload rather than sent.
const inRange = (v: number | null, lo: number, hi: number): v is number =>
  v !== null && Number.isFinite(v) && v >= lo && v <= hi;

export function buildPayload(
  w: { id: number; ts: Date; closedAt: Date | null },
  kind: WindowKind,
  commandedTargetF: number | null,
  stats: WindowStats,
  zoneIds: string[],
): WindowPayload {
  const p: WindowPayload = {
    externalId: externalIdFor(w.id),
    kind,
    startedAt: w.ts.toISOString(),
    endedAt: w.closedAt ? w.closedAt.toISOString() : null,
    zoneIds,
    assignment: null,
    washoutMin: WASHOUT_MIN,
    source: WINDOW_SOURCE,
  };
  if (inRange(commandedTargetF, 32, 212)) p.commandedTargetF = commandedTargetF;
  if (inRange(stats.achievedAwtF, 32, 212)) p.achievedAwtF = round(stats.achievedAwtF, 1);
  if (inRange(stats.compliance, 0, 1)) p.compliance = round(stats.compliance, 3);
  if (inRange(stats.outdoorLowF, -60, 130)) p.outdoorBandLowF = round(stats.outdoorLowF, 1);
  if (inRange(stats.outdoorHighF, -60, 130)) p.outdoorBandHighF = round(stats.outdoorHighF, 1);
  return p;
}

export interface TempiqWindowsStatus {
  enabled: boolean;
  lastTickAt: string | null;
  lastResult: string | null;
  consecutiveFailures: number;
  openedTotal: number;
  closedTotal: number;
  rejectedTotal: number;
}

interface PostResponse {
  upserted: number;
  rejected: Array<{ externalId: string | null; reason: string }>;
}

export class TempiqWindowPoster {
  private lastTickAt: string | null = null;
  private lastResult: string | null = null;
  private consecutiveFailures = 0;
  private openedTotal = 0;
  private closedTotal = 0;
  private rejectedTotal = 0;

  constructor(
    private readonly store: WindowStore,
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  status(): TempiqWindowsStatus {
    return {
      enabled: true,
      lastTickAt: this.lastTickAt,
      lastResult: this.lastResult,
      consecutiveFailures: this.consecutiveFailures,
      openedTotal: this.openedTotal,
      closedTotal: this.closedTotal,
      rejectedTotal: this.rejectedTotal,
    };
  }

  /** One tick: post new episodes and close the ones that gained a closer. Never throws. */
  async tick(): Promise<void> {
    try {
      let opened = 0, closed = 0, rejected = 0, restores = 0, batches = 0;
      for (; batches < MAX_BATCHES_PER_TICK; batches++) {
        const pending = await this.store.pendingCurveWrites(BATCH);
        if (!pending.length) break;
        const marks: WindowPost[] = [];
        const outgoing: Array<{ payload: WindowPayload; writeId: number; kind: WindowKind; closedAt: Date | null }> = [];
        for (const w of pending) {
          if (w.action === "restore") {
            // A restore re-applies the as-found curve: it CLOSES the previous window (its ts is that
            // window's closer) and opens nothing — the plant is back on the human's curve.
            marks.push({ writeId: w.id, externalId: externalIdFor(w.id), kind: "restore", closedAt: w.ts, lastError: null });
            restores++;
            continue;
          }
          if (w.source.startsWith("identification")) {
            // A randomised probe (identify.ts) is posted by the driver itself as kind awt_identification
            // WITH its drawn assignment — the only kind U4 may fit. Filing the same minutes here as a
            // quarantine window would delete the one fittable interval. It still closes the previous
            // episode (its ts is that window's closer), so it is marked, not posted.
            marks.push({ writeId: w.id, externalId: externalIdFor(w.id), kind: "identification", closedAt: w.closedAt ?? w.ts, lastError: null });
            restores++;
            continue;
          }
          const commanded = w.commandedTargetF ?? parseCommandedTargetF(w.detail, w.requested);
          const kind = classifyKind({
            source: w.source, reason: w.reason, stormActive: w.stormActive, boostMatched: w.boostMatched, commandedTargetF: commanded,
          });
          const stats = await this.store.windowStats(w.ts, w.closedAt, commanded);
          const zoneIds = callingZoneIds(await this.store.zoneFloorSnapshotNear(w.ts));
          outgoing.push({ payload: buildPayload(w, kind, commanded, stats, zoneIds), writeId: w.id, kind, closedAt: w.closedAt });
        }
        if (outgoing.length) {
          const res = await this.post(outgoing.map((o) => o.payload));
          const rej = new Map(res.rejected.map((r) => [r.externalId, r.reason] as const));
          for (const o of outgoing) {
            const err = rej.get(o.payload.externalId) ?? null;
            if (err) {
              // Deterministic: the same payload will be refused every tick. Record it closed-with-error
              // so it leaves the pending set, and say so loudly — this is a contract drift to fix.
              console.error(`[tempiq-windows] ${o.payload.externalId} rejected by TempIQ: ${err}`);
              marks.push({ writeId: o.writeId, externalId: o.payload.externalId, kind: o.kind, closedAt: new Date(), lastError: err });
              rejected++;
            } else {
              marks.push({ writeId: o.writeId, externalId: o.payload.externalId, kind: o.kind, closedAt: o.closedAt, lastError: null });
              if (o.closedAt) closed++; else opened++;
            }
          }
        }
        await this.store.markWindowPosts(marks);
        if (pending.length < BATCH) break;
      }
      this.lastTickAt = new Date().toISOString();
      this.openedTotal += opened;
      this.closedTotal += closed;
      this.rejectedTotal += rejected;
      this.consecutiveFailures = 0;
      const moved = opened + closed + rejected + restores;
      this.lastResult = moved === 0
        ? "idle: nothing to post"
        : `opened ${opened}, closed ${closed}, rejected ${rejected}, restores ${restores}${batches > 1 ? ` (${batches} batches)` : ""}`;
      if (opened + closed + rejected > 0) console.log(`[tempiq-windows] ${this.lastResult}`);
    } catch (e) {
      this.consecutiveFailures++;
      this.lastResult = `error: ${e instanceof Error ? e.message : String(e)}`;
      // Log every failure but only loudly warn on streaks — a Vercel blip retries next tick and
      // nothing was marked posted, so no window is lost.
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % 12 === 0) {
        console.error(`[tempiq-windows] ${this.lastResult} (streak ${this.consecutiveFailures})`);
      }
    }
  }

  private async post(windows: WindowPayload[]): Promise<PostResponse> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/insights/experiment-windows`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ windows }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => null)) as { upserted?: unknown; rejected?: unknown; error?: unknown } | null;
    // 200 = upserted (possibly with per-window rejections); 400 WITH a rejected list = every window
    // refused, still a per-window verdict we can record. Anything else — 401 token, 403 scope, 5xx,
    // or a 400 with no list (our body was malformed) — is a transport/contract failure: throw so the
    // tick retries and nothing is marked posted.
    if ((res.status === 200 || res.status === 400) && body && Array.isArray(body.rejected)) {
      return {
        upserted: Number(body.upserted ?? 0),
        rejected: body.rejected as Array<{ externalId: string | null; reason: string }>,
      };
    }
    const hint = body && body.error != null ? ` ${String(body.error)}` : "";
    throw new Error(`tempiq POST experiment-windows: HTTP ${res.status}${hint}`);
  }
}
