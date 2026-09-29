/**
 * @purpose The identification driver — a2w's half of gtm#1616 (the "switchback driver" of #137): run
 * RANDOMISED supply-water (AWT) probes so TempIQ's U4 can finally MEASURE each zone's requirement
 * instead of reading a textbook curve. Passive variation is endogenous (the buffer sags because
 * demand is high — TempIQv2#2043), so the only fittable evidence is a deliberately drawn, labelled
 * perturbation. TempIQ owns the statistics (GET /api/insights/identification-plan: which cell, which
 * direction, how big, whether it is safe); this module owns the actuator and the guardrails.
 *
 * ONE WINDOW AT A TIME, drawn not scheduled:
 *   idle    → pick the top safe cell whose outdoor band is current; draw against assignmentProbability
 *             (a fair coin between the PROBE arm and a HOLD arm — the hold is recorded too: exogenous
 *             control evidence at the base level is what gives U4 its second side)
 *   arming  → (up-probes only) publish the target to Phase B so the pump setpoints LEAD it (I1 would
 *             otherwise reject the write); wait until the live setpoints cover target + margin
 *   active  → the target is written through writer.setTarget (I4 envelope with the identification
 *             ceiling for up-probes — owner decision 2026-09-29: up to sanitizeCapF, never above — I1
 *             cross-check, rate limit, audit). The auto-pilot is HELD for the window so it cannot
 *             overwrite the arm; abort checks run every poll
 *   ended   → hold released (the auto-pilot re-commands its plan, which is the window's closer),
 *             window closed on TempIQ with achieved AWT + adoption compliance
 *
 * SAFETY, in order: the plan's own safeToProbe verdict (fail-closed on unknowns), the actuator's own
 * bounds (dhwFloorF, strictCapF, sanitizeCapF), I1 (setpoints must cover the target), the 15-min
 * write rate limit, and live aborts — I1 violated, room deficit on a down-probe (setpoint − 1 °F),
 * a DHW draw during a down-probe, hub/SLX stale, storm armed, boost active. A DOWN-probe abort
 * RESTORES the as-found curve immediately (the one write the rate limit never blocks; hotter is the
 * safe direction) and lets the auto-pilot re-plan; an up-probe abort just releases.
 *
 * Every window is persisted (identification_windows) so a planner restart resumes or closes it, and
 * posted to TempIQ as kind awt_identification WITH its drawn assignment — the only kind U4 may fit.
 * The quarantine poster (tempiq-windows.ts) skips source 'identification' writes so the same minutes
 * are not also filed as a manual quarantine window. Fail-soft on every TempIQ hop.
 *
 * Modes (runtime, controller_flags.identification_mode; env IDENTIFICATION_MODE seeds it): off |
 * shadow (decide, draw, log, write nothing) | armed. Surfaced on the dashboard's Optimize page next
 * to the autonomy switch, and in /status.identification.
 */
import { randomBytes } from "node:crypto";
import type { HubClient } from "./hub";
import type { Store } from "./store";
import type { HbxWriter } from "./writes";
import { WriteError } from "./writes";
import type { AutoPilot } from "./autopilot";
import type { PhaseB } from "./phaseb";
import type { DemandFeed, InsightZone } from "./demand";
import { DEFAULT_OPTS } from "./shadow";
import { detectDrawTimes } from "./dhw";

export type IdentMode = "off" | "shadow" | "armed";
export type IdentArm = "probe" | "hold";
export type IdentDirection = "up" | "down";
/**
 * arming        up-probe waiting for Phase B to lead the setpoints (no write yet)
 * pending_write the arm is drawn and the target is due, but the write has not been ACCEPTED yet
 *               (a 429 rate limit retries here; codex 2026-09-29 high: a rate-limited down-probe
 *               used to sit in 'active' with nothing written and close as "completed")
 * active        the target is on the device (or it is a hold arm) — the window is running and posted
 * ended         closed; `cleanupState` says whether the plant has been returned to its base
 */
export type IdentState = "arming" | "pending_write" | "active" | "ended";
export type CleanupState = "none" | "pending" | "done";

export const IDENT_MODES: readonly IdentMode[] = ["off", "shadow", "armed"];
const PLAN_REFRESH_MIN = 60;          // the plan is hourly-grained; a stale plan is not re-drawn against
const PLAN_MAX_AGE_MIN = 180;         // beyond this the plan is not trusted for a NEW window
const MIN_GAP_MIN = 60;               // washout + normal operation between windows
const ARMING_MAX_TICKS = 4;           // ~20 min for Phase B to lead the setpoints, else give up
const WRITE_RETRY_MAX = 3;            // 429 (rate limit) retries, one per poll
const MIN_STEP_F = 3;                 // below the 3 °F adoption tolerance a step is not a perturbation
const DEFICIT_F = 1;                  // room below setpoint − this = deficit (thermostat hysteresis)
const DRAW_LOOKBACK_MIN = 12;
const SLX_FRESH_MS = 15 * 60 * 1000;
const cToF = (c: number) => (c * 9) / 5 + 32;

/** The subset of TempIQ's plan cell this driver reads (identification-plan.ts, PlanCell). */
export interface PlanCell {
  zoneId: string;
  zoneName: string | null;
  deliveryType: string | null;
  deliveryTypeSource: string;
  band: [number, number];
  status: string;
  suggest: {
    direction: IdentDirection;
    magnitudeF: number;
    durationMin: number;
    assignmentProbability: number;
    informationGain: number;
    baseAwtF: number;
    aboveEverydayCap?: boolean;
    forecastComplete?: boolean;
    safeToProbe: { ok: boolean; binding: string | null; [k: string]: unknown };
  } | null;
}
export interface IdentPlan {
  generatedAt: string;
  cells: PlanCell[];
}

export interface IdentWindow {
  id: number;
  state: IdentState;
  arm: IdentArm;
  direction: IdentDirection;
  zoneIds: string[];
  bandLo: number;
  bandHi: number;
  magnitudeF: number;
  baseF: number;
  targetF: number;
  capF: number;
  drawProbability: number;
  drawSeed: string;
  startedAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  durationMin: number;
  writeId: number | null;
  dryRun: boolean;
  postedOpen: boolean;
  postedClosed: boolean;
  cell: unknown;
  safeToProbe: unknown;
  armingTicks: number;
  writeAttempts: number;
  /**
   * Returning the plant to its base after a LIVE probe is the driver's job, not the auto-pilot's
   * (codex 2026-09-29 critical: with the auto-pilot in shadow a completed 145 °F probe stayed
   * commanded indefinitely). 'pending' retries every tick until a guarded re-command of baseF —
   * or, when the rate limit refuses it, the as-found restore — is confirmed.
   */
  cleanupState: CleanupState;
  cleanupDetail: string | null;
}

/** The store surface the driver needs — structural so the assertion suite can hand it a fake. */
export interface IdentStore {
  getLatestSlx(): Promise<{ ts: Date; tankF: number | null; targetF: number | null; outdoorF: number | null } | null>;
  activeBoost(): Promise<{ targetF: number; restoreAt: Date } | null>;
  recentPlans(hours: number): Promise<{ computedAt: Date; plan: any[] }[]>;
  getRecentSeries(hours: number): Promise<{ ts: Date; tankF: number | null; anyCall: boolean }[]>;
  openIdentificationWindow(): Promise<IdentWindow | null>;
  lastIdentificationWindowEnd(): Promise<Date | null>;
  insertIdentificationWindow(w: Omit<IdentWindow, "id">): Promise<number>;
  updateIdentificationWindow(id: number, patch: Partial<Omit<IdentWindow, "id">>): Promise<void>;
  unpostedIdentificationWindows(): Promise<IdentWindow[]>;
  cleanupPendingIdentificationWindows(): Promise<IdentWindow[]>;
  latestAcceptedWriteId(source: string): Promise<number | null>;
  windowStats(from: Date, to: Date | null, commandedTargetF: number | null): Promise<{ achievedAwtF: number | null; compliance: number | null; outdoorLowF: number | null; outdoorHighF: number | null; samples: number }>;
}

export interface IdentDeps {
  store: IdentStore;
  writer: Pick<HbxWriter, "setTarget" | "restore" | "status">;
  autopilot: Pick<AutoPilot, "setHold" | "isDryRun">;
  phaseB: Pick<PhaseB, "setProbeTarget">;
  demandFeed: Pick<DemandFeed, "zones" | "refresh" | "isHealthy">;
  hub: Pick<HubClient, "getState">;
  baseUrl: string;
  token: string;
  notify: (title: string, body: string, priority?: string) => Promise<void>;
  isI1Violated: () => boolean;
  isStormActive: () => boolean;
  /** Query knobs for the plan — the actuator tells TempIQ its own bounds. */
  planQuery?: { abortLatencyMin: number; dhwFloorF: number; plantCapF: number; identificationCapF: number };
  fetchImpl?: typeof fetch;
  rng?: () => number;
  now?: () => Date;
}

// ─────────────────────────────────────────────── pure decision helpers ───────────────────────────

/** Top safe, owner-verified, unidentified cell whose band contains the current outdoor. */
export function pickCell(plan: IdentPlan, outdoorF: number): PlanCell | null {
  const eligible = plan.cells.filter((c) =>
    c.status === "unidentified"
    && c.suggest != null
    && c.suggest.safeToProbe.ok === true
    && c.deliveryTypeSource === "owner_verified"
    && outdoorF >= c.band[0] && outdoorF < c.band[1]
    && (c.suggest.direction === "up" || c.suggest.forecastComplete !== false),
  );
  eligible.sort((a, b) => (b.suggest!.informationGain - a.suggest!.informationGain) || a.band[0] - b.band[0]);
  return eligible[0] ?? null;
}

/** The randomisation: probe with probability p, else hold. The seed is the draw itself, recorded. */
export function drawArm(probability: number, rng: () => number = cryptoRandom): { arm: IdentArm; seed: string } {
  const u = rng();
  return { arm: u < probability ? "probe" : "hold", seed: u.toFixed(6) };
}
function cryptoRandom(): number {
  return randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
}

/**
 * The probe target from the ACTUAL base (what the auto-pilot commands now, not TempIQ's estimate),
 * inside the actuator's own bounds. null = the step left would be smaller than the adoption tolerance.
 */
export function probeTarget(a: {
  direction: IdentDirection; baseF: number; magnitudeF: number;
  dhwFloorF: number; strictCapF: number; identificationCapF: number; aboveEverydayCap: boolean;
}): { targetF: number; capF: number; stepF: number } | null {
  if (a.direction === "up") {
    const ceiling = a.aboveEverydayCap ? a.identificationCapF : a.strictCapF;
    const targetF = Math.round(Math.min(a.baseF + a.magnitudeF, ceiling));
    const stepF = targetF - a.baseF;
    if (stepF < MIN_STEP_F) return null;
    return { targetF, capF: targetF > a.strictCapF ? a.identificationCapF : a.strictCapF, stepF };
  }
  const targetF = Math.round(Math.max(a.baseF - a.magnitudeF, a.dhwFloorF));
  const stepF = a.baseF - targetF;
  if (stepF < MIN_STEP_F) return null;
  return { targetF, capF: a.strictCapF, stepF };
}

/** Why an ACTIVE window must end now, or null to continue. Hold arms only stop on plant-level trouble. */
export function abortReason(a: {
  arm: IdentArm; direction: IdentDirection;
  i1Violated: boolean; slxFresh: boolean; hubOnline: boolean; stormActive: boolean; boostActive: boolean;
  deficitZones: string[]; dhwDrawDetected: boolean;
}): string | null {
  if (a.i1Violated) return "i1_violated";
  if (!a.slxFresh) return "slx_stale";
  if (!a.hubOnline) return "hub_offline";
  if (a.stormActive) return "storm_active";
  if (a.boostActive) return "boost_active";
  if (a.arm === "probe" && a.direction === "down") {
    if (a.deficitZones.length) return `room_deficit:${a.deficitZones.join(",")}`;
    if (a.dhwDrawDetected) return "dhw_draw";
  }
  return null;
}

/** Zones in the window that have fallen below setpoint − DEFICIT_F (live TempIQ state). */
export function deficitZones(zones: InsightZone[], zoneIds: string[]): string[] {
  return zones
    .filter((z) => zoneIds.includes(z.id) && z.roomF != null && z.setpointF != null && z.roomF < z.setpointF - DEFICIT_F)
    .map((z) => z.id);
}

/** True when a plan block flagged sanitize/bank/storm sits inside the next `hours`. */
export function planConflictAhead(plan: any[] | null, nowMs: number, hours: number): boolean {
  if (!plan) return false;
  const end = nowMs + hours * 3600_000;
  return plan.some((b) => {
    const t = Date.parse(String(b?.ts));
    if (!Number.isFinite(t) || t < nowMs - 3600_000 || t > end) return false;
    const reason = String(b?.reason ?? "");
    return b?.sani === true || b?.bank === true || /sanitize|storm|bank/i.test(reason);
  });
}

/** The TempIQ window payload for a window (open when endedAt is null). */
export function windowPayload(w: IdentWindow, stats: { achievedAwtF: number | null; compliance: number | null; outdoorLowF: number | null; outdoorHighF: number | null } | null): Record<string, unknown> {
  const inRange = (v: number | null | undefined, lo: number, hi: number) => v != null && Number.isFinite(v) && v >= lo && v <= hi;
  const p: Record<string, unknown> = {
    externalId: `a2w-ident-${w.id}`,
    kind: "awt_identification",
    startedAt: (w.startedAt ?? new Date()).toISOString(),
    endedAt: w.endedAt ? w.endedAt.toISOString() : null,
    zoneIds: w.zoneIds,
    assignment: { arm: w.arm === "probe" ? w.direction : "hold", magnitudeF: w.magnitudeF, drawnWithProbability: w.drawProbability, seed: w.drawSeed },
    commandedTargetF: w.targetF,
    washoutMin: 30,
    source: "a2w-planner",
    safeToProbeAtAssignment: w.safeToProbe ?? null,
  };
  if (inRange(w.bandLo, -60, 130)) p.outdoorBandLowF = w.bandLo;
  if (inRange(w.bandHi, -60, 130)) p.outdoorBandHighF = w.bandHi;
  if (stats) {
    if (inRange(stats.achievedAwtF, 32, 212)) p.achievedAwtF = Math.round(stats.achievedAwtF! * 10) / 10;
    if (inRange(stats.compliance, 0, 1)) p.compliance = Math.round(stats.compliance! * 1000) / 1000;
  }
  return p;
}

// ─────────────────────────────────────────────── the driver ──────────────────────────────────────

export interface IdentStatus {
  mode: IdentMode;
  enabled: boolean;
  lastTickAt: string | null;
  lastResult: string | null;
  planFetchedAt: string | null;
  planCells: number;
  planEligibleNow: number;
  window: null | { id: number; state: IdentState; arm: IdentArm; direction: IdentDirection; targetF: number; baseF: number; startedAt: string | null; endsAt: string | null; zoneIds: string[] };
  consecutivePostFailures: number;
}

export class IdentificationDriver {
  private mode: IdentMode;
  private plan: IdentPlan | null = null;
  private planFetchedAt: number | null = null;
  private lastTickAt: string | null = null;
  private lastResult: string | null = "not run yet";
  private eligibleNow = 0;
  private consecutivePostFailures = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly rng: () => number;
  private readonly now: () => Date;
  private readonly planQuery: NonNullable<IdentDeps["planQuery"]>;

  constructor(private readonly d: IdentDeps, initialMode: IdentMode = "off") {
    this.mode = initialMode;
    this.fetchImpl = d.fetchImpl ?? fetch;
    this.rng = d.rng ?? cryptoRandom;
    this.now = d.now ?? (() => new Date());
    this.planQuery = d.planQuery ?? {
      abortLatencyMin: 35, dhwFloorF: DEFAULT_OPTS.dhwFloorF, plantCapF: DEFAULT_OPTS.strictCapF, identificationCapF: DEFAULT_OPTS.sanitizeCapF,
    };
  }

  setMode(m: IdentMode): void { this.mode = m; }
  get currentMode(): IdentMode { return this.mode; }

  status(): IdentStatus {
    return {
      mode: this.mode, enabled: true, lastTickAt: this.lastTickAt, lastResult: this.lastResult,
      planFetchedAt: this.planFetchedAt ? new Date(this.planFetchedAt).toISOString() : null,
      planCells: this.plan?.cells.length ?? 0, planEligibleNow: this.eligibleNow,
      window: this.currentWindow ? {
        id: this.currentWindow.id, state: this.currentWindow.state, arm: this.currentWindow.arm, direction: this.currentWindow.direction,
        targetF: this.currentWindow.targetF, baseF: this.currentWindow.baseF,
        startedAt: this.currentWindow.startedAt?.toISOString() ?? null,
        endsAt: this.currentWindow.startedAt ? new Date(this.currentWindow.startedAt.getTime() + this.currentWindow.durationMin * 60_000).toISOString() : null,
        zoneIds: this.currentWindow.zoneIds,
      } : null,
      consecutivePostFailures: this.consecutivePostFailures,
    };
  }
  private currentWindow: IdentWindow | null = null;

  /** One poll: advance the window state machine; never throws. */
  async tick(): Promise<void> {
    this.lastTickAt = this.now().toISOString();
    try {
      await this.cleanupPending();
      await this.postPending();
      const open = await this.d.store.openIdentificationWindow();
      this.currentWindow = open;
      if (open) {
        if (this.mode === "off") { await this.end(open, "mode_off"); return; }
        if (open.state === "arming") await this.continueArming(open);
        else if (open.state === "pending_write") await this.continuePendingWrite(open);
        else await this.continueActive(open);
        return;
      }
      // Idle: nothing open. A release must leave the auto-pilot free and Phase B unburdened.
      this.d.autopilot.setHold(null, "");
      this.d.phaseB.setProbeTarget(null);
      if (this.mode === "off") { this.lastResult = "off"; return; }
      await this.maybeStart();
    } catch (e) {
      this.lastResult = `error: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[identify] ${this.lastResult}`);
    }
  }

  // ── idle → arming/active ──
  private async maybeStart(): Promise<void> {
    const nowMs = this.now().getTime();
    const slx = await this.d.store.getLatestSlx();
    if (!slx || nowMs - slx.ts.getTime() > SLX_FRESH_MS || slx.outdoorF == null) { this.lastResult = "idle: no fresh SensorLinx reading"; return; }
    if (this.d.isI1Violated()) { this.lastResult = "idle: I1 violated"; return; }
    if (this.d.isStormActive()) { this.lastResult = "idle: storm armed/active"; return; }
    if (await this.d.store.activeBoost()) { this.lastResult = "idle: boost active"; return; }
    // ARMED identification needs the auto-pilot LIVE: it is what returns the plant to its plan after a
    // window, and the explicit cleanup below is the belt to that brace, not a replacement for it.
    if (this.mode === "armed" && this.d.autopilot.isDryRun) { this.lastResult = "idle: auto-pilot is in shadow — armed identification requires it live (Off/Armed switch)"; return; }
    const lastEnd = await this.d.store.lastIdentificationWindowEnd();
    if (lastEnd && nowMs - lastEnd.getTime() < MIN_GAP_MIN * 60_000) { this.lastResult = `idle: ${Math.round((MIN_GAP_MIN * 60_000 - (nowMs - lastEnd.getTime())) / 60_000)} min until the next window may open`; return; }
    const plans = await this.d.store.recentPlans(6);
    if (planConflictAhead(plans.at(-1)?.plan ?? null, nowMs, 3)) { this.lastResult = "idle: sanitize/bank/storm block within 3 h"; return; }
    await this.refreshPlan(nowMs);
    if (!this.plan || this.planFetchedAt == null || nowMs - this.planFetchedAt > PLAN_MAX_AGE_MIN * 60_000) { this.lastResult = "idle: no fresh identification plan"; return; }
    const cell = pickCell(this.plan, slx.outdoorF);
    this.eligibleNow = this.plan.cells.filter((c) => c.status === "unidentified" && c.suggest?.safeToProbe.ok && c.deliveryTypeSource === "owner_verified" && slx.outdoorF! >= c.band[0] && slx.outdoorF! < c.band[1]).length;
    if (!cell || !cell.suggest) { this.lastResult = `idle: no safe cell for ${slx.outdoorF} °F outdoor`; return; }

    // The base is the target the device is ACTUALLY driving to (temp1.target), and only when the last
    // command has been adopted: commanded and operative differ until the next reheat cycle, and a
    // window opened on a pending command records a base the plant never delivered and gets an
    // unlabelled transition mid-window (codex 2026-09-29 high). TempIQ's estimate is never the base
    // of a real window — with no settled operative target there is no window.
    const st = await this.d.writer.status().catch(() => ({} as Record<string, unknown>));
    const commanded = typeof st.commanded_target_f === "number" ? (st.commanded_target_f as number) : null;
    const operative = typeof st.target_f === "number" ? (st.target_f as number) : null;
    if (st.adoption_pending === true) { this.lastResult = `idle: last command (${commanded ?? "?"} °F) not yet adopted (operative ${operative ?? "?"} °F) — base not settled`; return; }
    if (operative == null || !Number.isFinite(operative)) { this.lastResult = "idle: no operative tank target from SensorLinx — base unknown"; return; }
    if (commanded != null && Math.abs(commanded - operative) > 3) { this.lastResult = `idle: commanded ${commanded} °F vs operative ${operative} °F disagree — base not settled`; return; }
    const baseF = Math.round(operative);
    const tgt = probeTarget({
      direction: cell.suggest.direction, baseF, magnitudeF: cell.suggest.magnitudeF,
      dhwFloorF: this.planQuery.dhwFloorF, strictCapF: this.planQuery.plantCapF, identificationCapF: this.planQuery.identificationCapF,
      aboveEverydayCap: cell.suggest.aboveEverydayCap === true || baseF + cell.suggest.magnitudeF > this.planQuery.plantCapF,
    });
    if (!tgt) { this.lastResult = `idle: ${cell.zoneName} ${cell.band}: step from ${baseF} °F would be < ${MIN_STEP_F} °F inside the bounds`; return; }
    const { arm, seed } = drawArm(cell.suggest.assignmentProbability, this.rng);
    const zoneIds = [...new Set(this.plan.cells.filter((c) => c.status !== "not_probeable" || c.deliveryTypeSource === "owner_verified").map((c) => c.zoneId))];
    const dryRun = this.mode === "shadow";
    const row: Omit<IdentWindow, "id"> = {
      state: arm === "hold" ? "active" : cell.suggest.direction === "down" ? "pending_write" : "arming",
      arm, direction: cell.suggest.direction, zoneIds, bandLo: cell.band[0], bandHi: cell.band[1],
      magnitudeF: tgt.stepF, baseF, targetF: arm === "probe" ? tgt.targetF : baseF, capF: tgt.capF,
      drawProbability: cell.suggest.assignmentProbability, drawSeed: seed,
      startedAt: this.now(), endedAt: null, endReason: null, durationMin: cell.suggest.durationMin,
      writeId: null, dryRun, postedOpen: false, postedClosed: false,
      cell, safeToProbe: cell.suggest.safeToProbe, armingTicks: 0, writeAttempts: 0,
      cleanupState: "none", cleanupDetail: null,
    };
    const id = await this.d.store.insertIdentificationWindow(row);
    const w: IdentWindow = { id, ...row };
    this.currentWindow = w;
    const label = `${cell.zoneName} [${cell.band[0]},${cell.band[1]}) ${arm === "probe" ? `${cell.suggest.direction} ${tgt.stepF} °F → ${tgt.targetF}` : `HOLD at ${baseF}`} (p=${cell.suggest.assignmentProbability}, u=${seed})`;
    // Hold the auto-pilot for the window in every arm (a hold arm is a hold of the base, too).
    this.d.autopilot.setHold(new Date(this.now().getTime() + (cell.suggest.durationMin + 30) * 60_000), `identification #${id}: ${label}`);
    if (arm === "hold") {
      this.lastResult = `${dryRun ? "SHADOW " : ""}hold arm #${id}: ${label}`;
      console.log(`[identify] ${this.lastResult}`);
      await this.postOpen(w);
      return;
    }
    if (cell.suggest.direction === "up") {
      // Lead the setpoints first; the write happens on a later tick once they cover the target.
      this.d.phaseB.setProbeTarget(dryRun ? null : tgt.targetF);
      this.lastResult = `${dryRun ? "SHADOW " : ""}arming #${id}: ${label} — waiting for Phase B to lead setpoints to ≥ ${tgt.targetF + DEFAULT_OPTS.i1MarginF} °F`;
      console.log(`[identify] ${this.lastResult}`);
      return;
    }
    await this.writeProbe(w, label);
  }

  private async continueArming(w: IdentWindow): Promise<void> {
    const ticks = w.armingTicks + 1;
    await this.d.store.updateIdentificationWindow(w.id, { armingTicks: ticks });
    w.armingTicks = ticks;
    if (w.dryRun) {
      // In shadow there is no setpoint lead to wait for — record what would have been written.
      await this.d.store.updateIdentificationWindow(w.id, { state: "active", startedAt: this.now() });
      w.state = "active"; w.startedAt = this.now();
      this.lastResult = `SHADOW would write ${w.targetF} °F (cap ${w.capF}) for #${w.id}`;
      console.log(`[identify] ${this.lastResult}`);
      await this.postOpen(w);
      return;
    }
    this.d.phaseB.setProbeTarget(w.targetF);
    let covered = false;
    try {
      const state = await this.d.hub.getState();
      const online = state.pumps.filter((p) => p.online);
      covered = online.length > 0 && online.every((p) => p.setpoint_c != null && cToF(p.setpoint_c) >= w.targetF + DEFAULT_OPTS.i1MarginF);
    } catch { covered = false; }
    if (!covered) {
      if (ticks >= ARMING_MAX_TICKS) { await this.end(w, "arming_timeout"); return; }
      this.lastResult = `arming #${w.id}: setpoints not yet ≥ ${w.targetF + DEFAULT_OPTS.i1MarginF} °F (tick ${ticks}/${ARMING_MAX_TICKS})`;
      return;
    }
    await this.d.store.updateIdentificationWindow(w.id, { state: "pending_write" });
    w.state = "pending_write";
    await this.writeProbe(w, `#${w.id} ${w.direction} → ${w.targetF}`);
  }

  /** A drawn probe whose write has not been accepted yet: retry (429) or give up (limit reached). */
  private async continuePendingWrite(w: IdentWindow): Promise<void> {
    // Keep the hold and the Phase B lead alive while the write is pending.
    this.d.autopilot.setHold(new Date(this.now().getTime() + (w.durationMin + 30) * 60_000), `identification #${w.id} ${w.arm} ${w.direction} (write pending)`);
    if (w.direction === "up" && !w.dryRun) this.d.phaseB.setProbeTarget(w.targetF);
    if (this.d.isI1Violated() || this.d.isStormActive()) { await this.end(w, "aborted:before_write"); return; }
    await this.writeProbe(w, `#${w.id} ${w.direction} → ${w.targetF}`);
  }

  private async writeProbe(w: IdentWindow, label: string): Promise<void> {
    if (w.dryRun) {
      await this.d.store.updateIdentificationWindow(w.id, { state: "active", startedAt: this.now() });
      w.state = "active"; w.startedAt = this.now();
      this.lastResult = `SHADOW would write ${w.targetF} °F (cap ${w.capF}): ${label}`;
      console.log(`[identify] ${this.lastResult}`);
      await this.postOpen(w);
      return;
    }
    const attempts = w.writeAttempts + 1;
    await this.d.store.updateIdentificationWindow(w.id, { writeAttempts: attempts });
    w.writeAttempts = attempts;
    try {
      await this.d.writer.setTarget(w.targetF, "identification", w.capF);
    } catch (e) {
      if (e instanceof WriteError && e.status === 429 && attempts < WRITE_RETRY_MAX) {
        // Stays pending_write: the next poll retries. Nothing is posted — an unwritten arm is not evidence.
        this.lastResult = `rate-limited writing ${w.targetF} °F for #${w.id} — retry next poll (${attempts}/${WRITE_RETRY_MAX})`;
        return;
      }
      await this.end(w, `write_rejected:${e instanceof WriteError ? e.status : "error"}:${(e as Error).message.slice(0, 80)}`);
      return;
    }
    const writeId = await this.d.store.latestAcceptedWriteId("identification");
    const startedAt = this.now();
    await this.d.store.updateIdentificationWindow(w.id, { state: "active", startedAt, writeId });
    w.state = "active"; w.startedAt = startedAt; w.writeId = writeId;
    this.lastResult = `ACTIVE #${w.id}: wrote ${w.targetF} °F (cap ${w.capF}) — ${label}`;
    console.log(`[identify] ${this.lastResult}`);
    await this.d.notify("Identification probe started", `${label}\nWindow ${w.durationMin} min; the auto-pilot is held; aborts on I1 / room deficit / DHW draw.`, "default");
    await this.postOpen(w);
  }

  private async continueActive(w: IdentWindow): Promise<void> {
    const nowMs = this.now().getTime();
    const startedMs = w.startedAt?.getTime() ?? nowMs;
    // Keep the auto-pilot held and Phase B leading for as long as the window runs.
    this.d.autopilot.setHold(new Date(startedMs + (w.durationMin + 30) * 60_000), `identification #${w.id} ${w.arm} ${w.direction}`);
    if (w.arm === "probe" && w.direction === "up" && !w.dryRun) this.d.phaseB.setProbeTarget(w.targetF);
    if (nowMs - startedMs >= w.durationMin * 60_000) { await this.end(w, "completed"); return; }
    if (this.mode === "off") { await this.end(w, "mode_off"); return; }
    const slx = await this.d.store.getLatestSlx();
    const slxFresh = !!slx && nowMs - slx.ts.getTime() <= SLX_FRESH_MS;
    let hubOnline = true;
    try { hubOnline = (await this.d.hub.getState()).pumps.some((p) => p.online); } catch { hubOnline = false; }
    let deficit: string[] = [];
    let draw = false;
    if (w.arm === "probe" && w.direction === "down") {
      await this.d.demandFeed.refresh();
      deficit = deficitZones(this.d.demandFeed.zones(), w.zoneIds);
      const series = await this.d.store.getRecentSeries(1);
      const draws = detectDrawTimes(series.filter((r) => r.tankF != null).map((r) => ({ ts: r.ts, tankF: r.tankF as number })));
      draw = draws.some((t) => nowMs - t.getTime() <= DRAW_LOOKBACK_MIN * 60_000);
    }
    const reason = abortReason({
      arm: w.arm, direction: w.direction, i1Violated: this.d.isI1Violated(), slxFresh, hubOnline,
      stormActive: this.d.isStormActive(), boostActive: !!(await this.d.store.activeBoost()), deficitZones: deficit, dhwDrawDetected: draw,
    });
    if (reason) { await this.end(w, `aborted:${reason}`); return; }
    const left = Math.round((startedMs + w.durationMin * 60_000 - nowMs) / 60_000);
    this.lastResult = `${w.dryRun ? "SHADOW " : ""}active #${w.id} ${w.arm} ${w.direction} @ ${w.targetF} °F — ${left} min left`;
  }

  private async end(w: IdentWindow, reason: string): Promise<void> {
    const endedAt = this.now();
    this.d.phaseB.setProbeTarget(null);
    this.d.autopilot.setHold(null, "");
    // A LIVE probe (a write was accepted) must be returned to its base by THIS driver — the auto-pilot
    // is not assumed to be live, and even live it may be rate-limited or rejected. Durable: 'pending'
    // is retried every tick until confirmed (codex 2026-09-29 critical).
    const wasLive = w.arm === "probe" && !w.dryRun && w.writeId != null;
    const cleanupState: CleanupState = wasLive ? "pending" : "none";
    await this.d.store.updateIdentificationWindow(w.id, { state: "ended", endedAt, endReason: reason, cleanupState });
    w.state = "ended"; w.endedAt = endedAt; w.endReason = reason; w.cleanupState = cleanupState;
    this.currentWindow = null;
    this.lastResult = `ended #${w.id} (${reason})`;
    console.log(`[identify] ${this.lastResult}`);
    const cleaned = wasLive ? await this.cleanup(w, reason.startsWith("aborted:")) : null;
    if (reason.startsWith("aborted:") && !w.dryRun) {
      await this.d.notify("Identification probe aborted", `#${w.id} ${w.arm} ${w.direction} @ ${w.targetF} °F: ${reason}${wasLive ? (cleaned ? ` — ${cleaned}` : " — plant NOT yet returned to base; retrying every poll") : ""}`, "high");
    }
    // Only a window that HAPPENED is closed on TempIQ: a hold arm (opened at the draw) or a probe whose
    // write was accepted. A probe that never got written is not evidence of anything — posting it
    // would file an awt_identification window with an assignment and no perturbation behind it.
    if (w.arm === "hold" || w.writeId != null) {
      await this.postClose(w);
    } else if (!w.dryRun) {
      await this.d.store.updateIdentificationWindow(w.id, { postedOpen: true, postedClosed: true }); // nothing to post
      w.postedOpen = true; w.postedClosed = true;
    }
  }

  /**
   * Return the plant to the window's base. First choice: a guarded re-command of baseF through the
   * same writer (I4/I1/rate limit/audit). When the rate limit refuses it — an abort inside 15 min of
   * the probe write — fall back to the as-found restore, the one write the rate limit never blocks;
   * for a down-probe abort that is the safe direction and for an up-probe it is only cost. Any other
   * failure stays 'pending' and is retried next tick.
   */
  private async cleanup(w: IdentWindow, urgent: boolean): Promise<string | null> {
    const done = async (detail: string): Promise<string> => {
      await this.d.store.updateIdentificationWindow(w.id, { cleanupState: "done", cleanupDetail: detail });
      w.cleanupState = "done"; w.cleanupDetail = detail;
      console.log(`[identify] cleanup #${w.id}: ${detail}`);
      return detail;
    };
    const stillPending = async (detail: string): Promise<null> => {
      await this.d.store.updateIdentificationWindow(w.id, { cleanupDetail: detail });
      w.cleanupDetail = detail;
      console.error(`[identify] cleanup #${w.id}: ${detail} — will retry`);
      return null;
    };
    try {
      await this.d.writer.setTarget(w.baseF, "identification-end", DEFAULT_OPTS.strictCapF);
      return await done(`re-commanded base ${w.baseF} °F`);
    } catch (e) {
      const rateLimited = e instanceof WriteError && e.status === 429;
      if (!rateLimited && !urgent) return stillPending(`re-command failed: ${(e as Error).message.slice(0, 120)}`);
    }
    try {
      await this.d.writer.restore(urgent ? "identification-abort" : "identification-end");
      return await done(`as-found curve restored (rate limit refused the base re-command${urgent ? "; abort" : ""})`);
    } catch (e) {
      return stillPending(`restore failed: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  private async cleanupPending(): Promise<void> {
    const rows = await this.d.store.cleanupPendingIdentificationWindows();
    for (const w of rows) await this.cleanup(w, false);
  }

  // ── TempIQ posting (fail-soft; unposted rows are retried each tick) ──
  private async refreshPlan(nowMs: number): Promise<void> {
    if (this.plan && this.planFetchedAt != null && nowMs - this.planFetchedAt < PLAN_REFRESH_MIN * 60_000) return;
    try {
      const q = this.planQuery;
      const url = `${this.d.baseUrl}/api/insights/identification-plan?abortLatencyMin=${q.abortLatencyMin}&dhwFloorF=${q.dhwFloorF}&plantCapF=${q.plantCapF}&identificationCapF=${q.identificationCapF}`;
      const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.d.token}` }, signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as IdentPlan;
      if (!Array.isArray(body?.cells)) throw new Error("malformed plan");
      this.plan = body;
      this.planFetchedAt = nowMs;
    } catch (e) {
      console.warn(`[identify] plan fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async postOpen(w: IdentWindow): Promise<void> {
    if (w.dryRun) return; // a shadow window is never posted — it did not happen
    const ok = await this.post([windowPayload(w, null)]);
    if (ok) { await this.d.store.updateIdentificationWindow(w.id, { postedOpen: true }); w.postedOpen = true; }
  }
  private async postClose(w: IdentWindow): Promise<void> {
    if (w.dryRun) return;
    const stats = w.startedAt ? await this.d.store.windowStats(w.startedAt, w.endedAt, w.targetF).catch(() => null) : null;
    const ok = await this.post([windowPayload(w, stats)]);
    if (ok) { await this.d.store.updateIdentificationWindow(w.id, { postedOpen: true, postedClosed: true }); w.postedOpen = true; w.postedClosed = true; }
  }
  private async postPending(): Promise<void> {
    const rows = await this.d.store.unpostedIdentificationWindows();
    for (const w of rows) {
      if (w.dryRun) continue;
      if (w.state === "ended") await this.postClose(w);
      else if (w.state === "active" && !w.postedOpen) await this.postOpen(w);
    }
  }
  private async post(windows: Record<string, unknown>[]): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.d.baseUrl}/api/insights/experiment-windows`, {
        method: "POST", headers: { Authorization: `Bearer ${this.d.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ windows }), signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => null)) as { upserted?: number; rejected?: Array<{ externalId: string; reason: string }> } | null;
      if (res.status === 200 && body && (body.rejected?.length ?? 0) === 0) { this.consecutivePostFailures = 0; return true; }
      const why = body?.rejected?.map((r) => `${r.externalId}: ${r.reason}`).join("; ") || `HTTP ${res.status}`;
      // A rejection is a contract drift, not a transient — say so loudly, but keep the row unposted so
      // the fix can be re-posted rather than lost.
      console.error(`[identify] TempIQ refused the window: ${why}`);
      this.consecutivePostFailures++;
      return false;
    } catch (e) {
      this.consecutivePostFailures++;
      if (this.consecutivePostFailures === 1 || this.consecutivePostFailures % 12 === 0) console.error(`[identify] post failed: ${e instanceof Error ? e.message : String(e)} (streak ${this.consecutivePostFailures})`);
      return false;
    }
  }
}
