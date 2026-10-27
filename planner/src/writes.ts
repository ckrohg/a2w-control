/**
 * @purpose The guarded HBX write path (plan §5.2). Mechanism (CORRECTED 2026-07-16): a target
 * is commanded by PATCHing a VALID near-flat reset curve (dbt=T+2 / mbt=T-2 — a real curve,
 * dbt > mbt). The device latches its curve mid-reheat and re-reads the cloud curve at the START
 * of the next reheat cycle, so the buffer ADOPTS the new band on the next cycle (proven live;
 * see memory hbx-remote-target-uncontrollable). Adoption is asynchronous — we do NOT synchronously
 * verify the operative target (the old dbt==mbt flatten + 8 s temp1.target check was the bug: the
 * device ignores a degenerate curve and only recomputes on the next cycle anyway). Restore
 * (#232) returns the plant to the PLAN's command for the block in force — the auto-pilot's own write
 * (the shaped curve, or the flat excursion target), through the same I4/I1 guards — and re-applies
 * the as-found endpoints from the seed config version only when no plan is being commanded or the
 * caller asks for them (`to: "as-found"`).
 * Guardrails, in order: I4 envelope clamp (bandFor, outdoor-indexed) → I1 cross-check against live
 * pump setpoints from the hub → rate limit (restore exempt: a restore ENDS an excursion, it never
 * starts one, and returning the plant must never be blocked) → PATCH with response-echo verify (proves the API accepted dbt/mbt) → self-recorded
 * config version (so the drift detector doesn't re-alert our own write) → audit row for EVERY
 * attempt, accepted or rejected → ntfy on success. Adoption then shows up in the 5-min poll loop
 * as temp1.target moves onto the new band; status() reports commanded-vs-operative.
 */

import { SensorLinxClient } from "./sensorlinx";
import type { Notify } from "./alertpolicy";
import { Store } from "./store";
import { HubClient, type HubState } from "./hub";
import { bandFor, DEFAULT_OPTS } from "./shadow";
import { extractConfig, diffConfig, patchEcho } from "./drift";
import { curveAlreadyInForce, curveOutputF, curveWriteGuard, type ShapedCurve } from "./curve";

const WRITE_MIN_INTERVAL_MS = 15 * 60 * 1000;
/**
 * How long a restore waits for an earlier write slot before it proceeds anyway. Above a healthy slot's worst case
 * (hub 20 s + SensorLinx PATCH 30 s, a re-auth, the audit rows), so only a genuinely stuck slot is overtaken.
 */
export const RESTORE_QUEUE_WAIT_MS = 120_000;
const SLX_FRESH_MS = 20 * 60 * 1000;

/**
 * #167: how old the hub's copy of the Pi's state may be before the I1 cross-check refuses to use it. The hub keeps
 * serving the Pi's LAST pumps[] after the Pi drops (pi_connected:false, ts frozen), and both I1 checks below used to
 * read those frozen setpoints as live: during the 2026-10-17 15–17Z dropout the auto-pilot set 145 °F at 17:51Z
 * against setpoints the Pi was no longer holding, Phase B could not lead, and the monitor logged an I1 VIOLATION at
 * 17:55Z. The Pi pushes a state frame every 15 s, so 10 min is 40 missed pushes — comfortably past the hub's 3-min
 * silence alert (index.ts PI_QUIET_ALERT_S) and far inside the 2–3 h dropouts measured (eval 2026-10-18 F1/F2).
 */
export const PI_STATE_FRESH_MS = 10 * 60 * 1000;
/**
 * How far AHEAD of the planner's clock a frame may be stamped before it is refused too (codex pass 1 on #179): the
 * Pi has no RTC, so a frame stamped tomorrow by a mis-set clock would otherwise read as fresh for a day — a
 * fail-OPEN path. Honest NTP skew is seconds; anything beyond this is not evidence of live pumps.
 */
export const PI_CLOCK_SKEW_MAX_S = 5 * 60;

/**
 * The reason the hub's state cannot stand in for the live pumps — or null when it can. Pure, so the three refusal
 * shapes are unit-testable without a Store (writes.test.ts). Used by BOTH I1 checks (setTarget, setCurve) and by the
 * identification driver's setpoint-coverage check — the plan restore (#232) included; only the as-found restore skips it.
 * `ts` is the Pi's own `time.time()` — UNIX SECONDS (heatpump-bridge/bridge/hub_client.py:227), relayed by the hub
 * unchanged (hub/src/index.ts GET /api/state). A millisecond value (> 1e11, i.e. after the year 5138 in seconds) is
 * normalised rather than trusted: read as seconds it would sit far in the future and make every frame look fresh.
 */
export function piStateUnverifiable(state: Pick<HubState, "pi_connected" | "ts">, nowMs: number = Date.now()): string | null {
  const ts = typeof state.ts === "number" && Number.isFinite(state.ts) ? state.ts : null;
  // signed: negative = the frame is stamped in OUR future (Pi clock ahead)
  const rawAgeS = ts == null ? null : Math.round((nowMs - (ts > 1e11 ? ts : ts * 1000)) / 1000);
  const ageS = rawAgeS == null ? null : Math.max(0, rawAgeS);
  const last = ageS == null ? "no state frame since the hub started" : `last state ${ageS} s ago`;
  if (!state.pi_connected) return `Pi disconnected from the hub — cannot verify I1 (${last})`;
  if (rawAgeS == null) return `no Pi state at the hub — cannot verify I1 (${last})`;
  // the moving number sits in the parenthesis so the age-free `stable` form is constant (codex pass 2 on #179)
  if (rawAgeS < -PI_CLOCK_SKEW_MAX_S) return `Pi state is stamped in the future — cannot verify I1 (${-rawAgeS} s ahead, clock skew beyond ${PI_CLOCK_SKEW_MAX_S} s)`;
  if (rawAgeS * 1000 > PI_STATE_FRESH_MS) return `Pi state at the hub is stale — cannot verify I1 (${last}, limit ${PI_STATE_FRESH_MS / 1000} s)`;
  return null;
}

const cToF = (c: number) => (c * 9) / 5 + 32;

// ── Graceful-handover coordination (2026-10-01) ──────────────────────────────────────────────────
// index.ts raises the barrier on SIGTERM; the device PATCH below counts itself in/out so shutdown can tell whether
// a command is still on the wire before it releases the single-writer lease (it never releases over one).
let writeBarrier = false;
let writesInFlight = 0;
/** Refuse every NEW device write from now on (idempotent). */
export function raiseWriteBarrier(): void { writeBarrier = true; }
export function isWriteBarrierUp(): boolean { return writeBarrier; }
/** Device PATCHes currently on the wire. */
export function deviceWritesInFlight(): number { return writesInFlight; }

// #177 (codex pass 1): one in-process lock around "the device's curve changes → the change is recorded". patch()
// holds it from the PATCH through its self-recorded config version; the drift detector holds it from its 30-s
// confirmation re-read through its own record. Without it a dashboard write could land between the detector's
// re-read and its record (our own write paged as a curve change, or a stale curve recorded over ours). The planner
// is the sole writer (#36), so an in-process lock covers every write path; it is never held across the 30-s wait.
let deviceLock: Promise<unknown> = Promise.resolve();
export function withDeviceLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = deviceLock.then(fn, fn);
  deviceLock = run.catch(() => {});
  return run;
}

/**
 * Per-write boost semantics, evaluated INSIDE the serial slot so no check-then-write gap remains.
 * yieldToBoost: an automatic writer (auto-pilot, identification) refuses to write while a boost is active — the
 * refusal is a WriteError whose `stable` is BOOST_YIELD (isBoostYield), which callers record as a hold, not a fault.
 * It matters most for restore(), which the rate limit never blocks (codex pass 2 on the boost hold).
 * endsBoost: a human write (dashboard restore / set target) replaces the boost, so it retires the open boost row —
 * otherwise the auto-pilot would keep holding a boost the owner already cancelled.
 */
export type WriteOpts = { yieldToBoost?: boolean; endsBoost?: boolean };
/**
 * #232: what restore() returns the plant TO when a plan is being commanded — the auto-pilot's own write for the block
 * in force (autopilot.ts planCommandForBlock): the shaped curve on a curve hour, the flat target under the ceiling
 * its identity authorises on an excursion or a curve-less block. Resolved INSIDE the restore's serial slot, so it is
 * the block in force at the moment of the write, not at the moment the boost was started.
 */
export type PlanCommand =
  | { kind: "curve"; curve: Pick<ShapedCurve, "dot" | "dbt" | "mbt" | "wwsd">; reason: string }
  | { kind: "flat"; targetF: number; capF: number; reason: string };
/**
 * Where a restore goes. "plan" (the default): the plan's command for the block in force, the as-found curve only when
 * none is being commanded. "as-found": the July as-found endpoints unconditionally — the pre-#232 semantics, kept for
 * the emergency case (the identification driver's abort fallback, an operator who wants the device on the human's
 * regime) and reachable from the API as POST /api/hbx/restore {"to":"as-found"}.
 */
export type RestoreTo = "plan" | "as-found";
export type RestoreOpts = WriteOpts & { to?: RestoreTo };
export const BOOST_YIELD = "yielded to an active boost";
export function isBoostYield(e: unknown): e is BoostYieldError { return e instanceof BoostYieldError; }

export class WriteError extends Error {
  /**
   * `stable` is the message with its moving parts (ages, counts) removed — the key the auto-pilot dedups its ledger
   * on (#167: "Pi disconnected … (last state 134 s ago)" changes every poll; without this a 3-h dropout would write
   * 36 autopilot_log rows for one condition). Defaults to the message itself.
   */
  constructor(public status: number, message: string, public readonly stable: string = message) {
    super(message);
  }
}

/** The WriteOpts.yieldToBoost refusal; carries the boost so the caller can record what actually holds the plant. */
export class BoostYieldError extends WriteError {
  constructor(public readonly boost: { targetF: number; restoreAt: Date }) {
    super(409, `${BOOST_YIELD} (${boost.targetF}°F until ${boost.restoreAt.toISOString()})`, BOOST_YIELD);
  }
}

/**
 * True when the live curve endpoints differ from the as-found baseline — i.e. the operative
 * curve is one WE wrote (autopilot/boost near-flat band), not the human's. The I4 comfort
 * ceiling (curve+3, "never hotter than the regime the hardware already tolerated") must then
 * reference the BASELINE curve: judged against our own near-flat curve the ceiling becomes
 * self-referential — "last commanded +3", a ratchet that 422s any real raise (the #58 bank,
 * a winter demand floor) even though the as-found regime ran far hotter (#58).
 */
export function curveOverridden(
  cfg: Record<string, any> | null,
  baseline: Record<string, any> | null,
): boolean {
  return cfg != null && baseline != null && (cfg.dbt !== baseline.dbt || cfg.mbt !== baseline.mbt);
}

export class HbxWriter {
  private lastWriteAt = 0;
  /**
   * Every device write (setTarget, setCurve, boost, restore, boost expiry) runs one at a time, in arrival order. The
   * rate limit is checked before the PATCH but lastWriteAt is only set after it, so two writers that both passed the
   * check could both land — and an auto-pilot write still in flight when the owner taps a boost could land SECOND and
   * replace the boost (codex pass 1 on the boost hold). Serialised, the second writer sees the first's lastWriteAt
   * and is refused 429. In-process only; a second planner instance is the writer lease's job (#36). patchDevice has
   * its own fetch timeout, so a hung PATCH cannot wedge the chain.
   */
  private writeChain: Promise<unknown> = Promise.resolve();
  private restoreQueueWaitMs = RESTORE_QUEUE_WAIT_MS; // an instance field so the suite can shorten it
  private serial<T>(fn: () => Promise<T>, maxWaitMs?: number): Promise<T> {
    const prev = this.writeChain;
    if (maxWaitMs == null) {
      const run = prev.then(fn, fn);
      this.writeChain = run.catch(() => {});
      return run;
    }
    // Bounded wait (restore only): the main pool has no query timeouts, so a slot stuck in a hung query would
    // otherwise block the one write that must never be blocked (codex pass 8). Past the bound the restore runs anyway —
    // the device PATCH is still ordered by withDeviceLock — and later writers wait for BOTH the stuck slot and it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gate = Promise.race([
      prev,
      new Promise<void>((r) => { timer = setTimeout(() => { console.warn(`[writer] a write slot has not settled in ${maxWaitMs / 1000} s — the restore proceeds without it`); r(); }, maxWaitMs); }),
    ]).finally(() => clearTimeout(timer));
    const run = gate.then(fn, fn);
    this.writeChain = Promise.allSettled([prev, run]);
    return run;
  }
  /**
   * A human write (endsBoost) landed but its boost row could not be retired (DB error). The row is now STALE: retried
   * at the start of every serial slot and every expireBoosts() (each poll, before the auto-pilot reads hbx_boosts), and
   * until it succeeds the expiry restore is skipped — restoring at the stale restore_at would overwrite the owner's
   * replacement command (codex pass 3). The auto-pilot meanwhile holds on the stale row: no write, the owner's command
   * stays. Surfaced in status().boost_cancel_pending and the write response. In-memory: a restart forgets it, and the
   * stale row then behaves like an ordinary boost (hold, then the as-found restore at its restore_at).
   */
  private retirePendingBefore: Date | null = null; // the landing time of the cancel whose retire is pending
  private get retirePending(): boolean { return this.retirePendingBefore != null; }
  private async retryPendingRetire(): Promise<boolean> {
    if (!this.retirePendingBefore) return true;
    try {
      await this.store.retireOpenBoosts(this.retirePendingBefore);
      this.retirePendingBefore = null;
      console.log("[boost] the cancelled boost row is retired (retry succeeded)");
      return true;
    } catch (e) {
      console.error(`[boost] retiring the cancelled boost row failed again: ${(e as Error).message}`);
      return false;
    }
  }
  /** One serial slot with the WriteOpts boost semantics around the write. */
  private guarded(source: string, action: string, requested: unknown, opts: WriteOpts, write: () => Promise<Record<string, unknown>>, maxWaitMs?: number): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      // Before the yield check, so a cancelled boost whose row can now be retired no longer makes an automatic writer
      // yield. If the retry fails the stale row still yields — fail closed, like the auto-pilot's own pre-check: the
      // owner's replacement command stays in force until the row is gone.
      await this.retryPendingRetire();
      if (opts.yieldToBoost) {
        const b = await this.store.activeBoost();
        if (b) {
          const err = new BoostYieldError(b);
          await this.store.insertHbxWrite({ source, action, requested, result: "rejected", detail: err.message });
          throw err;
        }
      }
      if (!opts.endsBoost) return write();
      // The cancel follows the DEVICE, not the bookkeeping: patch() bumps deviceWrites as soon as the PATCH is
      // accepted, so a write whose later audit / config-version insert (or read-back) threw still ends the boost —
      // otherwise its timer would restore over the owner's command (codex pass 4).
      const before = this.deviceWrites;
      let result: Record<string, unknown>;
      try { result = await write(); }
      // The cutoff is the moment the PATCH landed (stamped beside deviceWrites), not now: patch()'s bookkeeping and
      // ntfy run after it, and a successor planner's boost started in that gap must not be retired (codex pass 6).
      catch (e) { if (this.deviceWrites !== before) await this.retireCancelledBoost(source, action, this.lastDeviceWriteAt); throw e; }
      // The write has landed; a failed retire must not turn it into an error response — it is retried (above).
      return (await this.retireCancelledBoost(source, action, this.lastDeviceWriteAt)) ? result : { ...result, boost_retire_failed: true };
    }, maxWaitMs);
  }
  /** Device writes that reached SensorLinx (PATCH accepted), whatever happened after — and when the last one did. */
  private deviceWrites = 0;
  private lastDeviceWriteAt = new Date(0);
  /** Retire the open boost row for a landed human write; on failure arm the retry. true = retired. */
  private async retireCancelledBoost(source: string, action: string, landedAt: Date): Promise<boolean> {
    try { await this.store.retireOpenBoosts(landedAt); return true; }
    catch (e) {
      // a second failed cancel widens the window to its own landing time (rows before the earlier one are inside it)
      this.retirePendingBefore = this.retirePendingBefore && this.retirePendingBefore > landedAt ? this.retirePendingBefore : landedAt;
      const msg = `${source} ${action} landed but the cancelled boost's row was not retired (${(e as Error).message}) — retrying each poll; the boost expiry restore is held until it succeeds`;
      console.error(`[boost] ${msg}`);
      await this.notify("Boost cancel incomplete", msg, "high", { tier: "record", key: "boost-cancel-incomplete",
        action: "Check the planner's database connection (Railway); the tank may stay boosted until this clears." }).catch(() => {});
      return false;
    }
  }
  private planCurve: Pick<ShapedCurve, "dot" | "dbt" | "mbt" | "wwsd"> | null = null;
  /** #232: resolves the plan's command for the block in force (AutoPilot.planCommand); null until index.ts wires it. */
  private planCommand: (() => Promise<PlanCommand | null>) | null = null;

  constructor(
    private readonly slx: SensorLinxClient,
    private readonly store: Store,
    private readonly hub: HubClient | null,
    private readonly buildingId: string,
    private readonly syncCode: string,
    private readonly notify: Notify,
    // Phase 3 v2: surfaced in status() so the Optimize UI knows whether the daily auto-sanitize is
    // live. Mutable so the dashboard toggle (controller_flags) keeps it live. Does NOT change any
    // write path — it only gates whether checkI8 auto-actuates the soak.
    private autoSanitizeEnabled = false,
    // #36 optional defense-in-depth (flag-gated by WRITER_LEASE_ENABLED). When set, patch()
    // refuses to write unless THIS instance holds a fresh single-writer lease, so a second
    // planner instance can't collide on the live plant. null = disabled (no-op) — the default.
    private readonly writerLease: { instanceId: string; staleMs: number } | null = null,
  ) {}

  /** Current status for the dashboard card: live target, envelope, write state. */
  async status(): Promise<Record<string, unknown>> {
    const [latest, cfg, baseline] = await Promise.all([
      this.store.getLatestSlx(),
      this.store.latestConfig(),
      this.store.baselineConfig(),
    ]);
    const outdoor = latest?.outdoorF ?? null;
    const overridden = curveOverridden(cfg, baseline);
    const band = outdoor != null ? bandFor(outdoor, overridden ? baseline : cfg, DEFAULT_OPTS.strictCapF) : null;
    // Commanded target = midpoint of the current curve band we wrote; operative = temp1.target
    // the device is actually driving to. They differ during the adoption lag (until the next
    // reheat cycle) — surface both so the UI shows "commanded X, adopts next cycle" rather than
    // looking stuck.
    const commanded = cfg != null ? Math.round(((cfg.dbt as number) + (cfg.mbt as number)) / 2) : null;
    const operative = latest?.targetF ?? null;
    const adoptionPending = commanded != null && operative != null && Math.abs(commanded - operative) > 3;
    const boost = await this.store.activeBoost();
    return {
      tank_f: latest?.tankF ?? null,
      target_f: operative,
      commanded_target_f: commanded,
      adoption_pending: adoptionPending,
      // The HBX hot-tank differential in force: the identification driver's stale-report proof sizes its tank
      // margin from it (stale-target.ts staleTankMarginF). null until the first config version is recorded.
      ht_dif_f: typeof cfg?.htDif === "number" && Number.isFinite(cfg.htDif) ? cfg.htDif : null,
      outdoor_f: outdoor,
      band: band ? { lo: Math.round(band.lo), hi: Math.round(band.hi) } : null,
      curve_overridden: overridden,
      baseline: baseline ? { dbt: baseline.dbt, mbt: baseline.mbt } : null,
      // #133 acceptance 3: the curve IN FORCE and what it evaluates to at the live outdoor — not just the
      // last commanded scalar. A near-flat setTarget curve shows dbt ≈ mbt; a shaped one shows the slope.
      // #173: `shaped` = the PLAN's curve is the one in force — the same four-field predicate /health and the
      // auto-pilot use (curveAlreadyInForce), not the old dbt−mbt>4 spread heuristic: the floor-clamped plan curve
      // has a 2 °F spread (121/119 live on 2026-10-18) and read false here while /health said true. spread_f keeps
      // the old signal visible beside it.
      curve_in_force: cfg && typeof cfg.dot === "number" && typeof cfg.wwsd === "number" && typeof cfg.dbt === "number" && typeof cfg.mbt === "number"
        ? { dot: cfg.dot, wwsd: cfg.wwsd, dbt: cfg.dbt, mbt: cfg.mbt,
            output_at_live_outdoor_f: outdoor != null ? Math.round(curveOutputF({ dot: cfg.dot, wwsd: cfg.wwsd, dbt: cfg.dbt, mbt: cfg.mbt }, outdoor) * 10) / 10 : null,
            shaped: this.planCurve ? curveAlreadyInForce(this.planCurve, cfg) : false,
            spread_f: Math.round(((cfg.dbt as number) - (cfg.mbt as number)) * 10) / 10 }
        : null,
      last_write_at: this.lastWriteAt ? new Date(this.lastWriteAt).toISOString() : null,
      i1_margin_f: DEFAULT_OPTS.i1MarginF,
      active_boost: boost ? { target_f: boost.targetF, restore_at: boost.restoreAt.toISOString() } : null,
      boost_cancel_pending: this.retirePending,
      auto_sanitize_enabled: this.autoSanitizeEnabled,
    };
  }

  /** Live-toggle auto-sanitize (dashboard switch → controller_flags → applied each poll). */
  setAutoSanitize(enabled: boolean): void {
    this.autoSanitizeEnabled = enabled;
  }

  /**
   * #173: the curve the latest plan implies (index.ts shadowOnce stamps it on every block as `shaped_curve`), so
   * status() can answer "is the PLAN's curve the one in force?" with the same four-field predicate /health uses.
   * null until the first plan of this process, or when the feed could not shape one — then `shaped` is false, as
   * it is on /health.
   */
  setPlanCurve(curve: Pick<ShapedCurve, "dot" | "dbt" | "mbt" | "wwsd"> | null): void {
    this.planCurve = curve;
  }

  /**
   * #232: how restore() learns what the plan commands right now — the auto-pilot's planCommand(), wired by index.ts
   * when an auto-pilot is constructed. Without one (AUTOPILOT_ENABLED=0) every restore is the as-found curve, as before.
   */
  setPlanCommand(resolve: (() => Promise<PlanCommand | null>) | null): void {
    this.planCommand = resolve;
  }

  /**
   * #167: the I1 cross-check may only read hub state that IS the live pumps. A disconnected Pi, a hub that has had no
   * frame since it started, or a frame older than PI_STATE_FRESH_MS is refused with 503 — the same status and the
   * same "cannot verify I1" shape as an unreachable hub, which the auto-pilot already files as a rejection (no page)
   * and the identification driver as a transient. The message carries the age; `stable` drops it for dedup.
   */
  private async rejectUnlessPiLive(state: HubState, reject: (status: number, detail: string, stable?: string) => Promise<never>): Promise<void> {
    const why = piStateUnverifiable(state);
    if (why) await reject(503, why, why.replace(/ \(.*\)$/, ""));
  }

  // capF is the I4 upper ceiling for THIS write. Defaults to the everyday strictCap; the daily
  // sanitize passes DEFAULT_OPTS.sanitizeCapF so its 140°F soak isn't clamped to 135. This only
  // raises the envelope ceiling — the I1 cross-check below is unchanged, so a higher target still
  // requires the pump setpoints to cover it (setpoint ≥ target + margin) or the write is rejected.
  async setTarget(targetF: number, source: string, capF: number = DEFAULT_OPTS.strictCapF, opts: WriteOpts = {}): Promise<Record<string, unknown>> {
    return this.guarded(source, "set_target", { target_f: targetF }, opts, () => this.setTargetSerial(targetF, source, capF));
  }
  /**
   * `asRestore` (#232): this flat write IS a restore — the plan's excursion target the plant is returned to after a
   * boost. Same I4 / I1 / lease / audit guards; the rate limit is skipped (a restore ends an excursion, it never
   * starts one) and no epoch is passed to patch() (a restore is the last word, as the as-found one is). The audit
   * row still says set_target: the device got a near-flat target curve, which is what the TempIQ window poster must
   * see (a set_target both closes the boost's window and opens the excursion's).
   */
  private async setTargetSerial(targetF: number, source: string, capF: number, asRestore = false): Promise<Record<string, unknown>> {
    const epoch = this.deviceWrites; // what the guards below are evaluated against — re-checked before the PATCH
    const reject = async (status: number, detail: string, stable?: string): Promise<never> => {
      await this.store.insertHbxWrite({ source, action: "set_target", requested: { target_f: targetF }, result: "rejected", detail });
      throw new WriteError(status, detail, stable);
    };

    if (!Number.isFinite(targetF)) await reject(422, "target_f must be a number");
    targetF = Math.round(targetF);

    const latest = await this.store.getLatestSlx();
    if (!latest || Date.now() - latest.ts.getTime() > SLX_FRESH_MS || latest.outdoorF == null) {
      await reject(503, "no fresh SensorLinx reading — cannot evaluate the outdoor-indexed envelope");
    }
    const cfg = await this.store.latestConfig();
    const baseline = await this.store.baselineConfig();
    // The I4 ceiling references the AS-FOUND curve when the live one is ours (curveOverridden
    // above) — the live cfg still supplies dot/wwsd for the write solve below (we never change
    // those endpoints, only dbt/mbt).
    const envelopeCfg = curveOverridden(cfg, baseline) ? baseline : cfg;
    // A cap above the everyday strictCap marks a sanitize excursion, which is allowed above the
    // curve+3 comfort ceiling (bounded by capF); I1 below still requires setpoints to cover it.
    const sanitize = capF > DEFAULT_OPTS.strictCapF;
    const band = bandFor(latest!.outdoorF as number, envelopeCfg, capF, sanitize);
    if (targetF < band.lo || targetF > band.hi) {
      await reject(422, `target ${targetF}°F outside the I4 envelope [${Math.round(band.lo)}–${Math.round(band.hi)}]°F at ${latest!.outdoorF}°F outdoor`);
    }

    // I1 cross-check: every online pump must clear target + margin, or this write
    // manufactures the calls-forever deadlock.
    if (this.hub) {
      try {
        const state = await this.hub.getState();
        await this.rejectUnlessPiLive(state, reject);
        const required = targetF + DEFAULT_OPTS.i1MarginF;
        const offenders = state.pumps
          .filter((p) => p.online && p.setpoint_c != null && cToF(p.setpoint_c) < required)
          .map((p) => `${p.id} at ${cToF(p.setpoint_c as number).toFixed(1)}°F < ${required}°F`);
        if (offenders.length) {
          await reject(409, `I1 conflict: ${offenders.join("; ")} — raise pump setpoint(s) first or pick a lower target`);
        }
      } catch (e) {
        if (e instanceof WriteError) throw e;
        await reject(503, `hub unreachable — cannot verify I1: ${(e as Error).message}`);
      }
    }

    if (!asRestore && Date.now() - this.lastWriteAt < WRITE_MIN_INTERVAL_MS) {
      await reject(429, `rate limited: one HBX write per ${WRITE_MIN_INTERVAL_MS / 60000} min (restore is always allowed)`);
    }

    // Write a VALID near-flat curve (dbt > mbt) centered on the target — NOT a degenerate
    // flatten (dbt == mbt), which the device silently ignores. The controller re-reads the
    // cloud curve at the START of the next reheat cycle and adopts it (proven live 2026-07-16;
    // see memory hbx-remote-target-uncontrollable + hbx-target-write-noop-diagnosis.md).
    // Adoption is ASYNCHRONOUS (minutes / next cycle), so we do NOT synchronously verify
    // temp1.target here — that was the old bug (an 8 s check that always failed because the
    // operative target only moves on the next cycle). The config-echo inside patch() proves the
    // API accepted the write; the 5-min poll loop then records the operative target as it lands
    // on the new band, and status() surfaces commanded-vs-operative so the UI shows the pending
    // adoption. CAVEAT for Phase C: any pump-setpoint reduction must gate on the OPERATIVE
    // target (temp1.target), never this commanded value, or the adoption lag can manufacture an
    // I1 stall (the 2026-07-15 incident).
    // Emulate a FIXED target with a valid near-flat reset curve, computed so the curve's OUTPUT
    // at the CURRENT outdoor equals targetF exactly. A naive dbt=T+2/mbt=T-2 centers the band on T
    // but the reset-curve output sits near mbt at warm outdoor (and near dbt when cold), so the
    // operative target reads ~1°F off. Solving for the outdoor removes that bias: with slope point
    // f = (outdoor-dot)/(wwsd-dot) and spread s, set mbt = T - s(1-f), dbt = T + s·f  ⇒
    // output(outdoor) = T, while dbt-mbt = s (a valid, non-degenerate curve; the device ignores
    // dbt==mbt). Drift as outdoor moves is bounded by s over the whole 5–125°F range (~±0.7°F/day).
    const cc = cfg as { dot?: number; wwsd?: number } | null;
    const dot = cc?.dot ?? 5;
    const wwsd = cc?.wwsd ?? 125;
    const f = Math.max(0, Math.min(1, ((latest!.outdoorF as number) - dot) / (wwsd - dot)));
    const SPREAD = 4;
    const dbt = Math.round(targetF + SPREAD * f);
    const mbt = Math.round(targetF - SPREAD * (1 - f));
    return this.patch(
      { dbt, mbt },
      source,
      "set_target",
      `target ${targetF}°F ${asRestore ? "restored (the plan's target for the block in force; " : "commanded ("}curve ${dbt}/${mbt} → ${targetF}°F output at ${Math.round(latest!.outdoorF as number)}°F outdoor; adopts on the next reheat cycle)`,
      asRestore ? undefined : epoch,
    );
  }

  /**
   * #133 (b): command a demand-SHAPED reset curve — dot / dbt / mbt (wwsd is never moved). The device
   * then weather-compensates on its own between planner writes and after a planner death, which is
   * the whole point: the fallback becomes correct by construction instead of a flat target.
   * Guardrails mirror setTarget, evaluated where they bite: I4 at BOTH endpoints (each against the
   * envelope at its own outdoor), I1 against the curve's OUTPUT at the live outdoor (what the pumps
   * must cover now — Phase B leads the output, not a commanded scalar), the rate limit, audit for
   * every attempt, and the config-echo verify inside patch(). Excursions (bank, soak, storm, boost,
   * identification probes) stay setTarget writes on top; restore() puts the as-found curve back.
   */
  async setCurve(curve: Pick<ShapedCurve, "dot" | "dbt" | "mbt" | "wwsd">, source: string, capF: number = DEFAULT_OPTS.strictCapF, opts: WriteOpts = {}): Promise<Record<string, unknown>> {
    return this.guarded(source, "set_curve", { dot: curve.dot, dbt: curve.dbt, mbt: curve.mbt, wwsd: curve.wwsd }, opts, () => this.setCurveSerial(curve, source, capF));
  }
  /**
   * `asRestore` (#232): this curve write IS a restore — the plan's shaped curve the plant is returned to after a
   * boost. Same I4 / I1 / lease / audit guards; the rate limit is skipped and no epoch is passed (see setTargetSerial).
   * The audit row says `restore`: like the as-found restore it puts the STANDING curve back and opens no TempIQ
   * window — it only closes the boost's (store.pendingCurveWrites counts set_target and restore as closers; the
   * auto-pilot's own set_curve rows are neither opened nor closers, so `restore` is the honest action here).
   */
  private async setCurveSerial(curve: Pick<ShapedCurve, "dot" | "dbt" | "mbt" | "wwsd">, source: string, capF: number, asRestore = false): Promise<Record<string, unknown>> {
    const epoch = this.deviceWrites; // what the guards below are evaluated against — re-checked before the PATCH
    const action = asRestore ? "restore" : "set_curve";
    // wwsd rides along UNCHANGED so patch()'s read-back verifies the device executes the line we
    // validated (the guard already refused a wwsd that differs from the live one).
    const requested = { dot: curve.dot, dbt: curve.dbt, mbt: curve.mbt, wwsd: curve.wwsd };
    const reject = async (status: number, detail: string, stable?: string): Promise<never> => {
      await this.store.insertHbxWrite({ source, action, requested, result: "rejected", detail });
      throw new WriteError(status, detail, stable);
    };
    const latest = await this.store.getLatestSlx();
    if (!latest || Date.now() - latest.ts.getTime() > SLX_FRESH_MS || latest.outdoorF == null) {
      await reject(503, "no fresh SensorLinx reading — cannot evaluate the outdoor-indexed envelope");
    }
    const cfg = await this.store.latestConfig();
    const baseline = await this.store.baselineConfig();
    const envelopeCfg = curveOverridden(cfg, baseline) ? baseline : cfg;
    const guard = curveWriteGuard({ curve, liveCfg: cfg, baseline, envelopeCfg, capF });
    if (guard) await reject(guard.status, guard.detail);
    // I1 against the curve's output at the LIVE outdoor.
    const outputNow = curveOutputF(curve, latest!.outdoorF as number);
    if (this.hub) {
      try {
        const state = await this.hub.getState();
        await this.rejectUnlessPiLive(state, reject);
        const required = outputNow + DEFAULT_OPTS.i1MarginF;
        const offenders = state.pumps
          .filter((p) => p.online && p.setpoint_c != null && cToF(p.setpoint_c) < required)
          .map((p) => `${p.id} at ${cToF(p.setpoint_c as number).toFixed(1)}°F < ${required.toFixed(1)}°F`);
        if (offenders.length) {
          await reject(409, `I1 conflict at the curve's output ${outputNow.toFixed(1)}°F (${Math.round(latest!.outdoorF as number)}°F outdoor): ${offenders.join("; ")} — raise pump setpoint(s) first`);
        }
      } catch (e) {
        if (e instanceof WriteError) throw e;
        await reject(503, `hub unreachable — cannot verify I1: ${(e as Error).message}`);
      }
    }
    if (!asRestore && Date.now() - this.lastWriteAt < WRITE_MIN_INTERVAL_MS) {
      await reject(429, `rate limited: one HBX write per ${WRITE_MIN_INTERVAL_MS / 60000} min (restore is always allowed)`);
    }
    return this.patch(
      requested,
      source,
      action,
      `${asRestore ? "plan curve restored" : "curve commanded"}: ${curve.dbt}°F at ${curve.dot}°F → ${curve.mbt}°F at ${curve.wwsd}°F (output ${outputNow.toFixed(1)}°F at ${Math.round(latest!.outdoorF as number)}°F outdoor; adopts on the next reheat cycle)`,
      asRestore ? undefined : epoch,
    );
  }

  /**
   * Timed boost with DURABLE auto-restore: set a fixed target now, and the poll loop
   * restores the plan's command for the block in force (#232; the as-found curve only when no plan
   * is being commanded) when restore_at passes — recorded in Postgres, so a planner
   * restart mid-boost cannot strand the override (the Phase C write-safety primitive,
   * built early in human-triggered form). All setTarget guardrails apply to the boost;
   * the restore is exempt from the rate limit (returning the plant is never blocked).
   */
  async boost(targetF: number, minutes: number, source: string, capF: number = DEFAULT_OPTS.strictCapF): Promise<Record<string, unknown>> {
    if (!Number.isFinite(minutes) || minutes < 15 || minutes > 120) {
      await this.store.insertHbxWrite({ source, action: "boost", requested: { target_f: targetF, minutes }, result: "rejected", detail: "minutes must be 15–120" });
      throw new WriteError(422, "minutes must be 15–120");
    }
    // The write AND its hbx_boosts row inside one serial slot: the auto-pilot's boost hold reads that row.
    return this.serial(async () => {
      await this.retryPendingRetire();
      const before = this.deviceWrites;
      const result = await this.setTargetSerial(targetF, source, capF); // envelope (capF) + I1 + rate limit
      // The boost's PATCH is device write before+1 (the in-lock epoch check guarantees none landed ahead of it). Any
      // later one is a restore that overtook this slot while it was stuck after the PATCH (ntfy, audit): the owner
      // replaced the boost, so recording it now would hold the auto-pilot on the restored curve (codex pass 10).
      const overtaken = () => this.deviceWrites !== before + 1;
      if (overtaken()) {
        console.warn(`[boost] ${targetF}°F boost was overtaken by a restore before its row was recorded — not recorded`);
        return { ...result, boost_restore_at: null, boost_superseded: true };
      }
      const restoreAt = new Date(Date.now() + minutes * 60_000);
      const id = await this.store.insertBoost(targetF, restoreAt);
      this.retirePendingBefore = null; // insertBoost retired every older open row, the stale one included
      if (overtaken()) {
        // the restore landed while the insert was in flight — its own retire may have run before the row existed
        await this.store.retireBoost(id);
        console.warn(`[boost] ${targetF}°F boost row #${id} retired — a restore overtook it while it was being recorded`);
        return { ...result, boost_restore_at: null, boost_superseded: true };
      }
      return { ...result, boost_restore_at: restoreAt.toISOString() };
    });
  }

  /**
   * Called every poll: restore any boost whose timer has passed (durable expiry). A due row while a NEWER boost is
   * active (an old row left unrestored through downtime or a failing restore, then the owner boosted again) is retired
   * without a restore: restoring the curve then would erase the live boost, and the auto-pilot's boost hold
   * would keep the plant on that curve until the newer boost ran out (codex pass 1). The newer boost's own expiry
   * restores the curve. The restore goes to the PLAN's command (#232): a refused one (I1 / Pi unverifiable / lease)
   * throws, the row stays due and the next poll retries — the plant meanwhile sits at the boost's own I4/I1-checked
   * target, never at the July as-found curve.
   */
  async expireBoosts(): Promise<void> {
    return this.serial(async () => {
      if (!(await this.retryPendingRetire())) return; // a stale (cancelled) row's expiry must not restore over the owner's command
      const due = await this.store.dueBoosts();
      if (!due.length) return;
      const active = await this.store.activeBoost();
      if (active) {
        console.log(`[boost] retiring ${due.length} overdue boost row(s) without a restore — a newer boost to ${active.targetF}°F is active until ${active.restoreAt.toISOString()}`);
      } else {
        await this.restoreSerial("boost-expiry", "plan");
      }
      await this.store.markBoostsRestored(due.map((d) => d.id));
    });
  }

  /**
   * Return the plant to its standing command. `to: "plan"` (the default, #232): the plan's command for the block in
   * force — the auto-pilot's own write, through the I4 / I1 / lease guards — so the device never sees the July
   * as-found curve (≈ 158 °F at 46 °F outdoor against ~125 °F pump setpoints: an I1 violation Phase B then chases to
   * the 140 °F cap) and the auto-pilot's next tick reads "already commanded" instead of being rate-limited against
   * its own plan for 15 min. The as-found endpoints are applied only when nothing of the plan is being commanded
   * (no auto-pilot, shadow, no plan block) or on `to: "as-found"`. Never rate-limited either way.
   */
  async restore(source: string, opts: RestoreOpts = {}): Promise<Record<string, unknown>> {
    return this.guarded(source, "restore", null, opts, () => this.restoreSerial(source, opts.to ?? "plan"), this.restoreQueueWaitMs);
  }
  private async restoreSerial(source: string, to: RestoreTo): Promise<Record<string, unknown>> {
    let why = to === "as-found" ? "as-found requested" : "no plan command resolver (auto-pilot not constructed)";
    if (to === "plan" && this.planCommand) {
      // A failed plan read propagates (fail closed): a boost expiry retries next poll and the dashboard sees the
      // error — the device is never handed the as-found curve because the DB hiccuped.
      const cmd = await this.planCommand();
      if (cmd?.kind === "curve") return this.setCurveSerial(cmd.curve, source, DEFAULT_OPTS.strictCapF, true);
      if (cmd?.kind === "flat") return this.setTargetSerial(cmd.targetF, source, cmd.capF, true);
      why = "no plan command to return to (auto-pilot in shadow, no recent plan, or no target on the block in force)";
    }
    const baseline = await this.store.baselineConfig();
    if (!baseline || typeof baseline.dbt !== "number" || typeof baseline.mbt !== "number") {
      await this.store.insertHbxWrite({ source, action: "restore", requested: null, result: "rejected", detail: "no baseline config version" });
      throw new WriteError(500, "no baseline config version");
    }
    // A shaped curve (#133) moves dot as well as dbt/mbt; the as-found dot comes back with them.
    const fields: Record<string, number> = { dbt: baseline.dbt as number, mbt: baseline.mbt as number };
    if (typeof baseline.dot === "number") fields.dot = baseline.dot as number;
    return this.patch(fields, source, "restore",
      `as-found curve restored (${baseline.dbt}/${baseline.mbt}°F${typeof baseline.dot === "number" ? ` from ${baseline.dot}°F` : ""}) — ${why}`);
  }

  private async patch(
    fields: Record<string, number>,
    source: string,
    action: string,
    summary: string,
    /**
     * deviceWrites when the caller evaluated its guards (rate limit, I1, envelope). A device write landing since then
     * can only be a restore that overtook this write's stuck slot (serial(maxWaitMs)); this write's guards are then
     * stale and it must not land over the restore (codex pass 9). Omitted for restore itself: it is the last word.
     */
    epoch?: number,
  ): Promise<Record<string, unknown>> {
    // Graceful handover (2026-10-01): once SIGTERM has landed no NEW device write may start — the lease is about to
    // be handed to the successor and a PATCH that began after the barrier could land after the successor's own
    // decision. Refused and recorded, never silently dropped; the successor re-plans on its next poll.
    if (writeBarrier) {
      await this.store.insertHbxWrite({ source, action, requested: fields, result: "rejected", detail: "planner shutting down — write barrier up (lease handover in progress)" });
      throw new WriteError(503, "refused: planner is shutting down (lease handover in progress)");
    }
    // ADMISSION is counted synchronously, right after the barrier check and before any await: a write that has
    // passed the barrier is in flight from this point (including the dashboard API routes, which are not inside the
    // poll loop), so shutdown's "no device write on the wire" check cannot miss one blocked in the lease query
    // (codex pass 3 on #162). Released once the write is RECORDED (or failed), before the notification; the finally
    // below covers every other path.
    writesInFlight++;
    let released = false;
    const release = () => { if (!released) { released = true; writesInFlight--; } };
    try {
      // Single-writer lease gate (flag-gated; null = disabled). If this instance does not hold a
      // fresh lease, another planner is the active writer — refuse BEFORE touching the device.
      // Gates EVERY write path (set_target / boost / restore all funnel through here). #36.
      if (this.writerLease) {
        const held = await this.store.holdsWriterLease(this.writerLease.instanceId, this.writerLease.staleMs);
        if (!held) {
          await this.store.insertHbxWrite({ source, action, requested: fields, result: "rejected", detail: "does not hold the single-writer lease — another planner instance is the active writer" });
          throw new WriteError(423, "refused: this instance does not hold the single-writer lease (another planner is the active writer). See README §Single-writer invariant, #36.");
        }
      }
      const out = await withDeviceLock(async () => {
        // the barrier may have gone up while the lease query (or the wait for the device lock) was in flight — the
        // lease answer is then stale by design
        if (writeBarrier) {
          await this.store.insertHbxWrite({ source, action, requested: fields, result: "rejected", detail: "planner shutting down — write barrier went up during the lease check" });
          throw new WriteError(503, "refused: planner is shutting down (lease handover in progress)");
        }
        if (epoch != null && this.deviceWrites !== epoch) {
          await this.store.insertHbxWrite({ source, action, requested: fields, result: "rejected", detail: "superseded: another device write (a restore) landed while this write was being evaluated" });
          throw new WriteError(429, "superseded: a restore landed while this write was being evaluated — retry next cycle");
        }
        let dev: Record<string, any>;
        try {
          dev = await this.slx.patchDevice(this.buildingId, this.syncCode, fields);
          this.deviceWrites++; this.lastDeviceWriteAt = new Date();
        } catch (e) {
          await this.store.insertHbxWrite({ source, action, requested: fields, result: "failed", detail: (e as Error).message });
          throw new WriteError(502, `SensorLinx write failed: ${(e as Error).message}`);
        }
        // still counted as in flight: the self-recorded version + audit row are part of the write — shutdown must not
        // hand the lease over (and a successor must not record its own curve) before they land (codex pass 2)
        return this.recordWrite(dev, fields, source, action, summary);
      });
      release();
      await this.notify(`HBX ${action} (${source})`, summary, "default", { tier: "record" }); // outside the lock and the count: a slow ntfy holds neither
      return out;
    } finally {
      release();
    }
  }

  /** Verify the PATCH echo and self-record the write — runs inside withDeviceLock, straight after the PATCH. */
  private async recordWrite(
    dev: Record<string, any>,
    fields: Record<string, number>,
    source: string,
    action: string,
    summary: string,
  ): Promise<Record<string, unknown>> {
    const mismatches = Object.entries(fields).filter(([k, v]) => dev[k] !== v);
    if (mismatches.length) {
      const detail = `read-back mismatch: ${mismatches.map(([k, v]) => `${k} wanted ${v} got ${dev[k]}`).join("; ")}`;
      await this.store.insertHbxWrite({ source, action, requested: fields, result: "verify_mismatch", detail, response: patchEcho(dev, fields) });
      throw new WriteError(502, detail);
    }

    // Record the new config ourselves so the 5-min drift detector doesn't page about
    // our own audited write.
    const newCfg = extractConfig(dev);
    const prev = await this.store.latestConfig();
    const changes = prev ? diffConfig(prev, newCfg) : null;
    if (changes) {
      (changes as Record<string, unknown>)["_source"] = `${source}:${action}`;
      // #177: the PATCH response IS the device object — keep it whole, so a later "foreign" diff can be read
      // against exactly what the cloud said it held right after our write.
      await this.store.insertConfigVersion(newCfg, changes, { raw: dev });
    }

    this.lastWriteAt = Date.now();
    await this.store.insertHbxWrite({ source, action, requested: fields, result: "accepted", detail: summary, response: patchEcho(dev, fields) });
    return { ok: true, ...fields, detail: summary };
  }
}
