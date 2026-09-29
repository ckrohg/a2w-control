/**
 * @purpose #136: the per-poll floor re-check's pure pieces. Run with: npx tsx planner/src/floor-cadence.test.ts
 */
import assert from "node:assert/strict";
import { advanceCallMinutes, decideFloorRaise, FLOOR_RAISE_MIN_F, CALL_SAMPLE_GAP_CAP_MIN } from "./floor-cadence";

// advanceCallMinutes: elapsed time credited (capped), non-callers forgotten, null feed leaves the clock alone
{
  const m = new Map<string, number>([["a", 10], ["b", 50]]);
  advanceCallMinutes(m, ["a", "c"], 5);
  assert.deepEqual([...m.entries()].sort(), [["a", 15], ["c", 5]], "a gains 5, c starts at 5, b (stopped) is forgotten");
  advanceCallMinutes(m, ["a", "c"], 90); // a 90-min telemetry hole is credited only up to the cap
  assert.equal(m.get("a"), 15 + CALL_SAMPLE_GAP_CAP_MIN);
  advanceCallMinutes(m, null, 5); // no live call feed → unknown, not "stopped"
  assert.equal(m.get("a"), 15 + CALL_SAMPLE_GAP_CAP_MIN);
  advanceCallMinutes(m, ["a"], NaN);
  assert.equal(m.get("a"), 15 + CALL_SAMPLE_GAP_CAP_MIN, "a bad elapsed value credits nothing");
  assert.equal(m.has("c"), false);
}

// decideFloorRaise
{
  const block = { ts: "2026-11-20T13:00:00Z", tank_target_f: 120, reason: "DHW window floor" };
  const base = { block, floorF: 128, bindingZone: "Upstairs Baseboard", awtF: 123.5, outdoorF: 30, winterGuardF: 50, bandHiF: 135, now: new Date("2026-11-20T13:07:00Z") };
  const d = decideFloorRaise(base);
  assert.equal(d.raise, true);
  if (d.raise) {
    assert.equal(d.fromF, 120); assert.equal(d.toF, 128); assert.equal(d.ts, block.ts);
    assert.match(d.reason, /^binding zone: Upstairs Baseboard needs 124°F \(winter solver shadow; floor re-check 13:07Z raised the block from 120°F\)$/);
  }
  // raises only: a floor below or within the threshold of the block does nothing
  assert.equal(decideFloorRaise({ ...base, floorF: 110 }).raise, false, "never lower off-cycle");
  assert.equal(decideFloorRaise({ ...base, floorF: 120 + FLOOR_RAISE_MIN_F - 1 }).raise, false, "below the write-worthy gap");
  assert.equal(decideFloorRaise({ ...base, floorF: 120 + FLOOR_RAISE_MIN_F }).raise, true, "exactly the gap raises");
  // only where the hourly plan would apply the floor
  assert.equal(decideFloorRaise({ ...base, outdoorF: 55 }).raise, false, "above the winter guard the plan applies no floor");
  // never over a soak; a bank / pre-boost below the floor IS raised (identity is dropped by the store)
  assert.equal(decideFloorRaise({ ...base, block: { ...block, tank_target_f: 140, sani: true }, floorF: 145 }).raise, false);
  assert.equal(decideFloorRaise({ ...base, block: { ...block, tank_target_f: 124, boost: true }, floorF: 130 }).raise, true);
  // band-clamped
  const clamped = decideFloorRaise({ ...base, floorF: 150, bandHiF: 133 });
  assert.equal(clamped.raise && clamped.toF, 133);
  // degraded inputs fail closed
  assert.equal(decideFloorRaise({ ...base, block: null }).raise, false);
  assert.equal(decideFloorRaise({ ...base, floorF: null }).raise, false);
  assert.equal(decideFloorRaise({ ...base, outdoorF: null }).raise, false);
}
console.log("floor-cadence.test.ts: all assertions passed");
