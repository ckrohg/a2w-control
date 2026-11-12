/**
 * @purpose learnDhwWindows — the learner that sets the daily DHW floor windows, from synthetic tank history.
 * Days and draw hours must both be local: under America/New_York a local-midnight-to-midnight history spans
 * one extra UTC date, and a 21:30 local draw lands on the next UTC date.
 * Run with: npx tsx planner/src/dhw-learn.test.ts
 */
process.env.TZ = "America/New_York"; // before any Date is built
import assert from "node:assert/strict";
import { learnDhwWindows, detectDrawTimes } from "./dhw";

type Row = { ts: Date; tankF: number };

/**
 * `days` full local days of 5-min samples at 120 °F from local midnight Sept 1 2026 (EDT, no DST change). A draw
 * is one sample at 117 °F (a 3 °F fall, then recovery): `drawAt(day)` returns the [hour, minute] of that day's
 * draw, or null for none.
 */
function history(days: number, drawAt: (day: number) => [number, number] | null): Row[] {
  const rows: Row[] = [];
  for (let day = 0; day < days; day++) {
    const draw = drawAt(day);
    for (let m = 0; m < 24 * 60; m += 5) {
      const ts = new Date(2026, 8, 1 + day, 0, m, 0);
      const isDraw = draw !== null && ts.getHours() === draw[0] && ts.getMinutes() === draw[1];
      rows.push({ ts, tankF: isDraw ? 117 : 120 });
    }
  }
  return rows;
}

// < 100 rows → null, however clear the pattern
assert.equal(learnDhwWindows(history(1, () => [7, 10]).slice(0, 99)), null, "99 rows is too little history");

// < minDays local days → null
assert.equal(learnDhwWindows(history(4, () => [7, 10])), null, "4 days < minDays 5");
assert.notEqual(learnDhwWindows(history(4, () => [7, 10]), 4), null, "4 days ≥ minDays 4");

// no hour reaching the threshold → null: a single draw in 5 days scores 0.2 < 0.25; no draws at all scores 0
assert.equal(learnDhwWindows(history(5, (d) => (d === 0 ? [7, 10] : null))), null, "1 of 5 days < 0.25");
assert.equal(learnDhwWindows(history(5, () => null)), null, "no draws");

// a 07:xx draw on 2 of 8 days (exactly 0.25) → hour 7 padded ±1 h → [6, 9)
{
  const rows = history(8, (d) => (d < 2 ? [7, 10] : null));
  const r = learnDhwWindows(rows);
  assert.ok(r);
  assert.equal(r.days, 8);
  assert.equal(r.hourScores[7], 0.25);
  assert.deepEqual(r.windows, [[6, 9]]);
}

// hour 23 hot: padding wraps to hour 0, merging does not wrap → two ranges
{
  const r = learnDhwWindows(history(5, () => [23, 30]));
  assert.ok(r);
  assert.deepEqual(r.windows, [[0, 1], [22, 24]]);
}

// 5 full local days with a 21:30 draw every day: 5 days (not the 6 UTC dates they span), hour 21 on every one.
{
  const rows = history(5, () => [21, 30]);
  const r = learnDhwWindows(rows);
  assert.ok(r);
  assert.equal(r.days, 5, "local days, not UTC dates");
  assert.equal(r.hourScores[21], 1, "21:30 local is 01:30Z next day — still the same local day");
  assert.equal(r.hourScores.filter((s) => s > 0).length, 1, "only hour 21 scores");
  assert.deepEqual(r.windows, [[20, 23]]);
}

// drawEvents is detectDrawTimes' count — one definition of "a draw"
{
  const rows = history(6, (d) => (d % 2 ? [7, 10] : [18, 45]));
  const r = learnDhwWindows(rows);
  assert.ok(r);
  assert.equal(r.drawEvents, detectDrawTimes(rows).length);
  assert.equal(r.drawEvents, 6);
}

console.log("dhw-learn: ok");
