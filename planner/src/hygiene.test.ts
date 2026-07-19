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

console.log("hygiene.test.ts: all assertions passed ✓");
