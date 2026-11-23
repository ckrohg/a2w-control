/**
 * @purpose #135: measureWindowSags — the draw sag per learned window, from synthetic tank history.
 * Run with: npx tsx planner/src/dhw-sag.test.ts
 */
import assert from "node:assert/strict";
import { measureWindowSags, peakWindows, mergeWindows, boostWindows, parseShowerWindows, SAG_HORIZON_MIN } from "./dhw";

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
assert.equal(evening.sagP90F, 7.5, "p90 of five equal sags");
assert.equal(evening.sagMedianF, 7.5);
assert.equal(evening.preDrawMedianF, 120);
assert.equal(evening.troughMedianF, 112.5);
assert.equal(morning.n, 2, "two single-sample morning blips");
assert.equal(morning.sagP75F, 2, "a 2 °F blip is a 2 °F sag — below the 3 °F boost floor");
// a window with no draws reports zeros, not NaN
const none = measureWindowSags(rows, [[11, 13]]);
assert.deepEqual(none[0], { windowStart: 11, windowEnd: 13, n: 0, sagP75F: 0, sagP90F: 0, sagMedianF: 0, preDrawMedianF: 0, troughMedianF: 0 });
// the trough is looked for within SAG_HORIZON_MIN only: a slow, unrelated sag 70+ min later (below
// DROP_F per sample, so not a draw of its own) does not deepen this draw's trough
const late = rows.map((r) => ({ ...r }));
for (const r of late) if (r.ts.getHours() === 19 && r.ts.getMinutes() >= 20) r.tankF = 120 - 1.2 * ((r.ts.getMinutes() - 15) / 5);
const sags2 = measureWindowSags(late, [[17, 22]]);
assert.equal(sags2[0].n, 5, "the slow sag is not a new draw");
assert.equal(sags2[0].sagP75F, 7.5, `a sag ${SAG_HORIZON_MIN}+ min later is not this draw's trough`);
// a telemetry gap inside the horizon ends the trough scan: the low reading after the hole is not this draw's trough
const gapped = rows.filter((r) => !(r.ts.getHours() === 18 && r.ts.getMinutes() >= 30 && r.ts.getMinutes() <= 50)); // 25-min hole after the draw
for (const r of gapped) if (r.ts.getHours() === 18 && r.ts.getMinutes() === 55) r.tankF = 95; // a low reading right after the hole
const sags3 = measureWindowSags(gapped, [[17, 22]]);
assert.equal(sags3[0].sagP75F, 7.5, "the scan stops at the gap; 95 °F after the hole is not counted");
// peak windows: unpadded runs of hours at/above the threshold; the padded 25 % windows can span the day
const scores = Array.from({ length: 24 }, (_, h) => (h >= 17 && h <= 19 ? 0.8 : h === 7 ? 0.6 : h === 20 ? 0.4 : 0.3));
assert.deepEqual(peakWindows(scores), [[7, 8], [17, 20]], "two peaks, no padding, 20:00 at 0.4 is not a peak");
assert.deepEqual(peakWindows(scores, 0.3), [[0, 24]], "at the floor threshold everything merges — the reason peaks exist");
assert.deepEqual(peakWindows(Array(24).fill(0)), []);
// p90 sits above p75 when one window's draws vary: ten evenings, sags 4..13 °F → p75 = 11, p90 = 12 (nearest rank).
{
  const varied: { ts: Date; tankF: number }[] = [];
  for (let day = 0; day < 10; day++) {
    const sag = 4 + day;
    for (let m = 0; m < 24 * 60; m += 5) {
      const ts = new Date(2026, 9, 1 + day, 0, m, 0);
      const h = ts.getHours(), mm = ts.getMinutes();
      let tankF = 120;
      if (h === 18 && mm === 15) tankF = 120 - sag;            // one sharp sample: a draw of `sag` °F
      else if (h === 18 && mm > 15 && mm <= 40) tankF = 120 - sag; // trough holds
      varied.push({ ts, tankF });
    }
  }
  const [v] = measureWindowSags(varied, [[17, 22]]);
  assert.equal(v.n, 10);
  assert.equal(v.sagP75F, 11);
  assert.equal(v.sagP90F, 12, "the boost is sized from the worse mornings, not the typical one");
}
// DHW_SHOWER_WINDOWS (owner 2026-10-30): start rounds down, end rounds up, junk is skipped.
{
  const warn = console.warn; const warned: string[] = []; console.warn = (m: string) => { warned.push(m); };
  assert.deepEqual(parseShowerWindows("06:30-10:00"), [[6, 10]]);
  assert.deepEqual(parseShowerWindows(" 06:30 - 10:00 , 19:15-20:45 "), [[6, 10], [19, 21]]);
  assert.deepEqual(parseShowerWindows("10:00-06:30,7-9,25:00-26:00,06:61-08:00,05:00-24:00"), [[5, 24]], "inverted, malformed, past 24:00 and bad minutes are skipped");
  assert.equal(warned.length, 4, "each skipped entry warns once");
  assert.deepEqual(parseShowerWindows(undefined), []); assert.deepEqual(parseShowerWindows("  "), []);
  console.warn = warn;
  assert.deepEqual(mergeWindows([[8, 10], [15, 16]], [[6, 10]]), [[6, 10], [15, 16]], "the declared morning window extends the learned peak");
  assert.deepEqual(mergeWindows([[6, 8]], [[8, 9]]), [[6, 9]], "abutting ranges join");
  assert.deepEqual(mergeWindows([[8, 10]], [[19, 21]]), [[8, 10], [19, 21]], "a separate declared window stays separate");
  assert.deepEqual(mergeWindows([], []), []);
}
// boostWindows (2026-11-23): every declared start opens a window, and the hour before it is in no window.
{
  // 1. nothing declared: the learned peaks exactly, as before
  for (const peaks of [[], [[8, 10]], [[2, 13], [18, 21]], [[0, 24]]] as [number, number][][]) {
    assert.deepEqual(boostWindows(peaks, []), mergeWindows(peaks, []));
    assert.deepEqual(boostWindows(peaks, []), peaks);
  }
  // 2. a declared window away from every peak is its own window; a declared window that starts before a peak and
  //    touches or overlaps it is the plain union, as before
  assert.deepEqual(boostWindows([[8, 10]], [[19, 21]]), [[8, 10], [19, 21]]);
  assert.deepEqual(boostWindows([], [[6, 10]]), [[6, 10]]);
  assert.deepEqual(boostWindows([[8, 10]], [[6, 8]]), [[6, 10]]);
  assert.deepEqual(boostWindows([[8, 10]], [[6, 10]]), [[6, 10]]);
  assert.deepEqual(boostWindows([[8, 10]], [[7, 9]]), [[7, 10]]);
  // 3. PRODUCTION on 2026-11-23: the learned night peak ends where the declared window starts. The plain union was
  //    [2,13] (boost at 01:00); now 05:00 is free and the 06:00 start opens its own window.
  const live: [number, number][] = [[2, 6], [7, 13], [16, 17], [18, 19], [20, 23]];
  assert.deepEqual(mergeWindows(live, [[6, 10]]), [[2, 13], [16, 17], [18, 19], [20, 23]], "what the planner did before");
  assert.deepEqual(boostWindows(live, [[6, 10]]), [[2, 5], [6, 13], [16, 17], [18, 19], [20, 23]]);
  // 4. a learned peak that runs over the declared start: same result
  assert.deepEqual(boostWindows([[2, 13]], [[6, 10]]), [[2, 5], [6, 13]]);
  assert.deepEqual(boostWindows([[2, 14]], [[6, 10]]), [[2, 5], [6, 14]]);
  assert.deepEqual(boostWindows([[2, 13], [18, 21]], [[6, 10]]), [[2, 5], [6, 13], [18, 21]], "other peaks untouched");
  // 5. a learned peak that is only the hour before the declared start is the boost hour itself, and disappears
  assert.deepEqual(boostWindows([[5, 6]], [[6, 10]]), [[6, 10]]);
  assert.deepEqual(boostWindows([[5, 8]], [[6, 10]]), [[6, 10]]);
  // 6. two declared windows inside one long peak: each gets its start and its free hour
  assert.deepEqual(boostWindows([[2, 22]], [[6, 8], [18, 20]]), [[2, 5], [6, 17], [18, 22]]);
  assert.deepEqual(boostWindows([[8, 20]], [[6, 10], [15, 17]]), [[6, 14], [15, 20]]);
  // 7. declared windows that touch or overlap count as one; one declared from midnight has no earlier hour to free
  assert.deepEqual(boostWindows([[2, 13]], [[6, 8], [8, 10]]), [[2, 5], [6, 13]]);
  assert.deepEqual(boostWindows([[0, 9]], [[0, 2]]), [[0, 9]]);
  // 8. inputs not mutated; junk declared windows ignored
  const peaks: [number, number][] = [[18, 21], [2, 13]], declared: [number, number][] = [[6, 10], [4, 4], [9, 7]];
  assert.deepEqual(boostWindows(peaks, declared), [[2, 5], [6, 13], [18, 21]]);
  assert.deepEqual(peaks, [[18, 21], [2, 13]]); assert.deepEqual(declared, [[6, 10], [4, 4], [9, 7]]);
  // 9. the two guarantees, and a well-formed result, over a grid of inputs
  for (const ps of [[[2, 22]], [[2, 6], [7, 13]], [[2, 13], [14, 16]], [[0, 24]], [[5, 9], [10, 23]], []] as [number, number][][]) {
    for (const ds of [[[6, 8], [18, 20]], [[5, 7], [6, 12]], [[1, 2], [23, 24]], [[9, 10]], [[6, 10]]] as [number, number][][]) {
      const w = boostWindows(ps, ds);
      w.forEach(([a, b], i) => {
        assert.ok(a < b, `non-empty ${JSON.stringify(w)}`);
        if (i) assert.ok(w[i - 1][1] <= a, `sorted, no overlap ${JSON.stringify(w)}`);
      });
      for (const [s] of mergeWindows(ds)) {
        assert.ok(w.some(([a]) => a === s), `declared start ${s} opens a window in ${JSON.stringify(w)}`);
        assert.ok(!w.some(([a, b]) => a <= s - 1 && s - 1 < b), `hour ${s - 1} is free in ${JSON.stringify(w)}`);
      }
    }
  }
  console.log("boostWindows: declared starts open a window with a free hour before — all assertions passed");
}
console.log("dhw-sag.test.ts: all assertions passed");
