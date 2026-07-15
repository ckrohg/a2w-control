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
  const raw = Math.round(fToC(requiredF));
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
  public lastRunAt: string | null = null;
  public lastResults: Record<string, string> = {};

  constructor(
    private readonly store: Store,
    private readonly hub: HubClient,
    private readonly pumpIds: string[],
    private readonly dryRun: boolean,
    private readonly notify: (title: string, body: string, priority?: string) => Promise<void>,
  ) {}

  async runOnce(): Promise<void> {
    const latest = await this.store.getLatestSlx();
    if (!latest || latest.targetF == null || Date.now() - latest.ts.getTime() > SLX_FRESH_MS) {
      this.lastResults = { _skip: "no fresh HBX target — not tracking on stale data" };
      return;
    }
    const decisions = computeTracking(latest.targetF, this.pumpIds);
    this.lastRunAt = new Date().toISOString();

    for (const d of decisions) {
      if (this.dryRun) {
        this.lastResults[d.pump_id] = `DRY-RUN would send ${d.value_c}°C — ${d.reason}`;
        console.log(`[phase-b] ${this.lastResults[d.pump_id]}`);
        await this.store.insertPhaseBLog({ pumpId: d.pump_id, mode: "dry-run", valueC: d.value_c, result: "would-send" }).catch(() => {});
        continue;
      }
      const res = await this.hub.sendSetpoint(d.pump_id, d.value_c, LEASE_MINUTES, "phase-b");
      this.lastResults[d.pump_id] = res.ok
        ? `ok ${d.value_c}°C (lease ${LEASE_MINUTES}m)`
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
            `${d.pump_id}: 3 consecutive write failures (${res.detail}). Lease will lapse to baseline — house safe, savings paused.`,
            "high",
          );
        }
      }
    }
  }
}
