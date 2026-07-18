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

const APPLY_TOLERANCE_F = 2; // don't rewrite if the plan target is within this of the commanded

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
  ) {}

  /** Runtime override of the dry-run flag (W2-A). The env value only seeds the constructor; the
   *  dashboard Off/Armed switch flips this via the planner's controller_flags row each poll. */
  setDryRun(v: boolean): void { this.dryRun = v; }
  get isDryRun(): boolean { return this.dryRun; }

  /** Set lastResult and record to autopilot_log only when the decision changes (keeps the table small). */
  private async record(target: number | null, reason: string, result: string, verbose: string): Promise<void> {
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

    // Skip if already commanded there — avoids curve churn and needless rate-limit rejections.
    const status = await this.writer.status();
    const commanded = status.commanded_target_f as number | null;
    if (commanded != null && Math.abs(commanded - target) <= APPLY_TOLERANCE_F) {
      await this.record(target, reason, "held", `holding ${target}°F (${reason}) — already commanded`);
      return;
    }

    if (this.dryRun) {
      await this.record(target, reason, "would-set", `DRY-RUN would set ${target}°F — ${reason} (commanded now ${commanded ?? "—"}°F)`);
      console.log(`[autopilot] ${this.lastResult}`);
      return;
    }

    try {
      // A plan target above the everyday strictCap is the daily sanitize excursion — allow it up to
      // sanitizeCapF (only sanitize produces >strictCap in the plan). I1 in setTarget still guards it.
      const capF = target > DEFAULT_OPTS.strictCapF ? DEFAULT_OPTS.sanitizeCapF : DEFAULT_OPTS.strictCapF;
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
