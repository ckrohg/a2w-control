/**
 * @purpose Assertions for the A-8 demand-forecast consumption (forecast.ts, issue #87).
 * Run with: npx tsx planner/src/forecast.test.ts — exits non-zero on failure.
 * Pins the two safety invariants the feature rests on: predictions RAISE ONLY (never
 * lower a plan block, never touch a sanitize block, never exceed the band ceiling), and
 * an absent/stale/low-confidence forecast leaves the plan byte-identical to today.
 */
import assert from "node:assert/strict";
import {
  parseForecast, predictedFloorForHour, predictedCapRisk, planPreheat, ForecastFeed,
  type DemandForecast,
} from "./forecast";
import type { ShadowBlock } from "./shadow";

const H = (n: number) => new Date(Date.UTC(2026, 0, 15, n)).toISOString();

const payload = {
  generatedAt: H(0),
  basis_window_days: 28,
  zones: [
    {
      id: "baseboard-1", name: "Living Room Baseboard",
      hours: [
        { start: H(5), p_call: 0.2, required_supply_f: 124, basis: "history", confidence: 0.9 },
        { start: H(6), p_call: 0.9, required_supply_f: 124, basis: "recovery", confidence: 0.95 },
      ],
    },
    {
      id: "radiant-1", name: "Radiant Floor",
      hours: [{ start: H(6), p_call: 0.95, required_supply_f: 88, basis: "history", confidence: 0.9 }],
    },
    {
      id: "unverified-1", name: "Mystery Zone",
      hours: [{ start: H(6), p_call: 1, required_supply_f: 160, basis: "history", confidence: 1 }],
    },
  ],
};

const forecast = parseForecast(payload) as DemandForecast;
assert.ok(forecast, "payload parses");
const verified = new Set(["baseboard-1", "radiant-1"]);
const gate = { threshold: 0.5, verifiedZoneIds: verified };

// 1. Binding = hottest zone clearing the gate; unverified zones can never drive a floor.
{
  const f = predictedFloorForHour(forecast, H(6), gate);
  assert.equal(f?.zoneName, "Living Room Baseboard", "baseboard binds over radiant");
  assert.equal(f?.tankTargetF, 128.5, "124 + 4.5 buffer margin");
  const ungated = predictedFloorForHour(forecast, H(6), { threshold: 0.5, verifiedZoneIds: null });
  assert.equal(ungated?.zoneName, "Mystery Zone", "without the gate the unverified zone would bind");
}

// 2. The confidence gate: 0.2 × 0.9 = 0.18 clears nothing at threshold 0.5.
{
  assert.equal(predictedFloorForHour(forecast, H(5), gate), null, "low p_call yields no floor");
  assert.equal(predictedFloorForHour(forecast, H(9), gate), null, "hour with no data yields no floor");
}

const mkPlan = (): ShadowBlock[] => [
  { ts: H(4), outdoor_f: 20, tank_target_f: 120, hp1_setpoint_f: 125, reason: "idle floor" },
  { ts: H(5), outdoor_f: 19, tank_target_f: 120, hp1_setpoint_f: 125, reason: "idle floor" },
  { ts: H(6), outdoor_f: 18, tank_target_f: 120, hp1_setpoint_f: 125, reason: "idle floor" },
];
const applyOpts = {
  ...gate, apply: true,
  ceilingFor: () => 135,
  setpointFor: (t: number) => t + 5,
};

// 3. Applied: hour 6 carries the predicted floor, hour 5 is pre-heated as its LEAD hour,
//    hour 4 (nothing predicted for 4 or 5) is untouched.
{
  const plan = mkPlan();
  const d = planPreheat(plan, forecast, applyOpts);
  assert.equal(plan[0].tank_target_f, 120, "hour 4 untouched");
  assert.equal(plan[1].tank_target_f, 129, "hour 5 pre-heated as the lead hour");
  assert.equal(plan[2].tank_target_f, 129, "hour 6 carries the predicted floor");
  assert.equal(plan[1].hp1_setpoint_f, 134, "lead setpoint covers the raised target (I1)");
  assert.match(plan[1].reason, /pre-heat.*next hour/i, "lead block says why");
  assert.match(plan[2].reason, /predicted demand/i, "call hour says why");
  assert.equal(d.filter((x) => x.applied).length, 2);
  assert.equal(d.find((x) => x.ts === H(5))?.lead, true, "hour 5 recorded as a lead raise");
}

// 4. RAISES ONLY — a plan already hotter than the prediction is never pulled down.
{
  const plan = mkPlan();
  plan[2].tank_target_f = 133;
  plan[2].hp1_setpoint_f = 138;
  planPreheat(plan, forecast, applyOpts);
  assert.equal(plan[2].tank_target_f, 133, "hotter block left alone");
  assert.equal(plan[2].hp1_setpoint_f, 138, "its setpoint left alone");
}

// 5. Band ceiling clamps the raise, and a sanitize block is never touched.
{
  const plan = mkPlan();
  const d = planPreheat(plan, forecast, { ...applyOpts, ceilingFor: () => 122 });
  assert.equal(plan[2].tank_target_f, 122, "clamped to the band ceiling, not 129");
  assert.ok(d.every((x) => x.toF <= 122), "no decision claims more than the ceiling");

  const sani = mkPlan();
  sani[2].reason = "sanitize soak to 140°F";
  const sd = planPreheat(sani, forecast, applyOpts);
  assert.equal(sani[2].tank_target_f, 120, "sanitize block untouched");
  assert.equal(sd.find((x) => x.ts === H(6))?.skipped, "sanitize block outranks");
}

// 6. DEGRADED PARITY — shadow mode and an empty forecast both leave the plan identical.
{
  const shadow = mkPlan();
  const before = JSON.stringify(shadow);
  const d = planPreheat(shadow, forecast, { ...applyOpts, apply: false });
  assert.equal(JSON.stringify(shadow), before, "apply=false mutates nothing");
  assert.ok(d.length > 0 && d.every((x) => !x.applied), "but still records what it would have done");

  const empty = mkPlan();
  const emptyBefore = JSON.stringify(empty);
  planPreheat(empty, parseForecast({ generatedAt: H(0), zones: [] }) as DemandForecast, applyOpts);
  assert.equal(JSON.stringify(empty), emptyBefore, "empty forecast changes nothing");
}

// 7. Predictive cap risk: earliest hour whose need exceeds the everyday cap.
{
  const risk = predictedCapRisk(forecast, 135, gate);
  assert.equal(risk, null, "128.5 needs nothing above the 135 cap");
  const hot = parseForecast({
    generatedAt: H(0),
    zones: [{ id: "baseboard-1", name: "Living Room Baseboard", hours: [
      { start: H(8), p_call: 0.9, required_supply_f: 140, basis: "history", confidence: 1 },
      { start: H(6), p_call: 0.9, required_supply_f: 138, basis: "history", confidence: 1 },
    ] }],
  }) as DemandForecast;
  const r2 = predictedCapRisk(hot, 135, gate);
  assert.equal(r2?.start, H(6), "reports the EARLIEST at-risk hour, not the hottest");
  assert.equal(r2?.tankTargetF, 142.5);
}

// 8. Malformed / partial payloads degrade, never throw.
{
  assert.equal(parseForecast(null), null);
  assert.equal(parseForecast({ nope: 1 }), null);
  const partial = parseForecast({ zones: [
    { id: "z", name: "Z", hours: [
      { start: "not-a-date", p_call: 1, required_supply_f: 130 },
      { start: H(6), required_supply_f: 130 },              // no p_call -> dropped
      { start: H(6), p_call: 0.8, required_supply_f: null }, // no supply temp -> no floor
    ] },
    { nope: true },                                          // no id -> dropped
  ] }) as DemandForecast;
  assert.equal(partial.zones.length, 1);
  assert.equal(partial.zones[0].hours.length, 1, "only the well-formed hour survives");
  assert.equal(predictedFloorForHour(partial, H(6), { threshold: 0.5, verifiedZoneIds: null }), null);
}

// 9. A feed that has never succeeded is unhealthy and yields no forecast (degraded mode).
{
  const feed = new ForecastFeed("http://127.0.0.1:1", "token");
  assert.equal(feed.isHealthy(), false);
  assert.equal(feed.forecast(), null);
  assert.equal(feed.status().healthy, false);
}

console.log("forecast.test.ts: all assertions passed ✓");
