/**
 * @purpose Assertions for the TempIQ#1632 learned-supply consumption in computeFloors
 * (demand.ts). Run with: npx tsx planner/src/demand.test.ts — exits non-zero on failure.
 * Pins that the learned per-zone required supply temp is used ONLY when the caller says
 * the evaluation is at now-conditions (learnedSupply=true), never grants a floor to
 * non-hydronic zones, and falls back to the local parametric model when absent.
 */
import assert from "node:assert/strict";
import { computeFloors, requiredAwtF, BUFFER_MARGIN_F, type InsightZone } from "./demand";

const zone = (over: Partial<InsightZone>): InsightZone => ({
  id: "z1", name: "Zone", deliveryType: "baseboard", deliveryTypeVerified: true,
  uaBtuHrF: 200, thermalMassBtuF: null, confidence: 0.8, requiredSupplyF: null, ...over,
});

// 1. learnedSupply=true prefers the TempIQ value; provenance is surfaced; tank target = value + margin.
{
  const zones = [zone({ requiredSupplyF: 120 })];
  const r = computeFloors(zones, ["z1"], 20, true);
  assert.equal(r.perZone[0].awtF, 120, "learned supply used at now-conditions");
  assert.equal(r.perZone[0].learned, true, "provenance flagged");
  assert.equal(r.tankTargetF, 124.5, "tank target = learned + BUFFER_MARGIN_F");
}

// 2. learnedSupply=false (the DP's per-hour future floors) ignores the learned value — the
//    local parametric model governs, because the learned number is now-conditions only.
{
  const zones = [zone({ requiredSupplyF: 120 })];
  const r = computeFloors(zones, ["z1"], 20, false);
  assert.equal(r.perZone[0].awtF, requiredAwtF("baseboard", 20), "future floors stay parametric");
  assert.equal(r.perZone[0].learned, false, "no learned provenance");
}

// 3. Learned value absent (unverified zone / stale outdoor on the TempIQ side) → parametric fallback.
{
  const r = computeFloors([zone({ requiredSupplyF: null })], ["z1"], 20, true);
  assert.equal(r.perZone[0].awtF, requiredAwtF("baseboard", 20), "null learned → local model");
  assert.equal(r.perZone[0].learned, false);
}

// 4. A non-hydronic zone can never gain a floor from a learned value — the local model's
//    null (mini-split doesn't draw on the buffer) always wins.
{
  const zones = [zone({ deliveryType: "mini_split", requiredSupplyF: 110 })];
  const r = computeFloors(zones, ["z1"], 20, true);
  assert.equal(r.perZone[0].awtF, null, "mini-split stays floorless");
  assert.equal(r.tankTargetF, null, "no binding zone from a non-hydronic learned value");
}

// 5. Binding selection still picks the hottest calling floor across mixed sources.
{
  const zones = [
    zone({ id: "rad", name: "Radiant", deliveryType: "radiant_floor", requiredSupplyF: 85 }),
    zone({ id: "bb", name: "Baseboard", requiredSupplyF: 120 }),
  ];
  const r = computeFloors(zones, ["rad", "bb"], 20, true);
  assert.equal(r.bindingZone, "Baseboard", "hottest calling floor binds");
  assert.equal(r.bindingAwtF, 120);
}

console.log("demand.test.ts: all assertions passed ✓");
