/**
 * @purpose Assertions for decay.ts: the pure quiet-window scanner (findQuietDecays) that feeds the DP's
 * standby-loss term, and decayScanOnce's store contract. Series are built on the 5-min SensorLinx cadence.
 * Run with: npx tsx planner/src/decay.test.ts
 */
import assert from "node:assert/strict";
import { findQuietDecays, decayScanOnce, type DecayFit } from "./decay";
import type { Store } from "./store";

type Sample = { ts: Date; tankF: number | null; anyCall: boolean };

const T0 = new Date("2026-10-25T03:00:00Z").getTime(); // a quiet night, no calls
const STEP_MIN = 5;
const at = (min: number) => new Date(T0 + min * 60_000);

/** One sample per 5 min from `startMin`; `tankAt(i)` gives the tank at the i-th sample. */
function cadence(startMin: number, count: number, tankAt: (i: number) => number | null, anyCall = false): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < count; i++) out.push({ ts: at(startMin + i * STEP_MIN), tankF: tankAt(i), anyCall });
  return out;
}

/** A gentle linear decline: `count` samples from `startF` losing `totalDropF` over the window. */
function decline(startMin: number, count: number, startF: number, totalDropF: number): Sample[] {
  return cadence(startMin, count, (i) => startF - (i / (count - 1)) * totalDropF);
}

const starts = (fits: DecayFit[]) => fits.map((f) => f.windowStart.getTime());

// 1. A clean 2 h decline of 1.0 °F (25 samples, 0..120 min) is one fit: hours 2, slope -0.5 °F/h.
{
  const fits = findQuietDecays(decline(0, 25, 130, 1.0));
  assert.equal(fits.length, 1);
  const f = fits[0];
  assert.equal(f.windowStart.getTime(), at(0).getTime());
  assert.equal(f.windowEnd.getTime(), at(120).getTime());
  assert.equal(f.tStartF, 130);
  assert.equal(f.tEndF, 129);
  assert.equal(f.hours, 2);
  assert.equal(f.slopeFPerH, -0.5);
}

// 2. Too short, or too little net decline, yields nothing.
{
  // 1 h window (13 samples), 1.0 °F decline: shorter than MIN_WINDOW_H (1.5 h)
  assert.deepEqual(findQuietDecays(decline(0, 13, 130, 1.0)), []);
  // exactly 1.5 h (19 samples, 0..90 min) is long enough
  const edge = findQuietDecays(decline(0, 19, 130, 1.0));
  assert.equal(edge.length, 1);
  assert.equal(edge[0].hours, 1.5);
  // 2 h but only 0.7 °F net decline: under MIN_NET_DECLINE_F (0.8)
  assert.deepEqual(findQuietDecays(decline(0, 25, 130, 0.7)), []);
  // 2 h with 0.9 °F decline qualifies
  assert.equal(findQuietDecays(decline(0, 25, 130, 0.9)).length, 1);
  // a flat tank never fits
  assert.deepEqual(findQuietDecays(cadence(0, 25, () => 130)), []);
  // degenerate inputs
  assert.deepEqual(findQuietDecays([]), []);
  assert.deepEqual(findQuietDecays(cadence(0, 25, () => null)), []);
  assert.deepEqual(findQuietDecays(decline(0, 25, 130, 1.0).map((s) => ({ ...s, anyCall: true }))), []);
}

// 3. A single-sample drop of >= DRAW_DROP_F (1.2) is a draw: it splits the run and the drop point STARTS
//    the next run, so the fit before the draw ends at the pre-draw sample.
{
  const before = decline(0, 25, 130, 1.0);           // 130 → 129 over 0..120 min
  const after = decline(125, 25, 127.5, 1.0);        // the draw lands 127.5 at 125 min, then 127.5 → 126.5
  const fits = findQuietDecays([...before, ...after]);
  assert.equal(fits.length, 2, JSON.stringify(fits));
  assert.equal(fits[0].windowStart.getTime(), at(0).getTime());
  assert.equal(fits[0].windowEnd.getTime(), at(120).getTime(), "the pre-draw sample closes the first fit");
  assert.equal(fits[0].tEndF, 129);
  assert.equal(fits[1].windowStart.getTime(), at(125).getTime(), "the drop point opens the next run");
  assert.equal(fits[1].tStartF, 127.5);
  assert.equal(fits[1].windowEnd.getTime(), at(245).getTime());
  assert.equal(fits[1].tEndF, 126.5);
  assert.equal(fits[1].hours, 2);
  assert.equal(fits[1].slopeFPerH, -0.5);

  // a 1.0 °F single-sample fall is below the draw threshold: the run continues as one window
  const mild = [...decline(0, 25, 130, 1.0), ...decline(125, 25, 128, 1.0)];
  const one = findQuietDecays(mild);
  assert.equal(one.length, 1);
  assert.equal(one[0].windowStart.getTime(), at(0).getTime());
  assert.equal(one[0].windowEnd.getTime(), at(245).getTime());
  assert.equal(one[0].tEndF, 127);
}

// 4. A rise of >= CHARGE_RISE_F (0.4) is heat input: it splits, and the risen sample opens the next run.
{
  const fits = findQuietDecays([...decline(0, 25, 130, 1.0), ...decline(125, 25, 129.5, 1.0)]); // 129 → 129.5 = +0.5
  assert.equal(fits.length, 2, JSON.stringify(fits));
  assert.equal(fits[0].windowEnd.getTime(), at(120).getTime());
  assert.equal(fits[0].tEndF, 129);
  assert.equal(fits[1].windowStart.getTime(), at(125).getTime());
  assert.equal(fits[1].tStartF, 129.5);
  assert.equal(fits[1].tEndF, 128.5);

  // sensor noise of +0.2 does not split (rise below the threshold)
  const noisy = decline(0, 25, 130, 1.0);
  noisy[12] = { ...noisy[12], tankF: noisy[11].tankF! + 0.2 };
  const one = findQuietDecays(noisy);
  assert.equal(one.length, 1);
  assert.equal(one[0].windowStart.getTime(), at(0).getTime());
  assert.equal(one[0].windowEnd.getTime(), at(120).getTime());
}

// 5. A gap > MAX_GAP_MIN (12 min) breaks continuity; one missed sample (10 min) does not.
{
  const gapped = [...decline(0, 25, 130, 1.0), ...decline(135, 25, 128.9, 1.0)]; // 15-min gap, still declining
  const fits = findQuietDecays(gapped);
  assert.equal(fits.length, 2, JSON.stringify(fits));
  assert.equal(fits[0].windowEnd.getTime(), at(120).getTime());
  assert.equal(fits[1].windowStart.getTime(), at(135).getTime());

  const missedOne = decline(0, 25, 130, 1.0).filter((_, i) => i !== 12); // 55 → 65 min is a 10-min gap
  const one = findQuietDecays(missedOne);
  assert.equal(one.length, 1);
  assert.equal(one[0].hours, 2);
  assert.equal(one[0].slopeFPerH, -0.5);
}

// 6. anyCall=true or tankF=null ends the run; the offending sample belongs to neither window.
{
  const call: Sample = { ts: at(125), tankF: 128.9, anyCall: true };
  const fits = findQuietDecays([...decline(0, 25, 130, 1.0), call, ...decline(130, 25, 128.8, 1.0)]);
  assert.equal(fits.length, 2, JSON.stringify(fits));
  assert.equal(fits[0].windowEnd.getTime(), at(120).getTime());
  assert.equal(fits[1].windowStart.getTime(), at(130).getTime());
  assert.equal(fits[1].tStartF, 128.8);

  const hole: Sample = { ts: at(125), tankF: null, anyCall: false };
  const fits2 = findQuietDecays([...decline(0, 25, 130, 1.0), hole, ...decline(130, 25, 128.8, 1.0)]);
  assert.equal(fits2.length, 2, JSON.stringify(fits2));
  assert.equal(fits2[0].windowEnd.getTime(), at(120).getTime());
  assert.equal(fits2[1].windowStart.getTime(), at(130).getTime());

  // a call in the middle of a window that is otherwise too short on either side yields nothing
  const chopped = [...decline(0, 13, 130, 1.0), { ts: at(65), tankF: 129, anyCall: true }, ...decline(70, 13, 129, 1.0)];
  assert.deepEqual(findQuietDecays(chopped), []);
}

// 7. Two eligible windows separated by a call come back as two fits keyed by distinct windowStart.
{
  const night = [
    ...decline(0, 25, 130, 1.0),                                   // 03:00–05:00
    ...cadence(125, 7, (i) => 129 + i * 1.5, true),                 // a stage call recharges 03:05–03:35 (anyCall)
    ...decline(160, 25, 138, 1.2),                                  // 05:40–07:40 quiet again
  ];
  const fits = findQuietDecays(night);
  assert.equal(fits.length, 2, JSON.stringify(fits));
  const keys = new Set(starts(fits));
  assert.equal(keys.size, 2, "windowStart keys are distinct");
  assert.deepEqual(starts(fits), [at(0).getTime(), at(160).getTime()]);
  assert.equal(fits[1].tStartF, 138);
  assert.ok(Math.abs(fits[1].tEndF - 136.8) < 1e-9, `tEndF ${fits[1].tEndF}`);
  assert.equal(fits[1].slopeFPerH, -0.6);
}

// 8. decayScanOnce: asks the store for the recent series, upserts exactly the fits found, returns the count.
(async () => {
  const series = [...decline(0, 25, 130, 1.0), { ts: at(125), tankF: 128.9, anyCall: true }, ...decline(130, 25, 128.8, 1.0)];
  const expected = findQuietDecays(series);
  assert.equal(expected.length, 2);

  const askedHours: number[] = [];
  const upserted: DecayFit[] = [];
  const store = {
    getRecentSeries: async (hours: number) => { askedHours.push(hours); return series; },
    upsertDecayFit: async (f: DecayFit) => { upserted.push(f); },
  } as unknown as Store;

  const origLog = console.log;
  console.log = () => {}; // decayScanOnce logs a summary line; keep the test output clean
  let n = -1;
  try {
    n = await decayScanOnce(store);
  } finally {
    console.log = origLog;
  }
  assert.equal(n, 2);
  assert.deepEqual(askedHours, [26], "scans the last 26 h");
  assert.deepEqual(upserted, expected, "upserts exactly the fits the scanner found");

  // a series with no quiet window: nothing upserted, count 0
  const quietless = {
    getRecentSeries: async () => decline(0, 13, 130, 1.0),
    upsertDecayFit: async () => { throw new Error("must not upsert when nothing fits"); },
  } as unknown as Store;
  assert.equal(await decayScanOnce(quietless), 0);

  console.log("decay.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
