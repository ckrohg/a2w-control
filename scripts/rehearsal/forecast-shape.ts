/**
 * @purpose Make the rehearsal hour-independent (eval 2026-09-30 F1). computeShadowPlan puts the daily 140 °F soak
 * at the warmest REMAINING hour of each local day with ≥ 6 blocks; for a falling forecast run in the late afternoon
 * that hour is *now*, so the driver refuses to draw beside a soak within 3 h and the demand floor rides the soak's
 * 145 °F ceiling — the harness passed at 01:00 and failed at 17:30 for the same planner. The fake therefore shapes
 * the scenario's forecast so that, in the local day containing the hour AHEAD_H hours from now, the warmest hour is
 * at or after now + AHEAD_H: a +0.5 °F nudge on that hour, only when needed, logged. A day that ends before
 * now + AHEAD_H has fewer than 6 blocks left and gets no soak at all. Pure; the fake calls it once per request.
 */
export const AHEAD_H = 4;
export const NUDGE_F = 0.5;

export interface ShapedForecast {
  temperature_2m: number[];
  /** null when the scenario already satisfied the rule; else what was nudged and why */
  nudge: { index: number; from: number; to: number; day: string; warmestWas: number } | null;
}

/**
 * @param temperature_2m one value per hour of `time`
 * @param localDay      the local calendar day of each hour (any stable string, e.g. "2026-01-15")
 * @param nowIdx        the index of the CURRENT hour (the planner's first block)
 */
export function placeWarmestAhead(temperature_2m: number[], localDay: string[], nowIdx: number, aheadH = AHEAD_H): ShapedForecast {
  const out = temperature_2m.slice();
  const target = nowIdx + aheadH;
  if (target >= out.length) return { temperature_2m: out, nudge: null };
  const day = localDay[target];
  // the blocks of that local day from `now` on (a day's soak considers only blocks the plan still holds)
  const idx: number[] = [];
  for (let i = nowIdx; i < out.length; i++) if (localDay[i] === day) idx.push(i);
  if (idx.length < 6) return { temperature_2m: out, nudge: null }; // < 6 blocks → the plan skips that day's soak
  let warmest = idx[0];
  for (const i of idx) if (out[i] > out[warmest]) warmest = i;
  if (warmest >= target) return { temperature_2m: out, nudge: null };
  const to = Math.round((out[warmest] + NUDGE_F) * 10) / 10;
  const from = out[target];
  out[target] = to;
  return { temperature_2m: out, nudge: { index: target, from, to, day, warmestWas: warmest } };
}
