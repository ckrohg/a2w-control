/**
 * @purpose Assertions for the TempIQ#1632 learned-supply consumption in computeFloors
 * (demand.ts). Run with: npx tsx planner/src/demand.test.ts — exits non-zero on failure.
 * Pins that the learned per-zone required supply temp is used ONLY when the caller says
 * the evaluation is at now-conditions (learnedSupply=true), never grants a floor to
 * non-hydronic zones, and falls back to the local parametric model when absent.
 */
import assert from "node:assert/strict";
import { computeFloors, requiredAwtF, BUFFER_MARGIN_F, ESCALATE_F_PER_DEG, type InsightZone } from "./demand";

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

// ---------------------------------------------------------------------------
// #90 cost-first floor policy (owner direction 2026-08-24): TempIQ's capacity
// number is a CEILING, the cheap local model is the starting floor, and the calling
// room's own deficit decides how far up we go.
// ---------------------------------------------------------------------------
{
  const bb = (over: Partial<InsightZone>): InsightZone => ({
    id: "bb", name: "Living Room Baseboard", deliveryType: "baseboard",
    deliveryTypeVerified: true, uaBtuHrF: 200, thermalMassBtuF: null, confidence: 0.8,
    requiredSupplyF: 152.7, roomF: 70, setpointF: 70, ...over,
  });
  const OUT = 30;
  const local = requiredAwtF("baseboard", OUT) as number; // ~112.9

  // Room at setpoint: we pay the CHEAP number, not TempIQ's 152.7.
  {
    const r = computeFloors([bb({})], ["bb"], OUT, true, "escalate");
    assert.equal(Math.round(r.bindingAwtF as number), Math.round(local), "at setpoint -> local model");
    assert.equal(r.perZone[0].escalatedF, 0);
    assert.equal(r.perZone[0].ceilingF, 152.7, "TempIQ value retained as the ceiling");
  }

  // Room 1°F below setpoint: buys ESCALATE_F_PER_DEG of supply, still far under the ceiling.
  {
    const r = computeFloors([bb({ roomF: 69, setpointF: 70 })], ["bb"], OUT, true, "escalate");
    const got = r.bindingAwtF as number;
    assert.ok(got > local && got <= local + ESCALATE_F_PER_DEG + 0.01, `1F deficit escalates modestly (got ${got})`);
    assert.ok(got < 152.7, "still well below TempIQ's capacity number");
  }

  // A genuinely failing zone (7°F down) escalates all the way — but never past the ceiling.
  {
    const r = computeFloors([bb({ roomF: 63, setpointF: 70 })], ["bb"], OUT, true, "escalate");
    assert.equal(r.bindingAwtF, 152.7, "big deficit reaches, but does not exceed, the ceiling");
    assert.equal(r.perZone[0].deficitF, 7);
  }

  // Deadband: 0.4°F of noise must NOT buy heat.
  {
    const r = computeFloors([bb({ roomF: 69.6, setpointF: 70 })], ["bb"], OUT, true, "escalate");
    assert.equal(r.perZone[0].escalatedF, 0, "sub-deadband noise buys nothing");
  }

  // Policy escape hatches still work.
  {
    const learned = computeFloors([bb({})], ["bb"], OUT, true, "learned");
    assert.equal(learned.bindingAwtF, 152.7, "'learned' reproduces pre-#90 behavior");
    const localOnly = computeFloors([bb({ roomF: 60, setpointF: 70 })], ["bb"], OUT, true, "local");
    assert.equal(Math.round(localOnly.bindingAwtF as number), Math.round(local), "'local' ignores TempIQ entirely");
  }

  // Missing room telemetry must not escalate (no evidence -> stay cheap), and a zone with
  // no learned ceiling is never escalated past its own local number.
  {
    const noTelem = computeFloors([bb({ roomF: null, setpointF: null })], ["bb"], OUT, true, "escalate");
    assert.equal(noTelem.perZone[0].escalatedF, 0, "no telemetry -> no escalation");
    const noCeiling = computeFloors([bb({ requiredSupplyF: null, roomF: 60, setpointF: 70 })], ["bb"], OUT, true, "escalate");
    assert.equal(Math.round(noCeiling.bindingAwtF as number), Math.round(local), "no ceiling -> local only");
  }

  // A mini-split can never gain a floor, deficit or not.
  {
    const ms = computeFloors(
      [bb({ deliveryType: "mini_split", requiredSupplyF: 160, roomF: 60, setpointF: 70 })],
      ["bb"], OUT, true, "escalate");
    assert.equal(ms.bindingAwtF, null, "non-hydronic zone never floors the tank");
  }
  console.log("demand.test.ts: #90 cost-first policy assertions passed ✓");
}

// #90 backstop: call persistence escalates even with NO room telemetry (the live payload's
// demand.setpointF is null whenever a zone is off — the policy must not depend on it).
{
  const z = (over: Partial<InsightZone>): InsightZone => ({
    id: "bb", name: "LR Baseboard", deliveryType: "baseboard", deliveryTypeVerified: true,
    uaBtuHrF: 200, thermalMassBtuF: null, confidence: 0.8, requiredSupplyF: 152.7,
    roomF: null, setpointF: null, ...over,
  });
  const OUT = 30;
  const local = requiredAwtF("baseboard", OUT) as number;
  const streaks = (n: number) => new Map([["bb", n]]);

  const c1 = computeFloors([z({})], ["bb"], OUT, true, "escalate", streaks(1));
  assert.equal(c1.perZone[0].escalatedF, 0, "first calling cycle is free");

  const c2 = computeFloors([z({})], ["bb"], OUT, true, "escalate", streaks(2));
  assert.ok((c2.bindingAwtF as number) > local, "still calling a cycle later -> escalates with no telemetry");

  const c9 = computeFloors([z({})], ["bb"], OUT, true, "escalate", streaks(9));
  assert.equal(c9.bindingAwtF, 152.7, "a zone that never satisfies walks up to the ceiling, never past");

  // Whichever evidence asks for MORE heat wins.
  const both = computeFloors([z({ roomF: 66, setpointF: 70 })], ["bb"], OUT, true, "escalate", streaks(2));
  assert.ok((both.bindingAwtF as number) >= (c2.bindingAwtF as number), "deficit and streak combine by max");
  console.log("demand.test.ts: #90 call-persistence backstop assertions passed ✓");
}
