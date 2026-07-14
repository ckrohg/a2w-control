/**
 * @purpose DHW draw-window learner — replaces the fixed 6–9 / 17–22 windows with ones
 * mined from actual tank behavior. A coil-in-buffer draw is a sharp tank drop (§6.3 of
 * the plan): consecutive 5-min samples falling ≥ DROP_F. Score each local hour by the
 * fraction of observed days with at least one draw event; hours over THRESHOLD (padded
 * ±1 h, merged) become the windows. Returns null until MIN_DAYS of history exist —
 * callers keep the fixed defaults until then.
 */

const DROP_F = 1.5; // °F fall between adjacent samples ≤ 12 min apart = a draw
const PAD_H = 1;

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
  let drawEvents = 0;

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    const dtMin = (cur.ts.getTime() - prev.ts.getTime()) / 60_000;
    const day = cur.ts.toISOString().slice(0, 10);
    daysSeen.add(day);
    if (dtMin <= 0 || dtMin > 12) continue;
    if (prev.tankF - cur.tankF >= DROP_F) {
      drawEvents++;
      eventDaysByHour[cur.ts.getHours()].add(day); // TZ env → local hour
    }
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
