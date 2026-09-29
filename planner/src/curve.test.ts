/**
 * @purpose #133 (b): assertions for the demand-shaped reset curve (pure). Run with:
 * npx tsx planner/src/curve.test.ts — exits non-zero on failure.
 */
import assert from "node:assert/strict";
import { shapeCurve, curveOutputF, sameCurve, demandTargetF, MIN_CURVE_SPREAD_F, ANCHOR_MARGIN_F } from "./curve";
import type { InsightZone } from "./demand";
import { requiredAwtF, BUFFER_MARGIN_F } from "./demand";

const z = (id: string, deliveryType: string): InsightZone => ({
  id, name: id, deliveryType, deliveryTypeVerified: true, uaBtuHrF: null, thermalMassBtuF: null, confidence: null,
  requiredSupplyF: null, ceilingSource: null, roomF: 68, setpointF: 68,
} as unknown as InsightZone);
const zones = [z("baseboard", "baseboard"), z("radiant", "radiant_floor"), z("kumo", "mini_split")];
// The as-found HBX curve: 165 °F at 5 °F, 140 °F at 125 °F (the pilot's baseline shape)
const baseline = { dot: 5, wwsd: 125, dbt: 165, mbt: 140 };
const base = { zones, wwsd: 125, hbxBaseline: baseline };

async function main(): Promise<void> {
  // 1. Demand at an outdoor: the binding CALLING zone + margin, floored by the DHW floor.
  {
    const d = demandTargetF({ ...base, callingZoneIds: ["baseboard"] }, 20);
    assert.equal(d.binding, "baseboard");
    assert.equal(d.targetF, Math.round((requiredAwtF("baseboard", 20)! + BUFFER_MARGIN_F) * 10) / 10);
    const mild = demandTargetF({ ...base, callingZoneIds: ["baseboard"] }, 50);
    assert.equal(mild.targetF, 120, "below the floor → the floor");
    assert.equal(mild.flooredBy, "floor");
    const none = demandTargetF({ ...base, callingZoneIds: [] }, 20);
    assert.equal(none.targetF, 120, "nobody calling → the floor");
    assert.equal(none.binding, null);
  }
  // 2. Conservative curve (no anchor): the design point is 5 °F, where the envelope pins dbt at 135; mbt = floor.
  {
    const c = shapeCurve({ ...base, callingZoneIds: null });
    assert.equal(c.dot, 5);
    assert.equal(c.dbt, 135);
    assert.equal(c.mbt, 120);
    assert.equal(c.basis.conservative, true);
    assert.equal(c.basis.dbtClampedBy, "envelope_hi", "demand 139.5 at 5 °F is clamped to the 135 cap");
    assert.equal(curveOutputF(c, 5), 135);
    assert.equal(curveOutputF(c, 125), 120);
    assert.ok(Math.abs(curveOutputF(c, 65) - 127.5) < 0.01, "a straight line between the endpoints");
    assert.equal(curveOutputF(c, -10), 135, "below dot the device holds dbt");
  }
  // 3. Anchored at the forecast minimum: the design point moves to (anchor − margin), so a mild week gives a
  //    line at the floor instead of the 11 °F-hot conservative line.
  {
    const c = shapeCurve({ ...base, callingZoneIds: ["baseboard"], anchorOutdoorF: 45 });
    assert.equal(c.dot, 45 - ANCHOR_MARGIN_F);
    assert.equal(c.basis.dbtDemandF, 120, "baseboard demand at 35 °F is under the floor → the floor");
    assert.equal(c.dbt, 120);
    assert.equal(c.mbt, 118, "a flat line would be ignored → mbt lowered by the minimum spread");
    assert.equal(c.basis.spreadForced, true);
    assert.equal(c.dbt - c.mbt, MIN_CURVE_SPREAD_F);
    assert.ok(curveOutputF(c, 40) <= 120 && curveOutputF(c, 40) >= 118);
  }
  {
    // A cold snap forecast (min 15 °F) with the baseboard calling: the design point is 5 °F (the device floor)
    // and the envelope pins dbt at 135 — the conservative line — because 5 °F really is the design outdoor.
    const c = shapeCurve({ ...base, callingZoneIds: ["baseboard"], anchorOutdoorF: 15 });
    assert.equal(c.dot, 5);
    assert.equal(c.dbt, 135);
    assert.ok(curveOutputF(c, 15) >= Math.round((requiredAwtF("baseboard", 15)! + BUFFER_MARGIN_F) * 10) / 10, "the line serves demand at the forecast minimum");
  }
  {
    // A moderate forecast (min 30 °F): the design point is 20 °F, where baseboard demand (≈126) beats the
    // envelope's lower bound (123) and the floor — dbt follows DEMAND, not the envelope.
    const c = shapeCurve({ ...base, callingZoneIds: ["baseboard"], anchorOutdoorF: 30 });
    assert.equal(c.dot, 20);
    const demand20 = Math.round((requiredAwtF("baseboard", 20)! + BUFFER_MARGIN_F) * 10) / 10;
    assert.equal(c.basis.dbtDemandF, demand20);
    assert.equal(c.dbt, Math.round(demand20));
    assert.equal(c.basis.dbtClampedBy, null);
    assert.ok(curveOutputF(c, 30) < 135 && curveOutputF(c, 30) >= 120);
    // a two-point line cannot follow the concave demand curve exactly; the overshoot at mild temps is bounded
    // (≈6 °F here vs 11 °F for the conservative 5 °F design point) — the cost of a weather-compensating fallback
    assert.ok(curveOutputF(c, 35) - 120 <= 7, `mild-day overshoot stays bounded: ${curveOutputF(c, 35)} at 35 °F`);
    assert.ok(curveOutputF(c, 35) < curveOutputF(shapeCurve({ ...base, callingZoneIds: ["baseboard"] }), 35), "…and below the conservative line");
    assert.equal(curveOutputF(c, 0), c.dbt, "colder than the design point → holds dbt (bounded under-service)");
  }
  // 4. Radiant-only calling: demand is always under the floor on this plant; at the 5 °F design point the
  //    envelope's lower bound (135) — not demand — sets dbt.
  {
    const c = shapeCurve({ ...base, callingZoneIds: ["radiant"] });
    assert.equal(c.basis.dbtBinding, "radiant");
    assert.equal(c.dbt, 135);
    assert.equal(c.basis.dbtClampedBy, "envelope_lo");
    assert.equal(c.mbt, 120);
    const mild = shapeCurve({ ...base, callingZoneIds: ["radiant"], anchorOutdoorF: 40 });
    assert.equal(mild.dot, 30);
    assert.equal(mild.dbt, 120, "at 30 °F the envelope's lower bound (115) is under the floor → the floor");
  }
  // 5. The design point is kept inside [MIN_DOT_F, wwsd − gap].
  {
    assert.equal(shapeCurve({ ...base, callingZoneIds: ["baseboard"], anchorOutdoorF: -30 }).dot, 5);
    assert.equal(shapeCurve({ ...base, callingZoneIds: ["baseboard"], anchorOutdoorF: 200 }).dot, 125 - 20);
  }
  // 6. sameCurve: endpoint tolerance.
  {
    assert.equal(sameCurve({ dbt: 135, mbt: 120 }, { dbt: 136, mbt: 119 }), true);
    assert.equal(sameCurve({ dbt: 135, mbt: 120 }, { dbt: 138, mbt: 120 }), false);
    assert.equal(sameCurve({ dbt: 135, mbt: 120 }, null), false);
  }
  console.log("curve.test.ts: all assertions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
