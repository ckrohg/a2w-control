/**
 * @purpose Phase B — the tracking loop (plan §7): every poll cycle, each enrolled pump's
 * setpoint is driven to (live HBX tank target + I1 margin), LEASED through the hub so a
 * dead planner lapses back to the Pi's baseline (the §4 degradation ladder — never a
 * stale optimizer value). Renewals ride the Pi's renew-without-rewrite (same value =
 * lease refresh only, no EEPROM churn, no audit spam). FLAG-OFF by default:
 * PHASE_B_ENABLED=1 turns it on; PHASE_B_DRY_RUN=1 computes and logs without sending.
 * Rollback = unset the flag → leases lapse → Pi reverts to baseline_setpoint_c on its own.
 *
 * Guards, in order: fresh SensorLinx reading required (no tracking on stale targets);
 * whole-°C rounding gives natural hysteresis vs the continuously-moving curve target;
 * clamp to [floor 45 °C, cap 55 °C] — if the required setpoint exceeds the cap we send
 * the cap (best achievable) and the standing I1 monitor raises the alarm; per-pump
 * results are edge-alerted via ntfy only on sustained failure, never per write.
 */

import { HubClient } from "./hub";
import { Store } from "./store";
import { DEFAULT_OPTS } from "./shadow";

const SLX_FRESH_MS = 15 * 60 * 1000;
const LEASE_MINUTES = 90;
const FLOOR_C = 45; // unattended_min_setpoint_c — the Pi enforces this too
// 75 = the bridge config clamp. NOT the reg-2027 factory default (55): these units run
// with 2027 raised (the Pi accepted 68/71 °C writes on 2026-07-14), and a 55 cap here
// would clamp tracking BELOW the as-found curve target — manufacturing the exact
// deadlock Phase B prevents (caught by the first dry-run). The Pi's live bounds remain
// authoritative; this only avoids pointless nacks. Override: PHASE_B_CAP_C.
const CAP_C = Number(process.env.PHASE_B_CAP_C ?? "75");

const fToC = (f: number) => ((f - 32) * 5) / 9;

export interface TrackDecision {
  pump_id: string;
  value_c: number;
  reason: string;
}

/** Pure: what should each enrolled pump's setpoint be right now? */
export function computeTracking(
  targetF: number,
  pumpIds: string[],
  marginF: number = DEFAULT_OPTS.i1MarginF,
): TrackDecision[] {
  const requiredF = targetF + marginF;
  // CEIL, not round: setpoints are sent as whole °C, and round-to-nearest can land the setpoint
  // ~0.2°F BELOW target+margin (e.g. 140.2°F → 60.1°C → round 60°C = 140.0°F < 140.2), tripping the
  // I1 monitor for a phantom shortfall. Ceil sends the smallest whole °C that still covers
  // target+margin — I1 guaranteed, minimal COP cost (≤1.8°F above the ideal setpoint).
  const raw = Math.ceil(fToC(requiredF));
  const value = Math.min(Math.max(raw, FLOOR_C), CAP_C);
  const note =
    raw > CAP_C ? ` (required ${raw}°C exceeds cap ${CAP_C} — sending cap; I1 monitor will flag)` :
    raw < FLOOR_C ? ` (required ${raw}°C below floor ${FLOOR_C} — floor applied)` : "";
  return pumpIds.map((pump_id) => ({
    pump_id,
    value_c: value,
    reason: `track: HBX target ${targetF.toFixed(1)}°F + ${marginF}°F margin → ${value}°C${note}`,
  }));
}

export class PhaseB {
  private failStreak: Record<string, number> = {};
  private alerted: Record<string, boolean> = {};
  /** Per-pump: did the Pi actually ARM the lease we asked for? null = not yet observed.
   *  See verifyLeases() — this is the FINDING-1b fix. */
  private leaseArmed: Record<string, boolean | null> = {};
  private leaseAlerted: Record<string, boolean> = {};
  public lastRunAt: string | null = null;
  public lastResults: Record<string, string> = {};

  constructor(
    private readonly store: Store,
    private readonly hub: HubClient,
    private readonly pumpIds: string[],
    private dryRun: boolean,
    private readonly notify: (title: string, body: string, priority?: string) => Promise<void>,
  ) {}

  /** Runtime override of the dry-run flag (W2-A) — flipped from the dashboard Off/Armed switch via
   *  the planner's controller_flags row each poll. The env value only seeds the constructor. */
  setDryRun(v: boolean): void { this.dryRun = v; }
  get isDryRun(): boolean { return this.dryRun; }

  /** Current-hour tank target from the latest shadow plan — setpoints must LEAD the plan up (esp.
   *  the daily 140°F sanitize), or a rising target would deadlock I1. null if no usable plan. */
  private async currentPlanTarget(): Promise<number | null> {
    try {
      const plans = await this.store.recentPlans(6);
      const latest = plans.at(-1);
      if (!latest || !Array.isArray(latest.plan) || latest.plan.length === 0) return null;
      const now = Date.now();
      const block =
        latest.plan.filter((b: { ts: string }) => new Date(b.ts).getTime() <= now).at(-1) ?? latest.plan[0];
      const t = Number(block?.tank_target_f);
      return Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  }

  async runOnce(): Promise<void> {
    const latest = await this.store.getLatestSlx();
    if (!latest || latest.targetF == null || Date.now() - latest.ts.getTime() > SLX_FRESH_MS) {
      this.lastResults = { _skip: "no fresh HBX target — not tracking on stale data" };
      return;
    }
    // Track the HIGHER of the operative target and the planned current-hour target so the setpoints
    // LEAD an upward move (the daily sanitize to 140°F): the pump can serve the new target the instant
    // the auto-pilot commands it, instead of a target-up / setpoint-lagging I1 deadlock. max() never
    // drops the setpoint below tracking the operative target, so I1 is only ever strengthened.
    const opTarget = latest.targetF;
    const planTarget = await this.currentPlanTarget();
    const effectiveTarget = planTarget != null ? Math.max(opTarget, planTarget) : opTarget;
    const decisions = computeTracking(effectiveTarget, this.pumpIds);
    this.lastRunAt = new Date().toISOString();

    for (const d of decisions) {
      if (this.dryRun) {
        this.lastResults[d.pump_id] = `DRY-RUN would send ${d.value_c}°C — ${d.reason}`;
        console.log(`[phase-b] ${this.lastResults[d.pump_id]}`);
        await this.store.insertPhaseBLog({ pumpId: d.pump_id, mode: "dry-run", valueC: d.value_c, result: "would-send" }).catch(() => {});
        continue;
      }
      const res = await this.hub.sendSetpoint(d.pump_id, d.value_c, LEASE_MINUTES, "phase-b");
      // NB: this string is provisional — it records what we ASKED for. verifyLeases() below
      // overwrites it with what the Pi actually did. Reporting the request as though it were
      // the outcome is exactly what hid FINDING-1 for two months (FINDING-1b).
      this.lastResults[d.pump_id] = res.ok
        ? `ok ${d.value_c}°C (lease ${LEASE_MINUTES}m requested)`
        : `failed: ${res.detail}`;
      await this.store.insertPhaseBLog({ pumpId: d.pump_id, mode: "active", valueC: d.value_c, result: res.ok ? "sent" : `failed: ${res.detail}` }).catch(() => {});
      if (res.ok) {
        this.failStreak[d.pump_id] = 0;
        if (this.alerted[d.pump_id]) {
          this.alerted[d.pump_id] = false;
          await this.notify("Phase B recovered", `${d.pump_id} tracking again (${d.value_c}°C).`);
        }
      } else {
        this.failStreak[d.pump_id] = (this.failStreak[d.pump_id] ?? 0) + 1;
        console.warn(`[phase-b] ${d.pump_id} write failed (${this.failStreak[d.pump_id]}): ${res.detail}`);
        // 3 consecutive cycle failures ≈ 15 min without a renewal — lease will lapse to
        // baseline on its own (safe); page once so a human knows tracking stopped.
        if (this.failStreak[d.pump_id] === 3 && !this.alerted[d.pump_id]) {
          this.alerted[d.pump_id] = true;
          await this.notify(
            "Phase B tracking failing",
            `${d.pump_id}: 3 consecutive write failures (${res.detail}). ` +
              (this.leaseArmed[d.pump_id] === false
                ? "⚠ NO LEASE IS ARMED on the Pi — the setpoint will NOT revert to baseline; " +
                  "it will stay where it is. See FINDING-1."
                : "Lease will lapse to baseline — house safe, savings paused."),
            "high",
          );
        }
      }
    }
    await this.verifyLeases(decisions.map((d) => d.pump_id));
  }

  /**
   * FINDING-1b — report what the Pi DID, not what we asked for.
   *
   * The Pi records a setpoint lease only `if lease_minutes and baseline_setpoint_c is not
   * None` (poller.py:600). With baseline_setpoint_c unset the lease is silently dropped:
   * check_lease() then returns early every tick, so the revert to baseline, its "optimizer
   * stale" alert, and the 15-min warning can never fire. Before this, Phase B rendered
   * "lease 90m" from its own LEASE_MINUTES constant regardless — so /health asserted a
   * failsafe that did not exist, and two months of green dashboards hid it.
   *
   * Best-effort: a hub read failure must never break tracking, so we leave the provisional
   * string in place and try again next cycle.
   */
  private async verifyLeases(pumpIds: string[]): Promise<void> {
    let pumps;
    try {
      pumps = (await this.hub.getState()).pumps;
    } catch (e) {
      console.warn(`[phase-b] lease verify skipped (hub read failed): ${(e as Error).message}`);
      return;
    }
    for (const id of pumpIds) {
      const p = pumps.find((x) => x.id === id);
      // Field absent (older hub build) is UNKNOWN, not "unarmed" — don't cry wolf.
      if (!p || p.remote_lease_until === undefined) continue;
      const armed = p.remote_lease_until !== null;
      this.leaseArmed[id] = armed;
      const prev = this.lastResults[id] ?? "";
      if (!prev.startsWith("ok ")) continue; // the write itself failed; that message wins
      if (armed) {
        const mins = Math.max(0, Math.round((p.remote_lease_until! * 1000 - Date.now()) / 60000));
        this.lastResults[id] = `${prev.replace(/ \(lease .*\)$/, "")} (lease ${mins}m armed)`;
        if (this.leaseAlerted[id]) {
          this.leaseAlerted[id] = false;
          await this.notify("Phase B lease armed", `${id}: the Pi is now holding a lease again.`);
        }
      } else {
        this.lastResults[id] = `${prev.replace(/ \(lease .*\)$/, "")} — ⚠ NO LEASE ARMED`;
        console.warn(`[phase-b] ${id}: wrote setpoint but the Pi armed NO lease — ` +
          "baseline_setpoint_c is unset, revert-to-baseline cannot fire (FINDING-1)");
        if (!this.leaseAlerted[id]) {
          this.leaseAlerted[id] = true;
          await this.notify(
            "⚠ Phase B: no lease armed",
            `${id}: setpoint accepted but the Pi recorded NO lease, so baseline_setpoint_c is ` +
              "unset and the revert-to-baseline failsafe cannot fire. The house is not at " +
              "immediate risk (it holds the last warm setpoint) but there is no automatic " +
              "recovery from a dead planner. See the FINDING-1 runbook.",
            "high",
          );
        }
      }
    }
  }
}
