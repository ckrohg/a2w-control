/**
 * @purpose Assertions for slx-reading.ts: the SensorLinx device object → SlxReading mapping every planner alarm and
 * the Phase B command read. A field rename upstream must surface here as null, not as a silent 0 or a crash.
 * Run with: npx tsx planner/src/slx-reading.test.ts
 */
import assert from "node:assert/strict";
import { toReading } from "./slx-reading";

const NOW = new Date("2026-10-27T12:00:00Z");

// A full ECO-0600 device object, shaped like the api.sensorlinx.co payload (relay map: 1=HP1, 2=HP2, 3=blank, 4=backup).
const full = {
  syncCode: "AECO-2036",
  connected: true,
  temps: {
    temp1: { actual: 128.4, target: 132 },
    temp2: { actual: 101.2, target: null },
    temp3: { actual: 31.5 },
  },
  demands: [
    { name: "hd", activated: true },
    { name: "cd", activated: false },
    { name: "dhw", activated: true },
  ],
  stages: [{ activated: true }, { activated: false }],
  backup: { activated: false },
  relStat: [1, 0, 1, 1],
};

// 1. a full device object maps every field
assert.deepEqual(toReading(full, NOW), {
  ts: NOW,
  tankF: 128.4,
  tankTargetF: 132,
  outdoorF: 31.5,
  hdActive: true,
  cdActive: false,
  stagesCalled: [true, false],
  backupCalled: false,
  relays: 13,
  connected: true,
});

// 2. relStat is little-endian: index i is bit i — [1,0,1,1] → 0b1101
assert.equal(toReading({ relStat: [1, 0, 1, 1] }, NOW).relays, 0b1101);
assert.equal(toReading({ relStat: [] }, NOW).relays, 0, "an empty relStat is all relays off, not unknown");
assert.equal(toReading({ relStat: [0, 0, 0, 0] }, NOW).relays, 0);

// 3. truthy non-1 bits count as set; falsy ones do not
assert.equal(toReading({ relStat: [2, "on", true, 0] }, NOW).relays, 0b0111);
assert.equal(toReading({ relStat: [null, undefined, "", 1] }, NOW).relays, 0b1000);

// 4. stage flags are strictly `activated === true`: undefined (or a truthy non-boolean) is not a call
assert.deepEqual(toReading({ stages: [{}, { activated: undefined }, { activated: true }, { activated: 1 }] }, NOW).stagesCalled,
  [false, false, true, false]);
assert.deepEqual(toReading({ stages: [] }, NOW).stagesCalled, []);

// 5. anything missing is null — not 0, not a throw
{
  const r = toReading({}, NOW);
  assert.deepEqual(r, {
    ts: NOW, tankF: null, tankTargetF: null, outdoorF: null, hdActive: null, cdActive: null,
    stagesCalled: null, backupCalled: null, relays: null, connected: null,
  });
}
assert.equal(toReading({ temps: {} }, NOW).tankF, null, "temps without temp1");
assert.equal(toReading({ temps: { temp1: {} } }, NOW).tankTargetF, null, "temp1 without target");
assert.equal(toReading({ temps: { temp1: { actual: 120 } } }, NOW).outdoorF, null, "temps without temp3");
assert.equal(toReading({ backup: {} }, NOW).backupCalled, null);
assert.equal(toReading({ stages: { activated: true } }, NOW).stagesCalled, null, "a non-array stages is unknown");
assert.equal(toReading({ relStat: 13 }, NOW).relays, null, "a non-array relStat is unknown");
assert.equal(toReading({ connected: false }, NOW).connected, false, "false survives (not coalesced to null)");
assert.equal(toReading({ temps: { temp1: { actual: 0, target: 0 }, temp3: { actual: 0 } } }, NOW).tankF, 0, "a real 0 °F survives");
assert.equal(toReading({ temps: { temp3: { actual: 0 } } }, NOW).outdoorF, 0);

// 6. demands are looked up by name; order does not matter and unknown names are ignored
{
  const r = toReading({ demands: [{ name: "dhw", activated: true }, { name: "cd", activated: true }, { name: "hd", activated: false }] }, NOW);
  assert.equal(r.hdActive, false);
  assert.equal(r.cdActive, true);
}
{
  const r = toReading({ demands: [{ name: "dhw", activated: true }, { name: "HD", activated: true }] }, NOW);
  assert.equal(r.hdActive, null, "unknown / differently-cased names are ignored");
  assert.equal(r.cdActive, null);
}
assert.equal(toReading({ demands: [{ name: "hd" }] }, NOW).hdActive, null, "hd present without activated is unknown");
assert.equal(toReading({ demands: [] }, NOW).hdActive, null);

// 7. now defaults to the wall clock
{
  const before = Date.now();
  const ts = toReading({}).ts.getTime();
  assert.ok(ts >= before && ts <= Date.now());
}

console.log("slx-reading.test.ts: all assertions passed");
