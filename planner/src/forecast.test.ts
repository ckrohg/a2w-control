/**
 * @purpose Assertions for the #87 required-supply forecast client (TempIQ gtm#1591 /
 * TempIQv2#2017). Run with: npx tsx planner/src/forecast.test.ts — exits non-zero on failure.
 *
 * The load-bearing one is the EVIDENCE GATE. p_call was never built (Phase 0 STOP), so the
 * old confidence gate is gone, and what replaced it is "the zone must be calling now".
 * Without that, every verified zone would set a floor every hour — the conservative
 * all-zones future floor whose idle cost blocks the winter DP. Several tests below exist
 * specifically to pin that a non-calling zone, however hot, moves nothing.
 */
import assert from "node:assert/strict";
import {
  parseForecast, predictedFloorForHour, predictedCapRisk, planPreheat, ForecastFeed,
  type SupplyForecast,
} from "./forecast";
import type { ShadowBlock } from "./shadow";

const H = (n: number) => new Date(Date.UTC(2026, 0, 15, n)).toISOString();
const hour = (start: string, req: number | null, outdoor = 20) =>
  ({ targetTimestamp: start, outdoorF: outdoor, requiredSupplyWaterTempF: req,
     forecastGeneratedAt: H(0) });

// The live payload shape, as verified against prod 2026-08-27.
const payload = {
  propertyId: "p1",
  generatedAt: H(3),
  forecast: { requestedHours: 48, hoursAvailable: 48, firstHour: H(4), lastHour: H(9),
              oldestVintage: H(0), newestVintage: H(0), degradeReason: null },
  units: { outdoorF: "°F" },
  zones: [
    { zoneId: "bb-1", zoneName: "Living Room Baseboard", deliveryType: "baseboard",
      omittedReason: null, resetCurve: { designSupplyF: 164.7, designSupplyFSource: "demonstrated_max" },
      hours: [hour(H(6), 124.5), hour(H(8), 120)] },
    // Hotter, and NOT calling in the tests below — the evidence gate must ignore it.
    { zoneId: "bb-2", zoneName: "Upstairs Baseboard", deliveryType: "baseboard",
      omittedReason: null, hours: [hour(H(5), 140), hour(H(6), 140)] },
    { zoneId: "rad-1", zoneName: "Dining", deliveryType: "radiant_floor",
      omittedReason: null, hours: [hour(H(6), 100)] },
    // TempIQ omits unverified zones itself; keep one to prove we tolerate the shape.
    { zoneId: "rad-2", zoneName: "Kitchen Radiant", deliveryType: "radiant_floor",
      omittedReason: "unverified", hours: [] },
  ],
};

const forecast = parseForecast(payload) as SupplyForecast;
const verified = new Set(["bb-1", "bb-2", "rad-1"]);
const calling = new Set(["bb-1"]);

// 1. Parse maps the shipped field names and keeps TempIQ's omission reason.
{
  assert.equal(forecast.zones.length, 4);
  assert.equal(forecast.newestVintage, H(0));
  assert.equal(forecast.zones[0].hours[0].start, H(6), "targetTimestamp -> start");
  assert.equal(forecast.zones[0].hours[0].requiredSupplyF, 124.5, "requiredSupplyWaterTempF -> requiredSupplyF");
  assert.equal(forecast.zones[0].hours[0].vintage, H(0), "forecastGeneratedAt -> vintage");
  assert.equal(forecast.zones[3].omittedReason, "unverified");
  assert.equal(forecast.zones[3].hours.length, 0);
}

// 2. THE EVIDENCE GATE: the calling zone drives the floor; a hotter non-calling zone does not.
{
  const f = predictedFloorForHour(forecast, H(6), { verifiedZoneIds: verified, zoneIds: calling });
  assert.equal(f?.zoneName, "Living Room Baseboard", "the CALLING zone drives it");
  assert.equal(f?.requiredSupplyF, 124.5);
  assert.equal(f?.tankTargetF, 129, "required + BUFFER_MARGIN_F");

  const unfiltered = predictedFloorForHour(forecast, H(6), { verifiedZoneIds: verified, zoneIds: null });
  assert.equal(unfiltered?.requiredSupplyF, 140, "ungated asks the CAPACITY question — 140 wins");
  assert.notEqual(unfiltered?.zoneName, f?.zoneName, "which is exactly why floors must be gated");
}

// 3. The verified gate still hard-blocks, even for a calling zone.
{
  const f = predictedFloorForHour(forecast, H(6),
    { verifiedZoneIds: new Set(["rad-1"]), zoneIds: new Set(["bb-1"]) });
  assert.equal(f, null, "a zone must pass BOTH gates");
  assert.equal(predictedFloorForHour(forecast, H(9), { verifiedZoneIds: verified, zoneIds: calling }),
    null, "hour with no data yields no floor");
}

const mkPlan = (): ShadowBlock[] => [
  { ts: H(4), outdoor_f: 20, tank_target_f: 120, hp1_setpoint_f: 125, reason: "idle floor" },
  { ts: H(5), outdoor_f: 19, tank_target_f: 120, hp1_setpoint_f: 125, reason: "idle floor" },
  { ts: H(6), outdoor_f: 18, tank_target_f: 120, hp1_setpoint_f: 125, reason: "idle floor" },
];
const applyOpts = {
  verifiedZoneIds: verified,
  callingZoneIds: ["bb-1"],
  apply: true,
  ceilingFor: () => 135,
  setpointFor: (t: number) => t + 5,
};

// 4. Applied: hour 6 carries the requirement, hour 5 is pre-heated as its LEAD hour,
//    hour 4 (nothing for 4 or 5) is untouched.
{
  const plan = mkPlan();
  const d = planPreheat(plan, forecast, applyOpts);
  assert.equal(plan[0].tank_target_f, 120, "hour 4 untouched");
  assert.equal(plan[1].tank_target_f, 129, "hour 5 pre-heated as the lead hour");
  assert.equal(plan[2].tank_target_f, 129, "hour 6 carries the requirement");
  assert.equal(plan[1].hp1_setpoint_f, 134, "lead setpoint covers the raised target (I1)");
  assert.match(plan[1].reason, /pre-heat.*next hour/i, "lead block says why");
  assert.match(plan[2].reason, /forecast demand/i, "requirement hour says why");
  assert.equal(d.filter((x) => x.applied).length, 2);
  assert.equal(d.find((x) => x.ts === H(5))?.lead, true, "hour 5 recorded as a lead raise");
}

// 5. NOTHING CALLING -> NOTHING RAISED. Both the empty case and the unhealthy-feed (null)
//    case, because a speculative raise on unknown demand is the cost this design refuses.
{
  for (const [label, ids] of [["nothing calling", [] as string[]], ["call feed unhealthy", null]] as const) {
    const plan = mkPlan();
    const before = JSON.stringify(plan);
    const d = planPreheat(plan, forecast, { ...applyOpts, callingZoneIds: ids });
    assert.equal(JSON.stringify(plan), before, `${label}: plan untouched`);
    assert.equal(d.length, 0, `${label}: no decisions at all`);
  }
  // And the hot non-calling zone still cannot sneak in through planPreheat.
  const plan = mkPlan();
  planPreheat(plan, forecast, { ...applyOpts, callingZoneIds: ["bb-1"] });
  assert.equal(plan[2].tank_target_f, 129, "bb-2's 140 never reaches the plan");
}

// 6. RAISES ONLY — a plan already hotter is never pulled down.
{
  const plan = mkPlan();
  plan[2].tank_target_f = 133;
  plan[2].hp1_setpoint_f = 138;
  planPreheat(plan, forecast, applyOpts);
  assert.equal(plan[2].tank_target_f, 133, "hotter block left alone");
  assert.equal(plan[2].hp1_setpoint_f, 138, "its setpoint left alone");
}

// 7. Band ceiling clamps the raise, and a sanitize block is never touched.
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

// 8. DEGRADED PARITY — shadow mode and an empty forecast both leave the plan identical.
{
  const shadow = mkPlan();
  const before = JSON.stringify(shadow);
  const d = planPreheat(shadow, forecast, { ...applyOpts, apply: false });
  assert.equal(JSON.stringify(shadow), before, "apply=false mutates nothing");
  assert.ok(d.length > 0 && d.every((x) => !x.applied), "but still records what it would have done");

  const empty = mkPlan();
  const emptyBefore = JSON.stringify(empty);
  planPreheat(empty, parseForecast({ generatedAt: H(0), zones: [] }) as SupplyForecast, applyOpts);
  assert.equal(JSON.stringify(empty), emptyBefore, "empty forecast changes nothing");
}

// 9. Cap risk is deliberately UNGATED by live calls — it commands nothing, and gating it
//    would silence the warning in exactly the mild hours when it is still actionable.
{
  assert.equal(predictedCapRisk(forecast, 145, { verifiedZoneIds: verified }), null,
    "144.5 needs nothing above a 145 cap");
  const r = predictedCapRisk(forecast, 135, { verifiedZoneIds: verified });
  assert.equal(r?.start, H(5), "reports the EARLIEST at-risk hour, not the hottest");
  assert.equal(r?.tankTargetF, 144.5);
  assert.equal(r?.zoneName, "Upstairs Baseboard", "a non-calling zone CAN raise a capacity warning");
}

// 10. Malformed / partial payloads degrade, never throw.
{
  assert.equal(parseForecast(null), null);
  assert.equal(parseForecast({ nope: 1 }), null);
  const partial = parseForecast({ zones: [
    { zoneId: "z", zoneName: "Z", hours: [
      { targetTimestamp: "not-a-date", requiredSupplyWaterTempF: 130 },
      { targetTimestamp: H(6), requiredSupplyWaterTempF: null },  // no supply temp -> no floor
      { targetTimestamp: H(7), requiredSupplyWaterTempF: 130 },
    ] },
    { nope: true },                                               // no id -> dropped
  ] }) as SupplyForecast;
  assert.equal(partial.zones.length, 1);
  assert.equal(partial.zones[0].hours.length, 2, "only well-formed timestamps survive");
  assert.equal(predictedFloorForHour(partial, H(6), { verifiedZoneIds: null, zoneIds: null }),
    null, "a null requirement yields no floor");
  assert.equal(partial.newestVintage, null, "absent forecast meta -> nulls, not a throw");
}

// 11. Feed health: never-succeeded is unhealthy, and a STALE WEATHER VINTAGE is unhealthy
//     even though the response itself is fresh. The upstream refreshes 6-hourly, so this is
//     the check that distinguishes "old weather" from "old fetch" — getting it wrong in
//     either direction means permanent degraded mode or acting on yesterday's forecast.
{
  const feed = new ForecastFeed("http://127.0.0.1:1", "token");
  assert.equal(feed.isHealthy(), false);
  assert.equal(feed.forecast(), null);
  assert.equal(feed.status().healthy, false);
}
void (async () => {
  const real = globalThis.fetch;
  const stub = (vintageMsAgo: number) => {
    const v = new Date(Date.now() - vintageMsAgo).toISOString();
    return async (url: string | URL | Request) => {
      assert.match(String(url), /\/api\/insights\/zones\/required-supply-forecast/,
        "calls the endpoint that actually shipped");
      return new Response(JSON.stringify({
        generatedAt: new Date().toISOString(),
        forecast: { newestVintage: v, oldestVintage: v, hoursAvailable: 48, degradeReason: null },
        zones: [{ zoneId: "bb-1", zoneName: "LR", deliveryType: "baseboard", omittedReason: null,
                  hours: [{ targetTimestamp: H(6), outdoorF: 20, requiredSupplyWaterTempF: 124.5,
                            forecastGeneratedAt: v }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
  };
  try {
    const fresh = new ForecastFeed("https://tempiq.example", "tok");
    globalThis.fetch = stub(4 * 3600_000) as typeof globalThis.fetch;
    await fresh.refresh();
    assert.equal(fresh.isHealthy(), true, "a 4h vintage is NORMAL for a 6-hourly refresh");
    assert.equal(fresh.status().vintageAgeH, 4);

    const stale = new ForecastFeed("https://tempiq.example", "tok");
    globalThis.fetch = stub(9 * 3600_000) as typeof globalThis.fetch;
    await stale.refresh();
    assert.equal(stale.isHealthy(), false, "a 9h vintage is stale -> degraded mode");
    assert.equal(stale.forecast(), null);
  } finally {
    globalThis.fetch = real;
  }
  console.log("forecast.test.ts: all assertions passed ✓");
})().catch((e) => { console.error(e); process.exit(1); });
