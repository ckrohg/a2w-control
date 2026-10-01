/**
 * @purpose Auto-pilot (the end-state of §5/§7): continuously drive the HBX buffer TARGET to the
 * shadow plan's current-hour tank_target_f, so the buffer tracks demand + weather (TempIQ-enriched
 * via the demand floor) instead of a fixed manual value — the target-side twin of Phase B's
 * setpoint tracking. Applies through the SINGLE guarded writer.setTarget (I4 envelope clamp, I1
 * cross-check against live setpoints, sanitize floor, 15-min rate limit) so a bad plan can never
 * push an unsafe target. FLAG-OFF by default: AUTOPILOT_ENABLED=1 turns it on; AUTOPILOT_DRY_RUN=1
 * computes + logs what it WOULD set without writing. A2W stays STANDALONE — the shadow plan falls
 * back to the HBX reset curve if TempIQ is down, so the auto-pilot never hard-depends on TempIQ.
 * Every decision is recorded to autopilot_log (dedup'd on change) so the dashboard can show it.
 */

import { Store } from "./store";
import { HbxWriter, WriteError } from "./writes";
import { DEFAULT_OPTS } from "./shadow";
import { sameCurve, type ShapedCurve } from "./curve";

const APPLY_TOLERANCE_F = 2; // don't rewrite if the plan target is within this of the commanded

export type CurveDecision =
  | { kind: "excursion"; reason: string }                       // bank / soak / storm / boost hour → a flat target on top
  | { kind: "curve"; curve: ShapedCurve; reason: string }        // the shaped curve is the command for this hour
  | { kind: "no_curve"; reason: string };                        // the plan carries no shaped curve (feed degraded, mode off)

/**
 * #133 (b), pure: what the auto-pilot commands for the current plan block in shaped-curve mode. An
 * excursion hour (the plan flagged it, or its reason names one) keeps today's flat-target write on top
 * of the curve; every other hour the SHAPED curve is the command — written only when its endpoints
 * differ from the commanded ones (sameCurve, dot included), which is a few times a season, not hourly.
 */
/**
 * Is the plan's curve already the one the device holds? All FOUR endpoints must agree — dot, dbt, mbt
 * within the adoption tolerance and wwsd within 0.5 °F (codex pass 2 on #145: comparing three of them
 * let a wwsd drift read as "held" and never reach setCurve's stale-plan guard).
 */
export function curveAlreadyInForce(curve: ShapedCurve, inForce: { dot?: unknown; wwsd?: unknown; dbt?: unknown; mbt?: unknown } | null | undefined, toleranceF = APPLY_TOLERANCE_F): boolean {
  if (!inForce) return false;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  return sameCurve(curve, { dbt: n(inForce.dbt), mbt: n(inForce.mbt) }, toleranceF)
    && Math.abs(n(inForce.dot) - curve.dot) <= toleranceF
    && Math.abs(n(inForce.wwsd) - curve.wwsd) <= 0.5;
}

export function curveDecision(block: { reason?: unknown; sani?: unknown; bank?: unknown; boost?: unknown; shaped_curve?: unknown } | null | undefined): CurveDecision {
  const reason = String(block?.reason ?? "");
  // The flags are authoritative; the reason regex is the fallback for blocks written before the flags
  // were emitted. (#135: a winter pre-boost's reason can be rewritten by the demand floor — the flag
  // must still make it an excursion, or shaped-curve mode would run the curve through the boost hour.)
  if (block?.sani === true || block?.bank === true || block?.boost === true || /sanitize|storm|bank|boost|pre-?charge/i.test(reason)) {
    return { kind: "excursion", reason };
  }
  const c = block?.shaped_curve as Partial<ShapedCurve> | undefined;
  if (!c || [c.dot, c.wwsd, c.dbt, c.mbt].some((v) => typeof v !== "number")) return { kind: "no_curve", reason: reason || "plan block carries no shaped curve" };
  return { kind: "curve", curve: c as ShapedCurve, reason };
}

export class AutoPilot {
  public lastRunAt: string | null = null;
  public lastResult = "not run yet";
  public lastTargetF: number | null = null; // most recent decided target — surfaced in the heartbeat
  private lastLogged: string | null = null;

  constructor(
    private readonly store: Store,
    private readonly writer: HbxWriter,
    private dryRun: boolean,
    private readonly notify: (title: string, body: string, priority?: string) => Promise<void>,
    /** #133 (b): command the plan's shaped curve for non-excursion hours (env SHAPED_CURVE=1). */
    private readonly shapedCurve = false,
    /** §6.11 storm shaping may raise a block up to this (env STORM_CAP_F, default = the everyday cap). */
    private readonly stormCapF: number = DEFAULT_OPTS.strictCapF,
  ) {}

  /** Runtime override of the dry-run flag (W2-A). The env value only seeds the constructor; the
   *  dashboard Off/Armed switch flips this via the planner's controller_flags row each poll. */
  setDryRun(v: boolean): void { this.dryRun = v; }
  get isDryRun(): boolean { return this.dryRun; }

  // Identification hold (identify.ts): while a randomised AWT window runs, the auto-pilot must not
  // overwrite the arm — a probe that gets re-commanded to the plan target after 10 min is not a
  // perturbation, and a hold arm that the plan moves is not a control. Time-bounded so a crashed
  // driver cannot freeze the auto-pilot: past `until` the hold lapses on its own.
  private holdUntil: number | null = null;
  private holdReason = "";
  setHold(until: Date | null, reason: string): void {
    this.holdUntil = until ? until.getTime() : null;
    this.holdReason = reason;
  }
  get holdActive(): boolean { return this.holdUntil != null && Date.now() < this.holdUntil; }

  /** Set lastResult and record to autopilot_log only when the decision changes (keeps the table small). */
  private async record(target: number | null, reason: string, result: string, verbose: string, _block?: Record<string, unknown> | null): Promise<void> {
    this.lastResult = verbose;
    this.lastTargetF = target;
    const key = `${result}|${target}`;
    if (key !== this.lastLogged) {
      this.lastLogged = key;
      await this.store.insertAutopilotLog({ targetF: target, reason, result, dryRun: this.dryRun }).catch(() => {});
    }
  }

  /** Pick the shadow plan's current-hour target and apply it (guarded). Called each poll cycle. */
  async applyLatestPlan(): Promise<void> {
    const plans = await this.store.recentPlans(6);
    const latest = plans.at(-1);
    if (!latest || !Array.isArray(latest.plan) || latest.plan.length === 0) {
      this.lastResult = "no recent shadow plan";
      return;
    }
    const now = Date.now();
    const block =
      latest.plan.filter((b: { ts: string }) => new Date(b.ts).getTime() <= now).at(-1) ?? latest.plan[0];
    const target = Number(block?.tank_target_f);
    if (!Number.isFinite(target)) {
      this.lastResult = "plan block missing tank_target_f";
      return;
    }
    const reason = String(block?.reason ?? "");
    this.lastRunAt = new Date().toISOString();

    if (this.holdActive) {
      await this.record(target, reason, "held", `held for ${this.holdReason} — plan wants ${target}°F, not applied`);
      return;
    }
    const status = await this.writer.status();
    const commanded = status.commanded_target_f as number | null;
    // #133 (b): in shaped mode classify the block FIRST. The scalar "already commanded" check below must
    // never decide a curve hour: after an excursion's near-flat write, a plan target within 2 °F of that
    // flat midpoint would otherwise read as held forever and the curve would never come back (codex).
    const curveHour = this.shapedCurve ? curveDecision(block) : null;
    // Skip if already commanded there — avoids curve churn and needless rate-limit rejections.
    if (curveHour?.kind !== "curve" && commanded != null && Math.abs(commanded - target) <= APPLY_TOLERANCE_F) {
      await this.record(target, reason, "held", `holding ${target}°F (${reason}) — already commanded`);
      return;
    }

    // #133 (b): in shaped-curve mode a non-excursion hour commands the CURVE, not a flat target. The
    // comparison is on the endpoints (dot/dbt/mbt) the device holds, so the curve is rewritten only when
    // it changes — a few times a season.
    if (curveHour) {
      const d = curveHour;
      if (d.kind === "curve") {
        const same = curveAlreadyInForce(d.curve, status.curve_in_force as { dot?: unknown; wwsd?: unknown; dbt?: unknown; mbt?: unknown } | null);
        const label = `curve ${d.curve.dbt}@${d.curve.dot}→${d.curve.mbt}@${d.curve.wwsd}`;
        if (same) {
          await this.record(target, reason, "held-curve", `holding ${label} (${reason}) — already commanded`);
          return;
        }
        if (this.dryRun) {
          await this.record(target, reason, "would-set-curve", `DRY-RUN would command ${label} — ${reason}`);
          console.log(`[autopilot] ${this.lastResult}`);
          return;
        }
        try {
          await this.writer.setCurve(d.curve, "autopilot");
          await this.record(target, reason, "set-curve", `commanded ${label} — ${reason}`);
          console.log(`[autopilot] ${this.lastResult}`);
        } catch (e) {
          if (e instanceof WriteError && e.status === 429) {
            await this.record(target, reason, "rate-limited", `rate-limited, retry next cycle → ${label} (${reason})`);
            return;
          }
          const msg = e instanceof WriteError ? e.message : (e as Error).message;
          await this.record(target, reason, `rejected: ${msg}`, `rejected ${label}: ${msg}`);
          console.warn(`[autopilot] ${this.lastResult}`);
        }
        return;
      }
      // excursion or no curve → the flat target write below, exactly as before
    }
    if (this.dryRun) {
      await this.record(target, reason, "would-set", `DRY-RUN would set ${target}°F — ${reason} (commanded now ${commanded ?? "—"}°F)`);
      console.log(`[autopilot] ${this.lastResult}`);
      return;
    }

    // a2w#156: the block's IDENTITY authorises its ceiling, never the target's size. The soak (`sani`) may run to
    // sanitizeCapF; a storm block (`storm`, §6.11) to STORM_CAP_F (owner-configured, 135 by default); everything else
    // is clamped to the everyday cap by the plan, so an unflagged target above it means the plan and the auto-pilot
    // disagree about what this hour is — refuse it (fail closed, logged) instead of writing it under an excursion's
    // ceiling. Identification probes do not pass through here (identify.ts writes with its own cap).
    const capF = block?.sani === true ? DEFAULT_OPTS.sanitizeCapF
      : block?.storm === true ? Math.max(DEFAULT_OPTS.strictCapF, this.stormCapF)
      : DEFAULT_OPTS.strictCapF;
    if (target > capF) {
      await this.record(target, reason, `rejected: ${block?.storm === true ? "storm" : "non-soak"} block above its cap`, `rejected ${target}°F: ${block?.storm === true ? "storm block above STORM_CAP_F" : "non-soak block above the everyday cap"} ${capF}°F (${reason})`, block);
      console.warn(`[autopilot] ${this.lastResult}`);
      return;
    }
    try {
      await this.writer.setTarget(target, "autopilot", capF);
      await this.record(target, reason, "set", `set ${target}°F — ${reason}`);
      console.log(`[autopilot] ${this.lastResult}`);
    } catch (e) {
      if (e instanceof WriteError && e.status === 429) {
        // The 15-min rate limit — expected when the plan changes faster than we may write. Not an error.
        await this.record(target, reason, "rate-limited", `rate-limited, retry next cycle → ${target}°F (${reason})`);
        return;
      }
      const msg = e instanceof WriteError ? e.message : (e as Error).message;
      // I4/I1 rejections are the guardrails doing their job — log, don't page. Sustained failure is
      // caught by the standing I1 monitor + the adoption monitor.
      await this.record(target, reason, `rejected: ${msg}`, `rejected ${target}°F: ${msg}`);
      console.warn(`[autopilot] ${this.lastResult}`);
    }
  }
}
