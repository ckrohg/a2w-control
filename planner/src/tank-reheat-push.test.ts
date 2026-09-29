/**
 * @purpose gtm#1616 Part B input: assertions for the reheat-run finder and aggregate (pure). Run with:
 * npx tsx planner/src/tank-reheat-push.test.ts — exits non-zero on failure.
 */
import assert from "node:assert/strict";
import { findReheatRuns, aggregateReheat, RISE_STEP_F, type TankSample } from "./tank-reheat-push";

const T0 = Date.parse("2026-11-20T06:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000);
const s = (min: number, tankF: number | null, outdoorF: number | null = 40): TankSample => ({ ts: at(min), tankF, outdoorF });

async function main(): Promise<void> {
  // 1. A clean charge: 120 → 136 over 40 min at 5-min cadence = 24 °F/h.
  {
    const series = [s(0, 120), s(5, 122), s(10, 124), s(15, 126), s(20, 128), s(25, 130), s(30, 132), s(35, 134), s(40, 136), s(45, 135.5), s(50, 135.2)];
    const runs = findReheatRuns(series);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].tStartF, 120);
    assert.equal(runs[0].tEndF, 136);
    assert.equal(runs[0].fPerHr, 24);
    assert.equal(runs[0].outdoorF, 40);
  }
  // 2. Standby drift and a draw are not runs; a short blip is not a run; a gap splits a run.
  {
    const standby = [s(0, 130), s(5, 129.8), s(10, 129.6), s(15, 129.5)];
    assert.deepEqual(findReheatRuns(standby), []);
    const draw = [s(0, 130), s(5, 126), s(10, 124), s(15, 125), s(20, 125.2)];
    assert.deepEqual(findReheatRuns(draw), []);
    const blip = [s(0, 120), s(5, 122), s(10, 124), s(15, 123.9)]; // 10 min, +4 — too short
    assert.deepEqual(findReheatRuns(blip), []);
    const gapped = [s(0, 120), s(5, 122), s(10, 124), s(15, 126), s(20, 128), s(45, 130), s(50, 132), s(55, 134), s(60, 136), s(65, 138)];
    const runs = findReheatRuns(gapped);
    assert.equal(runs.length, 2, "a 25-min gap splits the run");
    assert.equal(runs[0].fPerHr, 24);
    assert.equal(runs[1].fPerHr, 24);
  }
  // 3. A sub-threshold sample ends the run (a charge that stalls is two runs, or none).
  {
    const series = [s(0, 120), s(5, 122), s(10, 124), s(15, 126), s(20, 128), s(25, 128.1), s(30, 130), s(35, 132), s(40, 134), s(45, 136), s(50, 138)];
    const runs = findReheatRuns(series);
    assert.equal(runs.length, 2);
    assert.ok(RISE_STEP_F > 0.1);
  }
  // 4. Aggregate: p25 is the conservative figure, median rides along, bands split by outdoor.
  {
    const mk = (fPerHr: number, outdoorF: number, endMin: number) => ({ start: at(endMin - 30), end: at(endMin), tStartF: 120, tEndF: 120 + fPerHr / 2, hours: 0.5, fPerHr, outdoorF });
    const agg = aggregateReheat([mk(10, 20, 30), mk(14, 22, 90), mk(18, 50, 150), mk(22, 52, 210), mk(0.1, 40, 270), mk(90, 40, 330)]);
    assert.ok(agg);
    assert.equal(agg!.nWindows, 4, "out-of-band rates dropped");
    assert.equal(agg!.fPerHr, 13, "p25 of [10,14,18,22] = 13");
    assert.equal(agg!.medianFPerHr, 16);
    assert.equal(agg!.windowEndMs, at(210).getTime());
    const cold = agg!.byBand.find((b) => b.lowF === 15)!;
    const mild = agg!.byBand.find((b) => b.lowF === 45)!;
    assert.equal(cold.n, 2); assert.equal(cold.fPerHr, 11);
    assert.equal(mild.n, 2); assert.equal(mild.fPerHr, 19);
    assert.equal(aggregateReheat([]), null);
    assert.equal(aggregateReheat([mk(0.2, 40, 30)]), null);
  }
  console.log("tank-reheat-push.test.ts: all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
