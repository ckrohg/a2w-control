/**
 * The rehearsal's hour-independence rule (eval 2026-09-30 F1; codex on a2w#154): whatever the wall clock, the local
 * day that holds the hour 4 h from now has its warmest block — among the blocks the PLANNER can see — at or after
 * now + 4 h, so the plan's daily soak never lands inside the driver's 3 h look-ahead or on the current block; and
 * every served hour names one instant through both DST changes. Plain node:assert script under tsx like the
 * planner's other tests (ci.yml); the functions live under scripts/rehearsal because they are harness code.
 */
import assert from "node:assert/strict";
import { placeWarmestAhead, houseIso, AHEAD_H, NUDGE_F, HORIZON_H } from "../../scripts/rehearsal/forecast-shape";

const days = (n: number, hoursLeftToday: number) => Array.from({ length: n }, (_, i) => (i < hoursLeftToday ? "D0" : i < hoursLeftToday + 24 ? "D1" : "D2"));

// 1. a falling cold-morning forecast run with 7 h left in the day: 'now' would be the warmest → the hour 4 h ahead is nudged above it
{
  const f = [23, 22, 20, 18, 16, 15, 14, 13, 12, 12, 13, 15, 18, 20, 22, 24, 26, 28, 30, 31, 30, 28, 26, 24];
  const r = placeWarmestAhead(f, days(f.length, 7), 0);
  assert.deepEqual(r.nudge, { index: AHEAD_H, from: 16, to: 23 + NUDGE_F, day: "D0", warmestWas: 0 });
  assert.equal(r.temperature_2m[AHEAD_H], 23.5);
  const today = r.temperature_2m.slice(0, 7);
  assert.equal(today.indexOf(Math.max(...today)), AHEAD_H, "today's warmest is now the hour 4 h ahead");
  assert.equal(f[AHEAD_H], 16, "input untouched");
}
// 2. nothing to do when the shaped day's warmest hour is already ≥ 4 h ahead
{
  const f = [55, 56, 57, 58, 60, 62, 64, 63, 61, 58, 55, 52];
  assert.equal(placeWarmestAhead(f, days(f.length, 12), 0).nudge, null);
}
// 3. < 6 blocks left today → no soak today (nothing nudged there); now+4 falls in TOMORROW, whose warmest (00:00) is within 3 h → tomorrow's 04:00 is nudged
{
  const f = [40, 39, 38, 45, 30, 28, 26, 25, 24, 24, 25, 27, 30, 33, 35, 36, 36, 35, 33, 31, 30, 29, 28, 27, 26, 25, 24, 23];
  const r = placeWarmestAhead(f, days(f.length, 3), 0);
  assert.deepEqual(r.nudge, { index: 4, from: 30, to: 45.5, day: "D1", warmestWas: 3 });
}
// 4. honours the current-hour index (the fake keeps one hour of history at index 0) — and index 0 IS a candidate,
//    because at exactly xx:00:00 the planner keeps it: a warmer history hour still forces the nudge
{
  const f = [50, 23, 22, 20, 18, 16, 15, 14, 13, 12, 12, 13];
  const r = placeWarmestAhead(f, ["D0", ...days(11, 11)], 1);
  assert.equal(r.nudge?.index, 1 + AHEAD_H);
  assert.equal(r.nudge?.warmestWas, 0, "the served history hour is inside the planner's possible slice");
  assert.equal(r.nudge?.to, 50.5);
}
// 5. now+4 past the end of the series → nothing to do
assert.equal(placeWarmestAhead([30, 29, 28], ["D0", "D0", "D0"], 0).nudge, null);
// 6. the nudge is the smallest that wins: exactly warmest + NUDGE_F
{
  const f = [10, 9, 8, 7, 6, 5, 4, 3];
  assert.equal(placeWarmestAhead(f, days(f.length, 8), 0).nudge?.to, 10.5);
}
// 7. HORIZON (codex must-fix 1): a warmer hour BEYOND the planner's 24-block slice must not suppress the nudge
{
  const f = Array.from({ length: 50 }, (_, i) => (i === 26 ? 99 : 30 - (i % 24) * 0.1)); // warmest at index 26 = beyond nowIdx 1 + 24
  const r = placeWarmestAhead(f, f.map(() => "D0"), 1);
  assert.ok(r.nudge, "the out-of-horizon maximum is invisible to the planner, so the in-horizon maximum (index 0/1) still forces a nudge");
  assert.equal(r.nudge!.index, 1 + AHEAD_H);
  assert.equal(r.nudge!.warmestWas, 0);
  assert.equal(f[26], 99, "untouched");
  // and the horizon is exactly computeShadowPlan's slice
  assert.equal(HORIZON_H, 24);
}
// 8. the 6-block rule counts only blocks INSIDE THE HORIZON (codex pass 2): with a short horizon the shaped day shows
//    5 blocks → the plan would skip its soak → no nudge, although the day has 47 blocks in the series (the unbounded
//    pass-1 shaper counted those and nudged). With the real 24-block horizon the target's day always shows ≥ 20 blocks,
//    so the branch only matters for series that END early — covered by the same call with a full horizon below.
{
  const f = Array.from({ length: 50 }, (_, i) => (i === 3 ? 60 : 30 - i * 0.1)); // D1's warmest is index 3, before the target 4
  const day = f.map((_, i) => (i < 3 ? "D0" : "D1"));
  assert.equal(placeWarmestAhead(f, day, 0, 4, 8).nudge, null, "5 visible D1 blocks (3..7) → no soak → no nudge, series length notwithstanding");
  const r = placeWarmestAhead(f, day, 0, 4, 24);
  assert.deepEqual(r.nudge, { index: 4, from: 29.6, to: 60.5, day: "D1", warmestWas: 3 }, "21 visible D1 blocks → soak possible → nudge");
  // a series that ends early: the target's day has only 5 blocks at all → no nudge
  assert.equal(placeWarmestAhead(f.slice(0, 8), day.slice(0, 8), 0).nudge, null);
}
// 9. ties: an EARLIER hour tying the target still wins the planner's first-strict-maximum reduce → the target is nudged
{
  const f = [30, 30, 29, 28, 30, 27, 26, 25];
  const r = placeWarmestAhead(f, days(f.length, 8), 0);
  assert.deepEqual(r.nudge, { index: 4, from: 30, to: 30.5, day: "D0", warmestWas: 0 });
}
// 10. DST (codex must-fix 2): the served strings carry the offset, so the two 01:00s of 2026-11-01 are distinct instants,
//     spring-forward has no 02:00, and the planner's new Date(t) of each string returns exactly the instant
{
  const tz = "America/New_York";
  assert.equal(houseIso(new Date("2026-11-01T05:00:00Z"), tz).iso, "2026-11-01T01:00:00-04:00");
  assert.equal(houseIso(new Date("2026-11-01T06:00:00Z"), tz).iso, "2026-11-01T01:00:00-05:00");
  assert.equal(houseIso(new Date("2026-03-08T06:00:00Z"), tz).iso, "2026-03-08T01:00:00-05:00");
  assert.equal(houseIso(new Date("2026-03-08T07:00:00Z"), tz).iso, "2026-03-08T03:00:00-04:00");
  assert.equal(houseIso(new Date("2026-09-30T04:00:00Z"), tz).iso, "2026-09-30T00:00:00-04:00", "midnight is 00, never 24");
  assert.equal(houseIso(new Date("2026-09-30T04:00:00Z"), tz).day, "2026-09-30");
  for (const z of ["2026-11-01T05:00:00Z", "2026-11-01T06:00:00Z", "2026-03-08T07:00:00Z"]) {
    assert.equal(new Date(houseIso(new Date(z), tz).iso).toISOString(), new Date(z).toISOString(), `round-trips ${z}`);
  }
  assert.equal(houseIso(new Date("2026-06-01T12:00:00Z"), "UTC").iso, "2026-06-01T12:00:00+00:00");
}
console.log("rehearsal-forecast-shape: ok (10 groups)");
