/**
 * @purpose DHW draw-window learner — replaces the fixed 6–9 / 17–22 windows with ones
 * mined from actual tank behavior. A coil-in-buffer draw is a sharp tank drop (§6.3 of
 * the plan): consecutive 5-min samples falling ≥ DROP_F. Score each local hour by the
 * fraction of observed days with at least one draw event; hours over THRESHOLD (padded
 * ±1 h, merged) become the windows. Returns null until MIN_DAYS of history exist —
 * callers keep the fixed defaults until then.
 */

export const DROP_F = 1.5; // °F fall between adjacent samples ≤ 12 min apart = a draw
const PAD_H = 1;
const MAX_SAMPLE_GAP_MIN = 12; // wider than that and the pair isn't adjacent enough to read as one event

/**
 * Timestamps of detected draws, ascending — the shared primitive behind both the window learner
 * and the "how long has the coil sat" clock, so there is exactly ONE definition of "a draw".
 *
 * Why this threshold discriminates: standby loss moves the tank ~0.2 °F per 5-min sample
 * (0.65 kW over C_eff ≈ 110 gal ⇒ ~2.4 °F/h), so DROP_F is ~7× the standby rate — a fall this
 * sharp is water leaving, not the tank cooling. Measured against 14 d of real readings the
 * detected drops average 4.2 °F (max 16.5), and their hour-of-day histogram is a human pattern.
 *
 * Caveat that matters in WINTER: a space-heat call also pulls the buffer down, so off-season these
 * are "draws or zone calls", not draws alone. In the summer cool-tank regime — the only time the
 * hygiene interval actually binds — DHW is the sole load, so they are draws.
 */
export function detectDrawTimes(rows: { ts: Date; tankF: number }[]): Date[] {
  const out: Date[] = [];
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    const dtMin = (cur.ts.getTime() - prev.ts.getTime()) / 60_000;
    if (dtMin <= 0 || dtMin > MAX_SAMPLE_GAP_MIN) continue;
    if (prev.tankF - cur.tankF >= DROP_F) out.push(cur.ts);
  }
  return out;
}

export interface LearnedWindows {
  windows: [number, number][]; // [startHour, endHourExclusive] local
  days: number;
  drawEvents: number;
  hourScores: number[]; // 24 entries, fraction of days with a draw in that hour
}

export function learnDhwWindows(
  rows: { ts: Date; tankF: number }[],
  minDays = 5,
  threshold = 0.25,
): LearnedWindows | null {
  if (rows.length < 100) return null;
  const daysSeen = new Set<string>();
  const eventDaysByHour: Set<string>[] = Array.from({ length: 24 }, () => new Set());

  for (let i = 1; i < rows.length; i++) daysSeen.add(rows[i].ts.toISOString().slice(0, 10));
  const drawTimes = detectDrawTimes(rows);
  const drawEvents = drawTimes.length;
  for (const ts of drawTimes) {
    eventDaysByHour[ts.getHours()].add(ts.toISOString().slice(0, 10)); // TZ env → local hour
  }

  const days = daysSeen.size;
  if (days < minDays) return null;

  const hourScores = eventDaysByHour.map((s) => s.size / days);
  const hot = new Set<number>();
  hourScores.forEach((score, h) => {
    if (score >= threshold) {
      for (let p = -PAD_H; p <= PAD_H; p++) hot.add((h + p + 24) % 24);
    }
  });
  if (!hot.size) return null;

  // merge consecutive hot hours into [start, endExclusive) ranges (no midnight wrap in v1)
  const windows: [number, number][] = [];
  let start: number | null = null;
  for (let h = 0; h <= 24; h++) {
    const isHot = h < 24 && hot.has(h);
    if (isHot && start === null) start = h;
    if (!isHot && start !== null) {
      windows.push([start, h]);
      start = null;
    }
  }
  return { windows, days, drawEvents, hourScores };
}

// ─── #135: how deep does a draw sag the tank, per learned window ────────────────────────────────
/** After a draw starts, the trough is looked for within this many minutes. */
export const SAG_HORIZON_MIN = 60;
/** Consecutive ≥ DROP_F samples closer than this belong to ONE draw (a shower is several samples of fall). */
export const DRAW_MERGE_MIN = 15;

export interface WindowSag {
  windowStart: number;   // local hour
  windowEnd: number;     // local hour, exclusive
  n: number;             // draws observed inside the window
  sagP75F: number;       // 75th-percentile fall from the pre-draw level to the trough (°F)
  sagMedianF: number;
  preDrawMedianF: number;
  troughMedianF: number;
}

/**
 * One draw event = the first ≥ DROP_F fall (detectDrawTimes' definition) not within DRAW_MERGE_MIN of
 * the previous event. Its sag = tank just before the fall − the minimum of the contiguous samples in
 * the next SAG_HORIZON_MIN. Grouped by the local hour the draw started in. Windows with no draws come
 * back with n = 0 and zero sags (the plan then boosts nothing for them). Same rows the window learner
 * reads: no extra query.
 *
 * WINTER CAVEAT (same as detectDrawTimes): a space-heat call also pulls the buffer, so a heating-season
 * "sag" may be a zone call, not a shower. The plan side bounds the damage — a window needs ≥ 6 draws
 * (nearest-rank p75 of 6 is the 5th value, never the maximum) and the boost is capped at
 * MAX_PREBOOST_F — and the reason text names the measurement so the plan-vs-actual ledger can be read.
 */
export function measureWindowSags(rows: { ts: Date; tankF: number }[], windows: [number, number][]): WindowSag[] {
  const sagsByWindow = windows.map(() => ({ sags: [] as number[], pre: [] as number[], trough: [] as number[] }));
  let lastEventMs = -Infinity;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    const dtMin = (cur.ts.getTime() - prev.ts.getTime()) / 60_000;
    if (dtMin <= 0 || dtMin > MAX_SAMPLE_GAP_MIN) continue;
    if (prev.tankF - cur.tankF < DROP_F) continue;
    if (cur.ts.getTime() - lastEventMs < DRAW_MERGE_MIN * 60_000) { lastEventMs = cur.ts.getTime(); continue; }
    lastEventMs = cur.ts.getTime();
    const h = cur.ts.getHours(); // TZ env → local hour, as learnDhwWindows
    const w = windows.findIndex(([a, b]) => h >= a && h < b);
    if (w < 0) continue;
    // The trough is the minimum of the CONTIGUOUS samples after the fall: the scan stops at the first
    // sample gap wider than MAX_SAMPLE_GAP_MIN (a reading after a telemetry hole is not this draw's
    // trough) and at the horizon (codex, #148).
    let trough = cur.tankF;
    for (let j = i + 1; j < rows.length && rows[j].ts.getTime() - cur.ts.getTime() <= SAG_HORIZON_MIN * 60_000; j++) {
      if ((rows[j].ts.getTime() - rows[j - 1].ts.getTime()) / 60_000 > MAX_SAMPLE_GAP_MIN) break;
      if (rows[j].tankF < trough) trough = rows[j].tankF;
    }
    sagsByWindow[w].sags.push(prev.tankF - trough);
    sagsByWindow[w].pre.push(prev.tankF);
    sagsByWindow[w].trough.push(trough);
  }
  const q = (xs: number[], p: number) => {
    if (!xs.length) return 0;
    const a = [...xs].sort((x, y) => x - y);
    const k = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
    return a[k];
  };
  return windows.map(([windowStart, windowEnd], w) => {
    const g = sagsByWindow[w];
    return {
      windowStart, windowEnd, n: g.sags.length,
      sagP75F: Math.round(q(g.sags, 0.75) * 10) / 10,
      sagMedianF: Math.round(q(g.sags, 0.5) * 10) / 10,
      preDrawMedianF: Math.round(q(g.pre, 0.5) * 10) / 10,
      troughMedianF: Math.round(q(g.trough, 0.5) * 10) / 10,
    };
  });
}

/**
 * #135: the PEAK draw hours — where at least `threshold` of observed days had a draw — merged into
 * unpadded [start, endExclusive) ranges. The learner's `windows` (threshold 0.25, padded ±1 h) say
 * where the DHW floor must hold and on this house cover nearly the whole day (measured 2026-09-29:
 * [[0,21],[22,24]] from 137 draws in 15 d); a pre-boost keyed to those starts would fire once a day
 * before midnight. The shower peaks are what the sag is measured over and what the boost precedes.
 */
export const PEAK_THRESHOLD = 0.5;
export function peakWindows(hourScores: number[], threshold = PEAK_THRESHOLD): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  for (let h = 0; h <= 24; h++) {
    const hot = h < 24 && (hourScores[h] ?? 0) >= threshold;
    if (hot && start === null) start = h;
    if (!hot && start !== null) { out.push([start, h]); start = null; }
  }
  return out;
}
