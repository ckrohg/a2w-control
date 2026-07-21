/**
 * @purpose I8 thermal-hygiene decision (pure) — given a tank-temperature series and the
 * pasteurization window, decide whether a real disinfecting DWELL occurred or the soak is
 * overdue, and choose the season-aware interval. Extracted from index.ts so this safety
 * logic is unit-testable (hygiene.test.ts). No I/O; callers supply the series + params.
 *
 * Why coil-in-buffer makes the interval season-aware: the only standing potable water is the
 * few gallons inside the DHW coil, and every substantial draw flushes it. Legionella needs
 * BOTH the tank sitting in the ~68–113°F growth band AND days of no pasteurizing excursion
 * (4–6 h doubling ⇒ ~2–5 days to reach concern). So when the tank runs cool (warm outdoor,
 * autopilot's summer setback) a longer interval is tolerable; when cold, the tank runs hot
 * continuously and the dwell is satisfied for free, so the interval never binds. Only a real
 * THERMAL dwell resets the clock — a draw dilutes the planktonic slug but never kills biofilm.
 */

export interface HygieneReading {
  ts: Date;
  tankF: number | null;
}

/** Longest continuous span (minutes) the tank held ≥ minF, from the ascending reading series. */
export function longestDwellMin(series: HygieneReading[], minF: number): number {
  let best = 0;
  let runStart: Date | null = null;
  let runLast: Date | null = null;
  for (const r of series) {
    if (r.tankF != null && r.tankF >= minF) {
      if (runStart == null) runStart = r.ts;
      runLast = r.ts;
    } else if (runStart && runLast) {
      best = Math.max(best, (runLast.getTime() - runStart.getTime()) / 60000);
      runStart = runLast = null;
    }
  }
  if (runStart && runLast) best = Math.max(best, (runLast.getTime() - runStart.getTime()) / 60000);
  return best;
}

export interface HygieneParams {
  verifyF: number; // tank must hold ≥ this °F
  dwellMin: number; // for ≥ this many continuous minutes to count as a pasteurization
  minReadings: number; // require a mostly-complete window before ever declaring "overdue"
}

export interface HygieneVerdict {
  dwellMin: number; // longest qualifying dwell found in the window
  satisfied: boolean; // a real pasteurizing dwell occurred
  overdue: boolean; // no dwell AND the window is complete enough to trust the verdict
}

/** Decide the I8 verdict for a window. `overdue` stays false on a sparse window (planner just
 *  started / DB gap) so a thin history never false-fires the alert or an auto-soak. */
export function hygieneVerdict(series: HygieneReading[], p: HygieneParams): HygieneVerdict {
  const dwellMin = longestDwellMin(series, p.verifyF);
  const satisfied = dwellMin >= p.dwellMin;
  const overdue = !satisfied && series.length >= p.minReadings;
  return { dwellMin, satisfied, overdue };
}

/** Hard safety ceiling: the pasteurization interval may never exceed this regardless of config,
 *  so a fat-fingered env can't silently disable hygiene. 72 h < the ~2–5 day time-to-concern. */
export const HYGIENE_HARD_MAX_H = 72;

/** Season-aware pasteurization interval (hours). Warm outdoor ⇒ the cool-tank regime ⇒ the
 *  (owner-opted) summer interval; cold or unknown outdoor ⇒ the base interval. Clamped to
 *  [1, HYGIENE_HARD_MAX_H]. With summerH === baseH (the default) this is a no-op. */
export function hygieneIntervalH(
  outdoorF: number | null,
  baseH: number,
  summerH: number,
  summerOutdoorF: number,
): number {
  const chosen = outdoorF != null && outdoorF >= summerOutdoorF ? summerH : baseH;
  return Math.min(Math.max(chosen, 1), HYGIENE_HARD_MAX_H);
}

/** End timestamp of the most recent qualifying dwell (≥dwellMin continuous minutes ≥minF) in the
 *  ascending series, or null if none. Answers "how long since the coil was last pasteurized" so the
 *  plan can schedule the next soak BEFORE the hygiene window lapses (demand-aware cadence). */
export function lastDwellEnd(series: HygieneReading[], minF: number, dwellMin: number): Date | null {
  let best: Date | null = null;
  let runStart: Date | null = null;
  let runLast: Date | null = null;
  const commit = () => {
    if (runStart && runLast && (runLast.getTime() - runStart.getTime()) / 60000 >= dwellMin) best = runLast;
  };
  for (const r of series) {
    if (r.tankF != null && r.tankF >= minF) {
      if (runStart == null) runStart = r.ts;
      runLast = r.ts;
    } else {
      commit();
      runStart = runLast = null;
    }
  }
  commit();
  return best;
}
