/**
 * @purpose #133 (b): assertions for the demand-shaped reset curve (pure). Run with:
 * npx tsx planner/src/curve.test.ts — exits non-zero on failure.
 */
import assert from "node:assert/strict";
import { shapeCurve, curveOutputF, sameCurve, demandTargetF, curveWriteGuard, canShapeFromFeed, parseShapedCurveMode, MIN_CURVE_SPREAD_F, ANCHOR_MARGIN_F } from "./curve";
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
  // 5b. curveWriteGuard — the rules setCurve applies, pure (codex on #145).
  {
    const live = { dot: 5, wwsd: 125, dbt: 137, mbt: 133 };       // a near-flat setTarget curve in force
    const ok = { curve: { dot: 20, dbt: 127, mbt: 120, wwsd: 125 }, liveCfg: live, baseline, envelopeCfg: baseline, capF: 135 };
    assert.equal(curveWriteGuard(ok), null);
    // stale plan: the device's wwsd moved after the plan was stamped → 409, never "validate one line, execute another"
    assert.equal(curveWriteGuard({ ...ok, liveCfg: { ...live, wwsd: 110 } })!.status, 409);
    // no live wwsd at all → 503
    assert.equal(curveWriteGuard({ ...ok, liveCfg: { dot: 5, dbt: 137, mbt: 133 } })!.status, 503);
    // the baseline records no dot → moving the design point is refused (restore could not put it back)…
    const noDotBaseline = { wwsd: 125, dbt: 165, mbt: 140 };
    assert.equal(curveWriteGuard({ ...ok, baseline: noDotBaseline, envelopeCfg: noDotBaseline })!.status, 422);
    // …but a curve that keeps the live dot is fine
    assert.equal(curveWriteGuard({ ...ok, curve: { ...ok.curve, dot: 5, dbt: 135 }, baseline: noDotBaseline, envelopeCfg: noDotBaseline }), null);
    // degenerate / inverted / non-numeric
    assert.equal(curveWriteGuard({ ...ok, curve: { ...ok.curve, mbt: 127 } })!.status, 422);
    assert.equal(curveWriteGuard({ ...ok, curve: { ...ok.curve, dot: 130 } })!.status, 422);
    assert.equal(curveWriteGuard({ ...ok, curve: { ...ok.curve, dbt: NaN } })!.status, 422);
    // I4 at each endpoint against the envelope at its own outdoor: 150 at 20 °F is above the cap
    assert.match(curveWriteGuard({ ...ok, curve: { ...ok.curve, dbt: 150 } })!.detail, /dbt 150°F outside the I4 envelope/);
    // …and a warm end below the envelope's lower bound at wwsd (95) is refused too
    assert.match(curveWriteGuard({ ...ok, curve: { ...ok.curve, mbt: 90 } })!.detail, /mbt 90°F outside/);
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

// ── #133 steps 3–4: Phase B's curve lead and the auto-pilot's curve decision (pure) ──
import { curveLeadF } from "./phaseb";
import { curveDecision, curveAlreadyInForce } from "./autopilot";

(async () => {
  // Phase B leads the curve's output over now AND the next hour: a colder next hour raises the lead.
  const cfg = { dot: 20, wwsd: 125, dbt: 127, mbt: 120 };
  assert.equal(curveLeadF(cfg, 125, 125), 120);
  assert.ok(Math.abs(curveLeadF(cfg, 35, 35)! - 126) < 0.01);
  assert.ok(curveLeadF(cfg, 35, 20)! > curveLeadF(cfg, 35, 35)!, "next-hour cold raises the lead");
  assert.equal(curveLeadF(cfg, 0, null), 127, "below dot the curve holds dbt");
  assert.equal(curveLeadF({ dot: 20, wwsd: 125, dbt: "x", mbt: 120 }, 35, 35), null);
  assert.equal(curveLeadF(null, 35, 35), null);
  assert.equal(curveLeadF(cfg, null, null), null);
  // The auto-pilot: excursion hours keep the flat target; other hours command the curve; no curve → flat.
  const shaped = { dot: 20, wwsd: 125, dbt: 127, mbt: 120, basis: {} };
  assert.equal(curveDecision({ reason: "DHW window floor", shaped_curve: shaped }).kind, "curve");
  assert.equal(curveDecision({ reason: "binding zone: Living Room Baseboard needs 124°F (winter solver shadow)", shaped_curve: shaped }).kind, "curve");
  assert.equal(curveDecision({ reason: "daily sanitize to 140°F = 60°C (I8 pasteurization, warmest hour)", sani: true, shaped_curve: shaped }).kind, "excursion");
  assert.equal(curveDecision({ reason: "afternoon bank to 128°F (warmest hour, 71°F outdoor)", bank: true, shaped_curve: shaped }).kind, "excursion");
  assert.equal(curveDecision({ reason: "storm mode: banking heat (extreme-cold)", shaped_curve: shaped }).kind, "excursion");
  assert.equal(curveDecision({ reason: "pre-charge for 06:00 window (warmest lead hour, 62°F)", shaped_curve: shaped }).kind, "excursion");
  assert.equal(curveDecision({ reason: "DHW window floor" }).kind, "no_curve");
  assert.equal(curveDecision({ reason: "DHW window floor", shaped_curve: { dot: 20 } }).kind, "no_curve");
  assert.equal(curveDecision(null).kind, "no_curve");
  // The held-curve comparison needs all FOUR endpoints — a wwsd drift must fall through to setCurve's 409.
  const want = { dot: 20, wwsd: 125, dbt: 127, mbt: 120 } as any;
  assert.equal(curveAlreadyInForce(want, { dot: 21, wwsd: 125, dbt: 128, mbt: 119 }), true);
  assert.equal(curveAlreadyInForce(want, { dot: 20, wwsd: 110, dbt: 127, mbt: 120 }), false, "wwsd drift is not 'held'");
  assert.equal(curveAlreadyInForce(want, { dot: 20, dbt: 127, mbt: 120 }), false, "missing wwsd is not 'held'");
  assert.equal(curveAlreadyInForce(want, { dot: 25, wwsd: 125, dbt: 127, mbt: 120 }), false);
  assert.equal(curveAlreadyInForce(want, null), false);
  // A curve may be shaped only from a healthy feed with buffer-served zones.
  assert.equal(canShapeFromFeed(true, zones), true);
  assert.equal(canShapeFromFeed(false, zones), false, "stale feed");
  assert.equal(canShapeFromFeed(true, []), false, "empty feed");
  assert.equal(canShapeFromFeed(true, [z("kumo", "mini_split")]), false, "no buffer-served zone");
  // #135: the emitted boost flag is an excursion even when the winter floor rewrote the reason and a
  // shaped curve is present — otherwise shaped-curve mode would run the curve through the boost hour.
  const shaped = { dot: 20, wwsd: 125, dbt: 127, mbt: 120 };
  assert.equal(curveDecision({ reason: "binding zone: baseboard needs 128°F (winter solver shadow)", boost: true, shaped_curve: shaped }).kind, "excursion");
  assert.equal(curveDecision({ reason: "binding zone: baseboard needs 128°F (winter solver shadow)", shaped_curve: shaped }).kind, "curve");
  // The rollout switch: anything but an explicit live/shadow value is OFF (fail-closed on a typo).
  assert.equal(parseShapedCurveMode(undefined), "off");
  assert.equal(parseShapedCurveMode(""), "off");
  assert.equal(parseShapedCurveMode("0"), "off");
  assert.equal(parseShapedCurveMode("true"), "off", "a typo must not arm the writer");
  assert.equal(parseShapedCurveMode("on"), "off", "a generic boolean must not arm the writer (codex)");
  assert.equal(parseShapedCurveMode("yes"), "off");
  assert.equal(parseShapedCurveMode("shadow"), "shadow");
  assert.equal(parseShapedCurveMode(" Shadow "), "shadow");
  assert.equal(parseShapedCurveMode("1"), "live");
  assert.equal(parseShapedCurveMode("live"), "live");
  console.log("curve.test.ts (phase B lead + autopilot decision): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
