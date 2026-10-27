// @purpose node:assert suite for lib/tank-coast.ts: the formula matches the planner's coast_h; the END POINT is the
// next reheat — max(floor, plan lead − ht_dif/2) — never the raw SensorLinx report (#215); and missing / stale /
// non-physical inputs hide the projection. Run: npx tsx tests/tank-coast.test.ts
import assert from "node:assert/strict";
import { coastEndF, coastHours, coastLine, restoredTargetF, THERMAL_MAX_AGE_MS, type ThermalRead } from "../lib/tank-coast";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const fresh = new Date(NOW - 2 * 60_000).toISOString();
/** the live fit, /health.thermal.tank_ua (1,429 decay samples) */
const UA = 0.01906;
const th = { at: fresh, tank_f: 118, dhw_floor_f: 120, tank_ua: UA };
/** October: the plan commands the 120 °F floor and the report is honest. */
const oct: ThermalRead = { thermal: th, lead: { plan_f: 120, plan_basis: "curve", operative_f: 119.7, operative_basis: "report" }, plan_implies_f: 120 };
/** Winter: a 130 °F curve. */
const winter: ThermalRead = { thermal: th, lead: { plan_f: 130, plan_basis: "curve", operative_f: 130.2, operative_basis: "report" }, plan_implies_f: 130 };
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };
const near = (a: number | null, b: number, tol = 0.05) => assert.ok(a != null && Math.abs(a - b) < tol, `${a} ≈ ${b}`);

t("formula: ln((T-65)/(end-65))/ua — the planner's coast_h", () => {
  assert.ok(Math.abs(coastHours(131, 110, 0.017)! - Math.log(66 / 45) / 0.017) < 1e-9);
  assert.ok(Math.abs(coastHours(131, 110, 0.017)! - 22.5) < 0.1);
});
t("a hotter target lasts longer", () => assert.ok(coastHours(135, 110, 0.017)! > coastHours(125, 110, 0.017)!));
t("T <= end: null", () => {
  assert.equal(coastHours(110, 110, 0.017), null);
  assert.equal(coastHours(100, 110, 0.017), null);
});
t("missing or bad ua: null", () => {
  for (const ua of [null, undefined, 0, -0.01, NaN]) assert.equal(coastHours(131, 110, ua as number), null);
});
t("end at/under ambient: null (log undefined)", () => {
  assert.equal(coastHours(131, 65, 0.017), null);
  assert.equal(coastHours(131, 60, 0.017), null);
});

t("end point: the next reheat is max(floor, restored − ht_dif/2)", () => {
  assert.deepEqual(coastEndF(120, 120, 4), { endF: 120, atFloor: true }); // October: plan = floor
  assert.deepEqual(coastEndF(120, 130, 4), { endF: 128, atFloor: false }); // winter curve
  assert.deepEqual(coastEndF(120, 130, 6), { endF: 127, atFloor: false }); // the device's own differential
  assert.deepEqual(coastEndF(120, 130, null), { endF: 128, atFloor: false }); // none on record → 4
  assert.deepEqual(coastEndF(120, 121, 4), { endF: 120, atFloor: true }); // reheat under the floor: the floor
  assert.deepEqual(coastEndF(120, null, 4), { endF: 120, atFloor: true }); // no plan at all: the floor
});
t("restored target: the plan lead, else the plan curve's output, else nothing", () => {
  assert.equal(restoredTargetF(winter), 130);
  assert.equal(restoredTargetF({ thermal: th, lead: { plan_f: null }, plan_implies_f: 126 }), 126);
  assert.equal(restoredTargetF({ thermal: th, lead: null, plan_implies_f: 126 }), 126);
  assert.equal(restoredTargetF({ thermal: th }), null);
  assert.equal(restoredTargetF({ thermal: th, lead: { plan_f: "130" }, plan_implies_f: "126" }), null);
});

t("October: 135 °F coasts ≈ 12.6 h down to the 120 °F floor", () => {
  near(coastHours(135, 120, UA), 12.65);
  assert.equal(coastLine(oct, 135, NOW, 4), "after the boost to 135 °F: coasts ≈ 12.7 h above the 120 °F hot-water floor");
});
t("winter: a 130 °F curve reheats at 128, so 135 °F coasts ≈ 5.5 h — not 12.6", () => {
  near(coastHours(135, 128, UA), 5.53);
  assert.equal(coastLine(winter, 135, NOW, 4), "after the boost to 135 °F: coasts ≈ 5.5 h to the next reheat at 128 °F");
});
t("stale report (#215): a frozen 140 °F SensorLinx report is never the end point", () => {
  // 2026-10-25 night: report 140.1 frozen after the soak, proof found, the auto-pilot commanding 120
  const proven: ThermalRead = { thermal: th, lead: { plan_f: 120, plan_basis: "curve", operative_f: 119.6, operative_basis: "stale→curve" }, plan_implies_f: 120 };
  assert.equal(coastLine(proven, 135, NOW, 4), coastLine(oct, 135, NOW, 4));
  // the same report before the proof lands (operative still the report): still the plan term, still ≈ 12.6 h, not 0
  const unproven: ThermalRead = { thermal: th, lead: { plan_f: 120, plan_basis: "curve", operative_f: 140.1, operative_basis: "report" }, plan_implies_f: 120 };
  assert.equal(coastLine(unproven, 135, NOW, 4), coastLine(oct, 135, NOW, 4));
  assert.match(coastLine(unproven, 135, NOW, 4)!, /12\.\d h above the 120 °F hot-water floor/);
});
t("fallback: no plan lead → the plan curve's output; neither → the floor", () => {
  const curveOnly: ThermalRead = { thermal: th, lead: { plan_f: null, plan_basis: "none" }, plan_implies_f: 130 };
  assert.equal(coastLine(curveOnly, 135, NOW, 4), coastLine(winter, 135, NOW, 4));
  const nothing: ThermalRead = { thermal: th, lead: null, plan_implies_f: null };
  assert.equal(coastLine(nothing, 135, NOW, 4), coastLine(oct, 135, NOW, 4));
});
t("ht_dif from the writer status sizes the band; missing → 4", () => {
  near(coastHours(135, 127, UA), 6.37); // a wider band ends lower, so the coast is LONGER than the 4 °F case
  assert.equal(coastLine(winter, 135, NOW, 6), "after the boost to 135 °F: coasts ≈ 6.4 h to the next reheat at 127 °F");
  assert.equal(coastLine(winter, 135, NOW, undefined), coastLine(winter, 135, NOW, 4));
  assert.equal(coastLine(winter, 135, NOW, null), coastLine(winter, 135, NOW, 4));
  assert.equal(coastLine(winter, 135, NOW, "4"), coastLine(winter, 135, NOW, 4));
});
t("a boost at/under the restored target's reheat band: nothing to project", () => {
  assert.equal(coastLine(winter, 128, NOW, 4), null);
  assert.equal(coastLine(winter, 125, NOW, 4), null);
  assert.equal(coastLine(oct, 120, NOW, 4), null);
});
t("hidden when the thermal read is missing", () => {
  assert.equal(coastLine(null, 131, NOW), null);
  assert.equal(coastLine(undefined, 131, NOW), null);
  assert.equal(coastLine({}, 131, NOW), null);
  assert.equal(coastLine({ thermal: null, lead: winter.lead }, 131, NOW), null);
});
t("hidden when a thermal field it needs is missing or the wrong type", () => {
  for (const k of ["dhw_floor_f", "tank_ua", "at"] as const)
    assert.equal(coastLine({ ...oct, thermal: { ...th, [k]: undefined } }, 131, NOW), null, k);
  assert.equal(coastLine({ ...oct, thermal: { ...th, tank_ua: "0.019" } }, 131, NOW), null);
  assert.equal(coastLine({ ...oct, thermal: { ...th, dhw_floor_f: null } }, 131, NOW), null);
  // tank_f is not printed, so its absence does not hide the projection
  assert.ok(coastLine({ ...oct, thermal: { ...th, tank_f: null } }, 131, NOW));
});
t("hidden when stale, unparseable or from the future", () => {
  const at = (iso: string): ThermalRead => ({ ...oct, thermal: { ...th, at: iso } });
  assert.equal(coastLine(at(new Date(NOW - THERMAL_MAX_AGE_MS - 1).toISOString()), 131, NOW), null);
  assert.ok(coastLine(at(new Date(NOW - THERMAL_MAX_AGE_MS + 60_000).toISOString()), 131, NOW));
  assert.equal(coastLine(at("yesterday"), 131, NOW), null);
  assert.equal(coastLine(at(new Date(NOW + 3_600_000).toISOString()), 131, NOW), null);
});
console.log(`${n} passed`);
