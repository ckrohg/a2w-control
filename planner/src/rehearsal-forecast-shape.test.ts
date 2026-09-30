/**
 * The rehearsal's hour-independence rule (eval 2026-09-30 F1): whatever the wall clock, the local day that holds
 * the hour 4 h from now has its warmest block at or after now + 4 h, so the plan's daily soak never lands inside the
 * driver's 3 h look-ahead or on the current block. Plain node:assert script under tsx like the planner's other
 * tests (ci.yml); the function lives under scripts/rehearsal because it is harness code, not planner code.
 */
import assert from "node:assert/strict";
import { placeWarmestAhead, AHEAD_H, NUDGE_F } from "../../scripts/rehearsal/forecast-shape";

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
// 2. nothing to do when today's warmest remaining hour is already ≥ 4 h ahead
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
// 4. honours the current-hour index (the fake keeps one hour of history at index 0, never a candidate)
{
  const f = [50, 23, 22, 20, 18, 16, 15, 14, 13, 12, 12, 13];
  const r = placeWarmestAhead(f, ["D0", ...days(11, 11)], 1);
  assert.equal(r.nudge?.index, 1 + AHEAD_H);
  assert.equal(r.nudge?.warmestWas, 1);
}
// 5. now+4 past the end of the series → nothing to do
assert.equal(placeWarmestAhead([30, 29, 28], ["D0", "D0", "D0"], 0).nudge, null);
// 6. the nudge is the smallest that wins: exactly warmest + NUDGE_F, never more
{
  const f = [10, 9, 8, 7, 6, 5, 4, 3];
  const r = placeWarmestAhead(f, days(f.length, 8), 0);
  assert.equal(r.nudge?.to, 10.5);
}
console.log("rehearsal-forecast-shape: ok (6 groups)");
