/**
 * @purpose #135: measureWindowSags — the draw sag per learned window, from synthetic tank history.
 * Run with: npx tsx planner/src/dhw-sag.test.ts
 */
import assert from "node:assert/strict";
import { measureWindowSags, SAG_HORIZON_MIN } from "./dhw";

// Five days of 5-min samples at 120 °F. Each evening at 18:10 local a shower: three consecutive 2.5 °F
// drops (one draw, merged), trough 112.5, recovering 1 °F per sample after 30 min. Mornings: one 2 °F
// blip at 07:00 (a single-sample draw, sag 2) on two days only.
const rows: { ts: Date; tankF: number }[] = [];
for (let day = 0; day < 5; day++) {
  for (let m = 0; m < 24 * 60; m += 5) {
    const ts = new Date(2026, 8, 20 + day, 0, m, 0);
    const h = ts.getHours(), mm = ts.getMinutes();
    let tankF = 120;
    const sinceDraw = (h - 18) * 60 + (mm - 10);
    if (h === 18 && mm >= 15 && mm <= 25) tankF = 120 - 2.5 * ((mm - 10) / 5);   // 117.5, 115, 112.5
    else if (sinceDraw > 15 && sinceDraw <= 45) tankF = 112.5;                       // trough holds 30 min
    else if (sinceDraw > 45 && sinceDraw <= 80) tankF = 112.5 + (sinceDraw - 45) / 5; // recovers
    if (day < 2 && h === 7 && mm === 5) tankF = 118; // morning blip
    rows.push({ ts, tankF });
  }
}
const sags = measureWindowSags(rows, [[6, 9], [17, 22]]);
assert.equal(sags.length, 2);
const [morning, evening] = sags;
assert.equal(evening.windowStart, 17);
assert.equal(evening.n, 5, "one merged draw per evening, five evenings");
assert.equal(evening.sagP75F, 7.5, "pre 120 − trough 112.5");
assert.equal(evening.sagMedianF, 7.5);
assert.equal(evening.preDrawMedianF, 120);
assert.equal(evening.troughMedianF, 112.5);
assert.equal(morning.n, 2, "two single-sample morning blips");
assert.equal(morning.sagP75F, 2, "a 2 °F blip is a 2 °F sag — below the 3 °F boost floor");
// a window with no draws reports zeros, not NaN
const none = measureWindowSags(rows, [[11, 13]]);
assert.deepEqual(none[0], { windowStart: 11, windowEnd: 13, n: 0, sagP75F: 0, sagMedianF: 0, preDrawMedianF: 0, troughMedianF: 0 });
// the trough is looked for within SAG_HORIZON_MIN only: a slow, unrelated sag 70+ min later (below
// DROP_F per sample, so not a draw of its own) does not deepen this draw's trough
const late = rows.map((r) => ({ ...r }));
for (const r of late) if (r.ts.getHours() === 19 && r.ts.getMinutes() >= 20) r.tankF = 120 - 1.2 * ((r.ts.getMinutes() - 15) / 5);
const sags2 = measureWindowSags(late, [[17, 22]]);
assert.equal(sags2[0].n, 5, "the slow sag is not a new draw");
assert.equal(sags2[0].sagP75F, 7.5, `a sag ${SAG_HORIZON_MIN}+ min later is not this draw's trough`);
console.log("dhw-sag.test.ts: all assertions passed");
