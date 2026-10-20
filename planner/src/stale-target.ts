/**
 * @purpose The stale-report verdict for the SensorLinx tank target (knowledge/reference/stale-slx-target-2026-10-19.md).
 * `temps.temp1.target` is NOT the operative target. The device refreshes it while a stage is called and at call
 * boundaries; while idle it freezes at the last value it computed. After a LOWERING command the device stops
 * calling at once (it is on the new curve) but keeps REPORTING the old, higher target until the tank has decayed to
 * the NEW call threshold — 7–16 h after every sanitize soak and afternoon bank: 54 stretches ≥ 3 h since 2026-07-16,
 * and writer.status().adoption_pending was true for 49 % of the samples in the identification driver's first three
 * armed days. The proof that a report is stale is physical, not a timeout: the tank sits more than htDif/2 (+1 °F
 * slack) below the reported target, heat demand is present and no stage has been called for several polls — a
 * device really driving to that target would have called. Then the operative target is the curve in force (its
 * output at the live outdoor, else the commanded midpoint), and the identification driver, plan_scores and the
 * identification-window compliance read that instead of the frozen report. Pure: no I/O, no clock.
 */

/** writes.ts status(): adoption_pending = |commanded − reported| > this. The same tolerance everywhere. */
export const ADOPTION_TOLERANCE_F = 3;
/** Consecutive idle polls (5 min each) with the tank below the reported call threshold before the report is called stale. */
export const STALE_REPORT_MIN_POLLS = 3;
/** The polls must be recent — three five-minute polls plus slack for a slow SensorLinx read or one missed poll. */
export const STALE_REPORT_MAX_AGE_MS = 20 * 60_000;
/** The HBX's hot-tank differential as found (hbx-config-asfound-20260713.json: htDif 4) — used only when the live config lacks it. */
export const DEFAULT_HT_DIF_F = 4;

/**
 * How far below the reported target the tank must sit before "no call" proves the device is not driving to it:
 * the call-on threshold is target − htDif/2 (calls start at 117.5–118.7 °F for a 119.5 °F target in the mirror),
 * plus 1 °F slack for the 5-min sampling and the sensor frame the cloud shows a poll late.
 */
export function staleTankMarginF(htDifF: number | null | undefined): number {
  const d = typeof htDifF === "number" && Number.isFinite(htDifF) && htDifF > 0 ? htDifF : DEFAULT_HT_DIF_F;
  return d / 2 + 1;
}
/** The margin at the as-found differential — what the SQL paths (plan_scores, window compliance) use. */
export const STALE_TANK_MARGIN_DEFAULT_F = staleTankMarginF(null);

/** One 5-min poll as store.getRecentSeries returns it (hdActive is optional so older fakes still type-check). */
export interface RecentPoll { ts: Date; tankF: number | null; anyCall: boolean; hdActive?: boolean | null }

export type StaleReportVerdict =
  /** The report agrees with the command within tolerance, sits BELOW it (a raise — no idle proof exists), or inputs are missing. */
  | { kind: "not_applicable" }
  /** The report sits above the command, but the idle-below-threshold proof is incomplete; `why` says what is missing. */
  | { kind: "unproven"; why: string }
  /** The report is provably stale: the device is on the curve in force, whose output is `operativeF`. */
  | { kind: "stale"; operativeF: number; marginF: number; polls: number; tankF: number };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const hhmm = (d: Date) => d.toISOString().slice(11, 16) + "Z";

/**
 * Decide whether the reported tank target is stale. `recent` is the last hour of polls (any order); the newest
 * STALE_REPORT_MIN_POLLS are examined. `curveOutputF` is status().curve_in_force.output_at_live_outdoor_f — what
 * the curve in force drives to right now; `commandedF` (the curve midpoint) stands in when it is unavailable.
 */
export function staleReportedTarget(a: {
  reportedF: number | null; commandedF: number | null; curveOutputF: number | null; htDifF: number | null;
  recent: RecentPoll[]; nowMs: number;
}): StaleReportVerdict {
  const reported = num(a.reportedF), commanded = num(a.commandedF);
  if (reported == null || commanded == null) return { kind: "not_applicable" };
  // A report at or below the command: within tolerance it is simply adopted; below it (a raise) the device either
  // calls at once — and the call refreshes the report — or the tank is already above the new target, and nothing
  // in "idle" distinguishes a stale low report from a satisfied device. No idle proof exists for that direction.
  if (reported - commanded <= ADOPTION_TOLERANCE_F) return { kind: "not_applicable" };
  const operativeF = num(a.curveOutputF) ?? commanded;
  const marginF = staleTankMarginF(a.htDifF);
  const thresholdF = reported - marginF;
  const polls = [...a.recent].sort((x, y) => x.ts.getTime() - y.ts.getTime()).slice(-STALE_REPORT_MIN_POLLS);
  if (polls.length < STALE_REPORT_MIN_POLLS) return { kind: "unproven", why: `needs ${STALE_REPORT_MIN_POLLS} idle polls with the tank below ${thresholdF.toFixed(1)} °F (have ${polls.length})` };
  const oldestAgeMs = a.nowMs - polls[0].ts.getTime();
  if (oldestAgeMs > STALE_REPORT_MAX_AGE_MS) return { kind: "unproven", why: `the last ${STALE_REPORT_MIN_POLLS} polls span ${Math.round(oldestAgeMs / 60_000)} min (limit ${STALE_REPORT_MAX_AGE_MS / 60_000}) — not consecutive` };
  for (const p of polls) {
    const tank = num(p.tankF);
    if (tank == null) return { kind: "unproven", why: `no tank reading at ${hhmm(p.ts)}` };
    // A call refreshes the report, so a report that survives a call is live — and the device really is at it.
    if (p.anyCall) return { kind: "unproven", why: `a stage was called at ${hhmm(p.ts)} — the report is live while calling` };
    if (p.hdActive === false) return { kind: "unproven", why: `no heat demand at ${hhmm(p.ts)} — an idle device proves nothing` };
    if (tank >= thresholdF) return { kind: "unproven", why: `tank ${tank.toFixed(1)} °F at ${hhmm(p.ts)} is not below ${thresholdF.toFixed(1)} °F (reported ${reported.toFixed(1)} − ${marginF.toFixed(1)})` };
    // Below the COMMAND's own threshold with no call the device is driving to neither value (WWSD, no demand, a
    // dead relay) — do not pronounce it settled on the curve either.
    if (tank < operativeF - marginF) return { kind: "unproven", why: `tank ${tank.toFixed(1)} °F at ${hhmm(p.ts)} is below the command's own call threshold ${(operativeF - marginF).toFixed(1)} °F with no call — the device is not heating to either value` };
  }
  return { kind: "stale", operativeF, marginF, polls: polls.length, tankF: num(polls[polls.length - 1].tankF) as number };
}
