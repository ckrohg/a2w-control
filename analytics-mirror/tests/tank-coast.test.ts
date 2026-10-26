// @purpose node:assert suite for lib/tank-coast.ts: the formula matches the planner's coast_h, and
// missing / stale / non-physical inputs hide the projection. Run: npx tsx tests/tank-coast.test.ts
import assert from "node:assert/strict";
import { coastHours, coastLine, THERMAL_MAX_AGE_MS } from "../lib/tank-coast";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const fresh = new Date(NOW - 2 * 60_000).toISOString();
const th = { at: fresh, tank_f: 118, dhw_floor_f: 110, tank_ua: 0.017 };
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };

t("formula: ln((T-65)/(floor-65))/ua", () => {
  assert.ok(Math.abs(coastHours(131, 110, 0.017)! - Math.log(66 / 45) / 0.017) < 1e-9);
  assert.ok(Math.abs(coastHours(131, 110, 0.017)! - 22.5) < 0.1);
});
t("a hotter target lasts longer", () => assert.ok(coastHours(135, 110, 0.017)! > coastHours(125, 110, 0.017)!));
t("T <= floor: null", () => {
  assert.equal(coastHours(110, 110, 0.017), null);
  assert.equal(coastHours(100, 110, 0.017), null);
});
t("missing or bad ua: null", () => {
  for (const ua of [null, undefined, 0, -0.01, NaN]) assert.equal(coastHours(131, 110, ua as number), null);
});
t("floor at/under ambient: null (log undefined)", () => {
  assert.equal(coastHours(131, 65, 0.017), null);
  assert.equal(coastHours(131, 60, 0.017), null);
});
t("line states tank now, target and hours", () =>
  assert.equal(coastLine(th, 131, NOW), "Tank now 118 °F → boosted to 131 °F; lasts about 22.5 h on standing loss alone"));
t("hidden when thermal is missing", () => {
  assert.equal(coastLine(null, 131, NOW), null);
  assert.equal(coastLine(undefined, 131, NOW), null);
  assert.equal(coastLine({}, 131, NOW), null);
});
t("hidden when a field is missing or the wrong type", () => {
  for (const k of ["tank_f", "dhw_floor_f", "tank_ua", "at"] as const)
    assert.equal(coastLine({ ...th, [k]: undefined }, 131, NOW), null, k);
  assert.equal(coastLine({ ...th, tank_f: "118" }, 131, NOW), null);
  assert.equal(coastLine({ ...th, tank_f: null }, 131, NOW), null);
});
t("hidden when stale, unparseable or from the future", () => {
  assert.equal(coastLine({ ...th, at: new Date(NOW - THERMAL_MAX_AGE_MS - 1).toISOString() }, 131, NOW), null);
  assert.ok(coastLine({ ...th, at: new Date(NOW - THERMAL_MAX_AGE_MS + 60_000).toISOString() }, 131, NOW));
  assert.equal(coastLine({ ...th, at: "yesterday" }, 131, NOW), null);
  assert.equal(coastLine({ ...th, at: new Date(NOW + 3_600_000).toISOString() }, 131, NOW), null);
});
t("hidden when the target is at or under the floor", () => assert.equal(coastLine(th, 110, NOW), null));
console.log(`${n} passed`);
