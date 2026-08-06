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
import { detectDrawTimes } from "./dhw";

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

  // Ordinary multi-event case: the gap is the largest span BETWEEN draws, and is unaffected by how
  // long ago the last one was (that's hoursSinceLastDraw's job — conflating them hides a live quiet
  // spell behind a stale historical one).
  const t = (iso: string) => new Date(iso);
  const stats = drawGapStats(
    [t("2026-08-01T06:00:00Z"), t("2026-08-01T09:00:00Z"), t("2026-08-03T09:00:00Z"), t("2026-08-03T12:00:00Z")],
    Date.parse("2026-08-03T18:00:00Z"),
  );
  assert.equal(stats.eventCount, 4);
  assert.equal(stats.maxGapH, 48, "longest BETWEEN-draw gap = 48 h (08-01 09:00 → 08-03 09:00)");
  assert.equal(stats.hoursSinceLastDraw, 6, "hours-since is measured from now, independent of maxGapH");
}

// 6. detectDrawTimes + drawGapStats on a syntheised 5-min series — the pair that answers "how long has
//    the coil sat". Pinned because the threshold is the whole discrimination: standby loss moves the
//    tank ~0.2°F per 5-min sample, so a ≥1.5°F fall is water leaving, not the tank cooling.
{
  const start = Date.parse("2026-08-01T00:00:00Z");
  const rows: { ts: Date; tankF: number }[] = [];
  // 24 h of 5-min samples coasting down at the STANDBY rate (0.2°F/sample) — must yield zero draws.
  let tankF = 135;
  for (let i = 0; i < 288; i++) {
    rows.push({ ts: new Date(start + i * 5 * 60000), tankF });
    tankF -= 0.2;
  }
  assert.equal(detectDrawTimes(rows).length, 0, "standby coast-down is NOT a draw (0.2°F/sample < 1.5)");

  // Two real draws punched into an otherwise-quiet series, 8 h apart.
  const drawA = 60, drawB = 156; // sample indices ⇒ 5:00 and 13:00
  const withDraws = rows.map((r, i) => ({ ...r, tankF: r.tankF - (i >= drawA ? 6 : 0) - (i >= drawB ? 6 : 0) }));
  const times = detectDrawTimes(withDraws);
  assert.equal(times.length, 2, "exactly the two sharp falls are draws");
  assert.equal(times[0].toISOString(), new Date(start + drawA * 5 * 60000).toISOString());
  assert.equal(times[1].toISOString(), new Date(start + drawB * 5 * 60000).toISOString());
  assert.equal(drawGapStats(times, start + 288 * 5 * 60000).maxGapH, 8, "gap between the two draws = 8 h");

  // A sample pair further apart than MAX_SAMPLE_GAP_MIN is a DATA GAP, not a draw — a planner restart
  // or DB outage must never manufacture one (it would falsely reset the quiet-gap clock).
  const across = [
    { ts: new Date(start), tankF: 135 },
    { ts: new Date(start + 60 * 60000), tankF: 120 }, // 1 h apart, 15°F lower
  ];
  assert.equal(detectDrawTimes(across).length, 0, "a 15°F fall across a 1 h data gap is not a draw");
}

console.log("hygiene.test.ts: all assertions passed ✓");
