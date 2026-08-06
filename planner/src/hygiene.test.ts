/**
 * @purpose Assertions for the pure I8 hygiene logic (hygiene.ts). a2w-control has no JS test runner
 * (CI is tsc build + bridge pytest), so run locally with: npx tsx planner/src/hygiene.test.ts
 * — it exits non-zero on failure. This is a health-safety path, so the dwell + interval math is pinned.
 */
import assert from "node:assert/strict";
import {
  longestDwellMin,
  hygieneVerdict,
  hygieneIntervalH,
  lastDwellEnd,
  drawGapStats,
  HYGIENE_HARD_MAX_H,
  type HygieneReading,
} from "./hygiene";

const t0 = new Date(2026, 6, 15, 12, 0, 0).getTime();
const at = (min: number, tankF: number | null): HygieneReading => ({ ts: new Date(t0 + min * 60000), tankF });

// 1. longestDwellMin: a single ≥134 run of 40 min (t=10..50) is measured; the cooler tails are ignored.
{
  const s = [at(0, 120), at(5, 130), at(10, 135), at(30, 141), at(50, 134), at(55, 128), at(60, 120)];
  assert.equal(longestDwellMin(s, 134), 40, "expected a 40-min dwell ≥134°F");
  // A higher bar (≥140) only the single 141 reading clears → zero continuous span.
  assert.equal(longestDwellMin(s, 140), 0, "no continuous span ≥140°F");
  // nulls break a run.
  assert.equal(longestDwellMin([at(0, 135), at(5, null), at(10, 135)], 134), 0, "null splits the run");
}

// 2. hygieneVerdict: a real dwell satisfies; no dwell over a complete window is overdue; a sparse
//    window is NEVER overdue (guards planner-startup / DB-gap false fires).
{
  const soaked = [at(0, 120), at(5, 136), at(40, 136), at(45, 120)]; // 40-min dwell
  const v1 = hygieneVerdict(soaked, { verifyF: 134, dwellMin: 30, minReadings: 3 });
  assert.equal(v1.satisfied, true);
  assert.equal(v1.overdue, false);

  const coolFull = Array.from({ length: 10 }, (_, i) => at(i * 5, 120)); // never ≥134, 10 readings
  const v2 = hygieneVerdict(coolFull, { verifyF: 134, dwellMin: 30, minReadings: 5 });
  assert.equal(v2.satisfied, false);
  assert.equal(v2.overdue, true, "complete cool window ⇒ overdue");

  const v3 = hygieneVerdict(coolFull, { verifyF: 134, dwellMin: 30, minReadings: 50 });
  assert.equal(v3.overdue, false, "sparse window ⇒ never overdue");
}

// 3. hygieneIntervalH: warm outdoor picks the summer interval; cold/unknown picks base; clamped to
//    [1, HARD_MAX]; the default (summer === base) is a no-op.
{
  assert.equal(hygieneIntervalH(70, 26, 60, 55), 60, "warm ⇒ summer interval");
  assert.equal(hygieneIntervalH(40, 26, 60, 55), 26, "cold ⇒ base interval");
  assert.equal(hygieneIntervalH(null, 26, 60, 55), 26, "unknown outdoor ⇒ base interval");
  assert.equal(hygieneIntervalH(70, 26, 26, 55), 26, "summer===base ⇒ no-op (default)");
  assert.equal(hygieneIntervalH(70, 26, 999, 55), HYGIENE_HARD_MAX_H, "over-cap ⇒ clamped to hard max");
  assert.equal(hygieneIntervalH(55, 26, 60, 55), 60, "exactly at threshold ⇒ summer");
}

// 4. lastDwellEnd: returns the END ts of the MOST RECENT qualifying (≥dwellMin) dwell, ignores short
//    touches, null when none — this drives the demand-aware "soak due?" gate.
{
  // two qualifying dwells; expect the end of the SECOND (t=200..245, 45 min)
  const s: HygieneReading[] = [
    at(0, 120), at(5, 136), at(45, 136), at(50, 120),        // dwell #1: 45 min, ends t=45
    at(120, 141), at(140, 120),                              // short touch (20 min) → ignored
    at(200, 135), at(245, 135), at(250, 118),                // dwell #2: 45 min, ends t=245
  ];
  const end = lastDwellEnd(s, 134, 30);
  assert.ok(end, "expected a qualifying dwell end");
  assert.equal(end!.getTime(), new Date(t0 + 245 * 60000).getTime(), "end = most recent qualifying dwell");
  // no qualifying dwell (all cool, or only short touches) → null
  assert.equal(lastDwellEnd([at(0, 120), at(5, 141), at(10, 120)], 134, 30), null, "short touch ⇒ null");
  assert.equal(lastDwellEnd([at(0, 120), at(30, 120)], 134, 30), null, "never hot ⇒ null");
}

// 5. drawGapStats: the stagnation half (OBSERVABILITY ONLY — never gates the soak, issue #51 rule 4).
{
  assert.deepEqual(
    drawGapStats([], 0),
    { lastDrawAt: null, hoursSinceLastDraw: null, maxGapH: null, eventCount: 0 },
    "no draws ⇒ all null, count 0",
  );

  // one event: a gap needs two points, so maxGapH stays null rather than reading as 0 (which would
  // look like "no quiet time at all" — the opposite of the truth on a single-sample history).
  const one = new Date("2026-08-01T12:00:00Z");
  const s1 = drawGapStats([one], Date.parse("2026-08-02T12:00:00Z"));
  assert.equal(s1.maxGapH, null, "single draw ⇒ no measurable gap");
  assert.equal(s1.eventCount, 1);
  assert.equal(s1.hoursSinceLastDraw, 24, "hours-since measured from now, not from the previous draw");

  // REGRESSION — the real 6BB record pulled from TempIQ /api/insights/dhw-usage on 2026-08-06.
  // The 2.90-day quiet stretch (07-29 14:23Z → 08-01 12:04Z) is why this signal exists: it sits inside
  // the ~2–5-day time-to-concern band, against a 60h summer soak interval. If a refactor ever makes
  // this read shorter, the stagnation picture is being under-reported and the number stops being safe.
  const real = [
    "2026-07-23T07:01:50Z", "2026-07-23T15:09:27Z", "2026-07-25T14:48:08Z", "2026-07-26T12:46:21Z",
    "2026-07-26T12:56:21Z", "2026-07-26T17:21:10Z", "2026-07-28T12:28:49Z", "2026-07-29T14:23:27Z",
    "2026-08-01T12:04:02Z", "2026-08-01T12:32:18Z", "2026-08-03T13:39:54Z", "2026-08-03T18:58:18Z",
    "2026-08-04T12:02:39Z", "2026-08-04T13:24:47Z", "2026-08-05T12:47:46Z",
  ].map((s) => new Date(s));
  const stats = drawGapStats(real, Date.parse("2026-08-06T15:22:00Z"));
  assert.equal(stats.eventCount, 15, "all 15 events counted");
  assert.ok(stats.maxGapH != null, "expected a measurable gap");
  assert.ok(
    Math.abs(stats.maxGapH! / 24 - 2.90) < 0.01,
    `longest quiet gap should be ~2.90 days, got ${(stats.maxGapH! / 24).toFixed(2)}`,
  );
  assert.ok(
    Math.abs(stats.hoursSinceLastDraw! - 26.57) < 0.02,
    `hours since last draw should be ~26.6, got ${stats.hoursSinceLastDraw!.toFixed(2)}`,
  );
  assert.equal(stats.lastDrawAt!.toISOString(), "2026-08-05T12:47:46.000Z", "last draw = newest event");
}

console.log("hygiene.test.ts: all assertions passed ✓");
