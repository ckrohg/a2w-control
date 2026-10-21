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
 *
 * The plan lead (2026-10-20, after #220): the plan's term in the max() is what the auto-pilot COMMANDS for the
 * block in force — autopilot.commandForBlock. Under SHAPED_CURVE live a non-excursion block is commanded as its
 * stamped curve, so the lead is that curve's output at the live outdoor; an excursion (bank / soak / pre-boost /
 * storm) or a curve-less block is its flat tank_target_f, led exactly as before. Before this the lead read
 * block.tank_target_f, and on every "winter guard: mimic HBX curve" hour (tank_target_f 135 from the as-found
 * curve, stamped curve 120/118) both pumps were sent 60 °C while the plant sat at 120 °F — 13 of the 20 such
 * hours Oct 15–19 (identification-plan-vs-command-2026-10-20.md §5). A COP cost, never a safety issue; the
 * change keeps every lead at or above what the auto-pilot writes (planLeadF).
 */

import { HubClient } from "./hub";
import type { Notify } from "./alertpolicy";
import { Store } from "./store";
import { DEFAULT_OPTS } from "./shadow";
import { curveOutputF } from "./curve";
import { commandForBlock } from "./autopilot";

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

/**
 * #133 (b): with a SHAPED curve the operative target moves with outdoor between planner writes, so the
 * setpoints must lead the curve's OUTPUT — now and over the next hour of forecast — not the last commanded
 * scalar (setTarget's own Phase C caveat). Pure. null when the config is not a usable curve.
 */
export function curveLeadF(cfg: Record<string, any> | null, outdoorNowF: number | null, outdoorNextF: number | null): number | null {
  if (!cfg || [cfg.dot, cfg.wwsd, cfg.dbt, cfg.mbt].some((v) => typeof v !== "number")) return null;
  const c = { dot: cfg.dot as number, wwsd: cfg.wwsd as number, dbt: cfg.dbt as number, mbt: cfg.mbt as number };
  const outs = [outdoorNowF, outdoorNextF].filter((v): v is number => v != null && Number.isFinite(v)).map((o) => curveOutputF(c, o));
  return outs.length ? Math.max(...outs) : null;
}

/** The plan's contribution to the lead — planLeadF. Surfaced per cycle in /health.phase_b.lead. */
export interface PlanLead {
  /** the block in force: the auto-pilot's command for it (its curve's output, or its flat target), or its declared
   *  tank_target_f when the command cannot be evaluated (basis "declared") — never below what the auto-pilot writes */
  nowF: number | null;
  basis: "curve" | "flat" | "declared" | null;
  /** block.tank_target_f as declared — the lead before #220's resolver; kept beside nowF so /health shows the gap */
  declaredF: number | null;
  /** the NEXT block's command when it is a curve hour: its curve's output at its forecast outdoor. null for an
   *  excursion ahead — a soak / bank / pre-boost is led once its block is in force, as before, never an hour early */
  nextF: number | null;
  /** the next block's forecast outdoor, for the device-curve lead (curveLeadF) as before */
  nextOutdoorF: number | null;
}

const EMPTY_LEAD: PlanLead = { nowF: null, basis: null, declaredF: null, nextF: null, nextOutdoorF: null };

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * What the auto-pilot drives the plant to for `block`, as a LEAD: commandForBlock's number (#220 — the stamped
 * curve's output on a curve hour under SHAPED_CURVE live, tank_target_f flat otherwise), except that a curve hour
 * leads the curve's EXACT output rather than the resolver's whole-°F rounding: the setCurve I1 cross-check requires
 * setpoint ≥ exact output + margin, and the whole-°C ceil in computeTracking has zero slack at 117 / 126 / 135 /
 * 144 °F, so half a degree of rounding there would be an I1 refusal. null = nothing to lead (no finite
 * tank_target_f, or a curve hour with no outdoor to evaluate at).
 */
function commandLeadF(block: Record<string, any>, outdoorF: number | null, shapedCurve: boolean): { f: number; basis: "curve" | "flat" } | null {
  const cmd = commandForBlock(block, outdoorF, shapedCurve);
  if (!cmd) return null;
  if (cmd.basis !== "curve") return { f: cmd.targetF, basis: "flat" };
  const exact = curveLeadF(block.shaped_curve ?? null, outdoorF, null);
  return { f: Math.max(cmd.targetF, exact ?? -Infinity), basis: "curve" };
}

/**
 * Pure: the plan's lead terms for the block in force and the block after it.
 * (a) The block in force leads the auto-pilot's COMMAND for it (commandLeadF at the live outdoor; the block's own
 *     forecast outdoor stands in when there is no live reading). If that cannot be evaluated the declared
 *     tank_target_f leads, as it did before — the lead may overshoot, never undershoot, what the auto-pilot writes.
 * (b) The next block leads ITS command only when it is a curve hour (its curve's output at its forecast outdoor):
 *     the device's commanded curve, which curveLeadF reads, is a near-flat line after an excursion and would not
 *     cover the curve the auto-pilot writes back at the top of the hour.
 * (c) An excursion ahead (the daily soak, the bank, a pre-boost, a storm raise) is NOT led early: it is led from the
 *     moment its block is in force (its flat tank_target_f, as before) and the auto-pilot's write waits on the I1
 *     cross-check until the setpoints cover it — the same sequence as today, so the sanitize can never deadlock
 *     and the hour before it does not run hotter than it needs to.
 */
export function planLeadF(plan: any[] | null | undefined, nowMs: number, outdoorNowF: number | null, shapedCurve: boolean): PlanLead {
  if (!Array.isArray(plan) || plan.length === 0) return EMPTY_LEAD;
  let idx = 0;
  for (let n = 0; n < plan.length; n++) if (new Date(plan[n].ts).getTime() <= nowMs) idx = n;
  const block = plan[idx] ?? null;
  const next = plan[idx + 1] ?? null;
  const declaredF = num(block?.tank_target_f);
  const outdoorF = outdoorNowF ?? num(block?.outdoor_f);
  const cmd = block ? commandLeadF(block, outdoorF, shapedCurve) : null;
  const nextOutdoorF = num(next?.outdoor_f);
  const nextCmd = next ? commandLeadF(next, nextOutdoorF ?? outdoorF, shapedCurve) : null;
  return {
    nowF: cmd ? cmd.f : declaredF,
    basis: cmd ? cmd.basis : declaredF != null ? "declared" : null,
    declaredF,
    nextF: nextCmd?.basis === "curve" ? nextCmd.f : null,
    nextOutdoorF,
  };
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
  /** paging latch: a "tracking failing" page went out for the current failure run; cleared by success or a dry-run cycle */
  private alerted: Record<string, boolean> = {};
  /** recovery gate (codex pass 3 on #158): a failure page went out and its "recovered" page has not — survives a
   *  dry-run interlude (dry-run proves nothing was attempted, not that the failure recovered); cleared only by a
   *  successful ACTIVE write, which emits "Phase B recovered". */
  private recoveryPending: Record<string, boolean> = {};
  /** eval 2026-09-30 F4: consecutive write failures per pump, for /health — the alert fires at 3; the count says how long.
   *  Every configured pump is present (0 when never failed, or reset by a success or a dry-run cycle), so the map is a
   *  CURRENT count, never a sparse history. */
  streaks(): Record<string, number> { return Object.fromEntries(this.pumpIds.map((id) => [id, this.failStreak[id] ?? 0])); }
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
    private readonly notify: Notify,
    /** #133 (b): lead the shaped curve's output (SHAPED_CURVE=1). Off = the pre-#133 tracking, byte-identical. */
    private readonly shapedCurve = false,
    /** Graceful handover (2026-10-01): the pump setpoint goes through the hub, not writes.ts, so Phase B asks this
     *  before every send — a FRESH answer (the DB lease row, not a cached flag: a planner whose renews have been
     *  failing for 12 min may still believe it holds the lease while a successor has claimed it — codex pass 2 on
     *  #162), false while the planner does not hold the writer lease or is shutting down. */
    private readonly canWrite: () => Promise<boolean> = async () => true,
  ) {}

  /** Runtime override of the dry-run flag (W2-A) — flipped from the dashboard Off/Armed switch via
   *  the planner's controller_flags row each poll. The env value only seeds the constructor. */
  setDryRun(v: boolean): void { this.dryRun = v; }
  get isDryRun(): boolean { return this.dryRun; }

  // Identification probe target (identify.ts): an UP-probe above the operative target must be LED by
  // the setpoints exactly like the daily sanitize is led by the plan block — otherwise I1 rejects the
  // HBX write. Tracked through the same max() below, so it can only ever raise the setpoint.
  private probeTargetF: number | null = null;
  setProbeTarget(t: number | null): void { this.probeTargetF = t; }
  get probeTarget(): number | null { return this.probeTargetF; }

  /** The plan's lead terms from the latest shadow plan (planLeadF at the live outdoor, in this instance's shaped-curve
   *  mode — the same SHAPED_CURVE flag index.ts hands the AutoPilot, so the lead reads the block the way the auto-pilot
   *  writes it). Setpoints must LEAD the plan up (esp. the daily 140°F sanitize), or a rising target would deadlock
   *  I1. Empty on any read failure: the operative target and the device curve still lead. */
  private async currentPlanLead(outdoorNowF: number | null): Promise<PlanLead> {
    try {
      const plans = await this.store.recentPlans(6);
      return planLeadF(plans.at(-1)?.plan ?? null, Date.now(), outdoorNowF, this.shapedCurve);
    } catch {
      return EMPTY_LEAD;
    }
  }

  /** The terms of the last cycle's lead, for /health.phase_b.lead: the setpoints track the max of them (+ margin). */
  public lastLead: {
    at: string; effective_f: number; operative_f: number;
    plan_f: number | null; plan_basis: PlanLead["basis"]; plan_declared_f: number | null; next_f: number | null;
    probe_f: number | null; device_curve_f: number | null;
  } | null = null;

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
    const plan = await this.currentPlanLead(latest.outdoorF);
    // #133 (b): the DEVICE's commanded curve's output now and next hour — with a shaped curve the operative target
    // will climb on its own as it gets colder; the setpoints must already cover where it is going. Kept beside the
    // plan's command: the device may still be on an excursion's flat line, or on the as-found curve after a refused
    // set_curve, and the pumps must cover what the device is actually driving to.
    const curveLead = this.shapedCurve ? curveLeadF(await this.store.latestConfig().catch(() => null), latest.outdoorF, plan.nextOutdoorF) : null;
    const effectiveTarget = Math.max(opTarget, plan.nowF ?? -Infinity, plan.nextF ?? -Infinity, this.probeTargetF ?? -Infinity, curveLead ?? -Infinity);
    const r1 = (v: number | null): number | null => (v == null ? null : Math.round(v * 10) / 10);
    this.lastLead = {
      at: new Date().toISOString(), effective_f: r1(effectiveTarget) as number, operative_f: opTarget,
      plan_f: r1(plan.nowF), plan_basis: plan.basis, plan_declared_f: plan.declaredF, next_f: r1(plan.nextF),
      probe_f: this.probeTargetF, device_curve_f: r1(curveLead),
    };
    const decisions = computeTracking(effectiveTarget, this.pumpIds);
    this.lastRunAt = new Date().toISOString();

    for (const d of decisions) {
      if (this.dryRun) {
        // nothing was attempted, so nothing is failing — the streak and the PAGING latch reset so a later sustained
        // failure after the lane goes active again pages (codex pass 2 on #158); the RECOVERY gate stays, so the
        // operator still gets "recovered" once an active write succeeds (codex pass 3)
        this.failStreak[d.pump_id] = 0;
        this.alerted[d.pump_id] = false;
        this.lastResults[d.pump_id] = `DRY-RUN would send ${d.value_c}°C — ${d.reason}`;
        console.log(`[phase-b] ${this.lastResults[d.pump_id]}`);
        await this.store.insertPhaseBLog({ pumpId: d.pump_id, mode: "dry-run", valueC: d.value_c, result: "would-send" }).catch(() => {});
        continue;
      }
      if (!(await this.canWrite().catch(() => false))) {
        // not this planner's turn (lease not held) or the process is handing over — do not touch the pumps; the
        // streak is untouched because nothing was attempted (a lease gap is not a Modbus failure)
        this.lastResults[d.pump_id] = `skipped ${d.value_c}°C — writer lease not held / handing over`;
        await this.store.insertPhaseBLog({ pumpId: d.pump_id, mode: "active", valueC: d.value_c, result: "skipped: no writer lease" }).catch(() => {});
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
        this.alerted[d.pump_id] = false;
        if (this.recoveryPending[d.pump_id]) {
          this.recoveryPending[d.pump_id] = false;
          await this.notify("Phase B recovered", `${d.pump_id} tracking again (${d.value_c}°C).`, "default",
            { tier: "attention", resolved: true, key: `phaseb-failing-${d.pump_id}` });
        }
      } else {
        this.failStreak[d.pump_id] = (this.failStreak[d.pump_id] ?? 0) + 1;
        console.warn(`[phase-b] ${d.pump_id} write failed (${this.failStreak[d.pump_id]}): ${res.detail}`);
        // 3 consecutive cycle failures ≈ 15 min without a renewal — lease will lapse to
        // baseline on its own (safe); page once so a human knows tracking stopped.
        if (this.failStreak[d.pump_id] === 3 && !this.alerted[d.pump_id]) {
          this.alerted[d.pump_id] = true;
          this.recoveryPending[d.pump_id] = true;
          await this.notify(
            "Phase B tracking failing",
            `${d.pump_id}: 3 consecutive write failures (${res.detail}). ` +
              (this.leaseArmed[d.pump_id] === false
                ? "⚠ NO LEASE IS ARMED on the Pi — the setpoint will NOT revert to baseline; " +
                  "it will stay where it is. See FINDING-1."
                : "Lease will lapse to baseline — house safe, savings paused."),
            "high",
            // a lapsed lease reverts to baseline on its own: record. Only with no lease armed is a human needed.
            { tier: this.leaseArmed[d.pump_id] === false ? "attention" : "record", key: `phaseb-failing-${d.pump_id}`,
              action: "Check the Pi is online (dashboard), then follow the FINDING-1 runbook to set baseline_setpoint_c on the Pi." },
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
          await this.notify("Phase B lease armed", `${id}: the Pi is now holding a lease again.`, "default",
            { tier: "attention", resolved: true, key: `phaseb-nolease-${id}` });
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
            // latched in the DB: this used to re-send for each pump on every planner redeploy (60 emails in a month)
            { tier: "attention", key: `phaseb-nolease-${id}`,
              action: "Follow the FINDING-1 runbook: set baseline_setpoint_c in the Pi's config so the safety revert can work." },
          );
        }
      }
    }
  }
}
