/**
 * @purpose Make the rehearsal hour-independent (eval 2026-09-30 F1). computeShadowPlan puts the daily 140 °F soak
 * at the warmest REMAINING hour of each local day with ≥ 6 blocks, over the FIRST 24 forecast blocks it keeps; for
 * a falling forecast run in the late afternoon that hour is *now*, so the driver refuses to draw beside a soak
 * within 3 h and the demand floor rides the soak's 145 °F ceiling — the harness passed at 01:00 and failed at 17:30
 * for the same planner. The fake therefore shapes the scenario's forecast so that, in the local day containing the
 * hour AHEAD_H hours from now, the warmest hour the PLANNER CAN SEE is at or after now + AHEAD_H: a +0.5 °F nudge on
 * that hour, only when needed, logged. A day with fewer than 6 blocks inside the planner's horizon gets no soak at
 * all (the 6-block test below counts exactly those blocks, history hour included).
 *
 * The candidate set is a SUPERSET of what the planner slices (codex on a2w#154): indices [0, nowIdx + HORIZON_H) —
 * index 0 (the served history hour) is kept because at exactly xx:00:00.000 the planner's ≥ now − 1 h filter retains
 * it and the 24-block slice then starts there; hours beyond the horizon are excluded because a warmer hour the
 * planner never sees must not suppress the nudge. Nudging above the maximum of a superset keeps the target the
 * maximum of every subset that contains it.
 *
 * Pure; the fake calls it once per request.
 */
export const AHEAD_H = 4;
export const NUDGE_F = 0.5;
/** computeShadowPlan's `forecast.slice(0, 24)` */
export const HORIZON_H = 24;

export interface ShapedForecast {
  temperature_2m: number[];
  /** null when the scenario already satisfied the rule; else what was nudged and why */
  nudge: { index: number; from: number; to: number; day: string; warmestWas: number } | null;
}

/**
 * @param temperature_2m one value per hour of `time`
 * @param localDay      the local calendar day of each hour in the HOUSE's zone (any stable string, e.g. "2026-01-15")
 * @param nowIdx        the index of the block containing the current hour (the fake serves one hour of history first, so 1)
 */
export function placeWarmestAhead(temperature_2m: number[], localDay: string[], nowIdx: number, aheadH = AHEAD_H, horizonH = HORIZON_H): ShapedForecast {
  const out = temperature_2m.slice();
  const target = nowIdx + aheadH;
  const end = Math.min(out.length, nowIdx + horizonH);
  if (target >= end) return { temperature_2m: out, nudge: null };
  const day = localDay[target];
  // the blocks of that local day the planner can hold: from the served history hour through the horizon
  const idx: number[] = [];
  for (let i = 0; i < end; i++) if (localDay[i] === day) idx.push(i);
  if (idx.length < 6) return { temperature_2m: out, nudge: null }; // < 6 blocks → the plan skips that day's soak
  let warmest = idx[0];
  for (const i of idx) if (out[i] > out[warmest]) warmest = i; // first strict maximum — the planner's reduce does the same
  if (warmest >= target) return { temperature_2m: out, nudge: null };
  const to = Math.round((out[warmest] + NUDGE_F) * 10) / 10;
  const from = out[target];
  out[target] = to;
  return { temperature_2m: out, nudge: { index: target, from, to, day, warmestWas: warmest } };
}

/**
 * Wall-clock hour of an instant in `tz`, as an ISO string WITH the zone's UTC offset ("2026-11-01T01:00:00-04:00")
 * plus the local calendar day. Real open-meteo (timezone=auto) sends offset-less local strings, which name the
 * fall-back hour twice; the fake carries the offset so each served hour is one instant and the planner's
 * `new Date(t)` cannot confuse the two 01:00s on the first Sunday of November (codex on a2w#154).
 */
export function houseIso(t: Date, tz: string): { iso: string; day: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "longOffset",
  }).formatToParts(t).map((x) => [x.type, x.value]));
  // "GMT-04:00" | "GMT+01:00" | "GMT" (UTC)
  const off = String(p.timeZoneName).replace(/^GMT/, "") || "+00:00";
  return { iso: `${p.year}-${p.month}-${p.day}T${p.hour}:00:00${off}`, day: `${p.year}-${p.month}-${p.day}` };
}
