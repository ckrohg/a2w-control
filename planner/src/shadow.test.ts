/**
 * @purpose Assertions for the demand-aware I8 soak block in computeShadowPlan (shadow.ts). Run with:
 * npx tsx planner/src/shadow.test.ts — exits non-zero on failure. Pins that the 140°F sanitize block
 * appears iff `sanitizeDue`, so the plan→autopilot→Phase B path (which coordinates the pump-setpoint
 * lead) runs the soak exactly when the caller says a pasteurization is due — and skips it otherwise.
 */
import assert from "node:assert/strict";
import { computeShadowPlan, DEFAULT_OPTS, parseForecastBody, forecastWithFallback, FORECAST_CACHE_MAX_AGE_MS, type ForecastHour } from "./shadow";

// A flat summer day: 24 hours, all warm (no winter guard, no natural ≥sanitizeF hour). Timestamps use
// LOCAL components so day-grouping + warmest-hour selection are deterministic regardless of machine TZ.
const forecast: ForecastHour[] = Array.from({ length: 24 }, (_, h) => ({
  ts: new Date(2026, 6, 15, h, 0, 0),
  outdoorF: 70 + h * 0.5, // 70 → 81.5°F, unique warmest hour at h=23
}));

// 1. sanitizeDue=true (also the default) → exactly one block reaches sanitizeF (140), reason mentions sanitize.
{
  const plan = computeShadowPlan(forecast, null, DEFAULT_OPTS, null, true);
  const boosted = plan.filter((b) => b.tank_target_f >= DEFAULT_OPTS.sanitizeF);
  assert.equal(boosted.length, 1, "due plan should have exactly one 140°F sanitize block");
  assert.match(boosted[0].reason, /sanitize/i, "boost block reason should mention sanitize");
  // and its HP setpoint LEADS the target (Phase B follows this so the soak clears I1)
  assert.ok(boosted[0].hp1_setpoint_f >= boosted[0].tank_target_f + DEFAULT_OPTS.i1MarginF,
    "sanitize block's hp1 setpoint must lead the target by the I1 margin");
  // default (no sanitizeDue arg) behaves as due=true
  const dflt = computeShadowPlan(forecast, null, DEFAULT_OPTS);
  assert.equal(dflt.filter((b) => b.tank_target_f >= DEFAULT_OPTS.sanitizeF).length, 1, "default arg = due");
}

// 2. sanitizeDue=false → NO soak: no block exceeds the everyday strict cap, none tagged sanitize.
{
  const plan = computeShadowPlan(forecast, null, DEFAULT_OPTS, null, false);
  const overCap = plan.filter((b) => b.tank_target_f > DEFAULT_OPTS.strictCapF);
  assert.equal(overCap.length, 0, "not-due plan must never exceed strictCap (no soak)");
  assert.equal(plan.some((b) => /sanitize/i.test(b.reason)), false, "not-due plan has no sanitize block");
}

// 3. due vs not-due differ on exactly one hour (the soak) — nothing else changes.
{
  const due = computeShadowPlan(forecast, null, DEFAULT_OPTS, null, true);
  const notDue = computeShadowPlan(forecast, null, DEFAULT_OPTS, null, false);
  let differing = 0;
  for (let i = 0; i < due.length; i++) if (due[i].tank_target_f !== notDue[i].tank_target_f) differing++;
  assert.equal(differing, 1, "exactly one hour (the soak) should differ between due and not-due");
}

// The as-found baseline curve as recorded in prod (hbx_config_versions seed): output 145–165°F,
// so the everyday ceiling is governed by strictCap — what the plan sees once index.ts substitutes
// the baseline for an autopilot-written live curve (#58 / curveOverridden).
const asFoundCfg = { dot: 5, wwsd: 125, dbt: 165, mbt: 145 };

// 4. bankF=0 (the default): no bank, and no phantom "pre-charge" labels — with idleF == dhwFloorF
//    the pre-charge raises nothing, so the plan must not claim a decision it isn't making (#58).
{
  const plan = computeShadowPlan(forecast, asFoundCfg, DEFAULT_OPTS, null, false);
  assert.equal(plan.some((b) => /bank|pre-charge/i.test(b.reason)), false, "bankF=0 plan has no bank/pre-charge labels");
  assert.ok(plan.every((b) => b.tank_target_f === DEFAULT_OPTS.dhwFloorF), "bankF=0 plan sits on the DHW floor everywhere");
}

// 5. bankF=8, not a soak day → exactly one block at floor+8 = 128, at the warmest hour, with the
//    HP line leading it by the I1 margin; every other block stays on the floor.
{
  const opts = { ...DEFAULT_OPTS, bankF: 8 };
  const plan = computeShadowPlan(forecast, asFoundCfg, opts, null, false);
  const banked = plan.filter((b) => /bank/i.test(b.reason));
  assert.equal(banked.length, 1, "bankF=8 non-soak day has exactly one banked block");
  assert.equal(banked[0].tank_target_f, opts.dhwFloorF + 8, "banked block sits at floor + bankF");
  assert.equal(banked[0].ts, plan[23].ts, "bank lands on the warmest hour");
  assert.ok(banked[0].hp1_setpoint_f >= banked[0].tank_target_f + opts.i1MarginF,
    "banked block's hp1 setpoint must lead the target by the I1 margin");
  assert.ok(plan.filter((b) => b !== banked[0]).every((b) => b.tank_target_f === opts.dhwFloorF),
    "all non-banked blocks stay on the floor");
}

// 6. Soak day: the 140°F sanitize IS the bank — no separate bank block appears.
{
  const plan = computeShadowPlan(forecast, asFoundCfg, { ...DEFAULT_OPTS, bankF: 8 }, null, true);
  assert.equal(plan.filter((b) => /bank/i.test(b.reason)).length, 0, "soak day skips the bank");
  assert.equal(plan.filter((b) => b.tank_target_f >= DEFAULT_OPTS.sanitizeF).length, 1, "soak still present");
}

// 7. The bank can never exceed the everyday strictCap, no matter how large bankF is set.
{
  const plan = computeShadowPlan(forecast, asFoundCfg, { ...DEFAULT_OPTS, bankF: 99 }, null, false);
  assert.equal(Math.max(...plan.map((b) => b.tank_target_f)), DEFAULT_OPTS.strictCapF,
    "oversized bankF clamps to strictCap");
}

// 8. DEADLINE BACKSTOP: when the window has LAPSED (sanitizeUrgent), the soak goes in the EARLIEST
//    hour rather than the day's warmest. Waiting for the cheapest hour has no deadline override, so
//    lateness compounds — on 2026-07-31 a 17.75h outage plus that wait produced a 75.2h gap between
//    pasteurizations, past the 72h hard ceiling.
{
  // Warmest hour is h=23 (see forecast). Not urgent ⇒ the soak lands there.
  const relaxed = computeShadowPlan(forecast, null, DEFAULT_OPTS, null, true, false);
  const relaxedIdx = relaxed.findIndex((b) => b.tank_target_f >= DEFAULT_OPTS.sanitizeF);
  assert.equal(relaxedIdx, 23, "not urgent ⇒ soak at the warmest (cheapest) hour");

  // Urgent ⇒ the FIRST hour, price be damned.
  const urgent = computeShadowPlan(forecast, null, DEFAULT_OPTS, null, true, true);
  const urgentIdx = urgent.findIndex((b) => b.tank_target_f >= DEFAULT_OPTS.sanitizeF);
  assert.equal(urgentIdx, 0, "urgent ⇒ soak at the EARLIEST hour, not the warmest");
  assert.match(urgent[0].reason, /overdue/i, "urgent block should say why it jumped the queue");

  // Exactly ONE soak — the urgent block must not stack with the per-day warmest-hour block.
  const urgentBlocks = urgent.filter((b) => b.tank_target_f >= DEFAULT_OPTS.sanitizeF);
  assert.equal(urgentBlocks.length, 1, "urgent must not double-soak the same day");

  // The urgent block still LEADS the pump setpoints — otherwise it would be rejected on I1 and the
  // backstop would achieve nothing (exactly the deadlock #56 fixed).
  assert.ok(
    urgent[0].hp1_setpoint_f >= urgent[0].tank_target_f + DEFAULT_OPTS.i1MarginF,
    "urgent sanitize block must still lead the HP setpoint by the I1 margin",
  );

  // urgent is meaningless when nothing is due — never soak on a not-due plan.
  const notDue = computeShadowPlan(forecast, null, DEFAULT_OPTS, null, false, true);
  assert.equal(
    notDue.filter((b) => b.tank_target_f >= DEFAULT_OPTS.sanitizeF).length, 0,
    "urgent must not override sanitizeDue=false",
  );

  // A short horizon (late in the day) is exactly where the old code deferred ~24h via `ds.length < 6`.
  // The backstop must still soak.
  const stub = forecast.slice(0, 3);
  const late = computeShadowPlan(stub, null, DEFAULT_OPTS, null, true, true);
  assert.equal(
    late.filter((b) => b.tank_target_f >= DEFAULT_OPTS.sanitizeF).length, 1,
    "urgent soaks even on a <6h horizon, where the warmest-hour path skips the day entirely",
  );
  // ...and the un-urgent path on that same stub is the deferral this fixes.
  const lateRelaxed = computeShadowPlan(stub, null, DEFAULT_OPTS, null, true, false);
  assert.equal(
    lateRelaxed.filter((b) => b.tank_target_f >= DEFAULT_OPTS.sanitizeF).length, 0,
    "documents the old behaviour: a short horizon defers the soak (why the backstop is needed)",
  );
}

// #122 audit — UNITS CONTRACT on the feed that sets the tank target. Mirrors storm.test.ts
// block 1: the bug class is "asked for °F, assumed °F, received something else". A °C body must
// CONVERT (not pass through as if °F), °F must pass through, and a body with no declared unit
// must be fatal — silently mixing scales on the curve target is worse than skipping a poll.
{
  const mk = (unit: string | undefined, vals: (number | null)[]) => ({
    hourly_units: unit === undefined ? undefined : { time: "iso8601", temperature_2m: unit },
    hourly: { time: vals.map((_, i) => `2026-01-15T${String(i).padStart(2, "0")}:00`), temperature_2m: vals },
  });
  const c = parseForecastBody(mk("°C", [10, 20, -5]), 0);
  assert.deepEqual(c.map((h) => Math.round(h.outdoorF * 10) / 10), [50, 68, 23], "°C body converts to °F");
  const f = parseForecastBody(mk("°F", [50, 68]), 0);
  assert.deepEqual(f.map((h) => h.outdoorF), [50, 68], "°F body passes through");
  assert.throws(() => parseForecastBody(mk(undefined, [50]), 0), /unusable unit/, "no declared unit is fatal");
  assert.throws(() => parseForecastBody({ hourly_units: { temperature_2m: "°F" } }, 0), /no hourly block/, "missing hourly is fatal");
  // A single null reading drops that hour, not the poll (NaN survives the converter and fails the filter).
  assert.equal(parseForecastBody(mk("°F", [50, null]), 0).length, 1, "a null reading drops only its own hour");
}

console.log("shadow.test.ts: all assertions passed ✓");

// Forecast fallback: an open-meteo failure reuses the last good forecast instead of aborting the hour.
(async () => {
  const now = Date.UTC(2026, 0, 10, 12, 30);
  const hour = (k: number, f: number): ForecastHour => ({ ts: new Date(now + k * 3600_000), outdoorF: f });
  const live = [hour(0, 30), hour(1, 31)];
  let saved: ForecastHour[] | null = null;
  const cacheOf = (fetchedAt: number | null, hours: ForecastHour[]) => ({
    load: async () => (fetchedAt == null ? null : { fetchedAt: new Date(fetchedAt), hours }),
    save: async (h: ForecastHour[]) => { saved = h; },
  });
  // live success → live + cache refreshed
  const r1 = await forecastWithFallback(async () => live, cacheOf(null, []), now);
  assert.equal(r1.source, "live");
  assert.deepEqual(saved, live);
  // live failure + fresh cache → cached, past hours trimmed (keep the current partial hour), error carried
  const stale = [hour(-3, 20), hour(-1, 25), hour(0, 28), hour(2, 33)];
  const r2 = await forecastWithFallback(async () => { throw new Error("open-meteo: HTTP 429"); }, cacheOf(now - 2 * 3600_000, stale), now);
  assert.equal(r2.source, "cached");
  assert.deepEqual(r2.hours.map((h) => h.outdoorF), [25, 28, 33], "hours older than one hour are dropped, like the live parser");
  assert.equal(r2.error, "open-meteo: HTTP 429");
  // live failure + cache older than the max age → the ORIGINAL error propagates
  await assert.rejects(
    () => forecastWithFallback(async () => { throw new Error("open-meteo: HTTP 429"); }, cacheOf(now - FORECAST_CACHE_MAX_AGE_MS - 1, stale), now),
    /HTTP 429/,
  );
  // live failure + no cache → propagates
  await assert.rejects(() => forecastWithFallback(async () => { throw new Error("boom"); }, cacheOf(null, []), now), /boom/);
  // live failure + cache whose hours are all in the past → propagates (an empty forecast is not a forecast)
  await assert.rejects(() => forecastWithFallback(async () => { throw new Error("boom"); }, cacheOf(now - 1000, [hour(-5, 20)]), now), /boom/);
  // a failing cache save never fails a live result
  const r3 = await forecastWithFallback(async () => live, { load: async () => null, save: async () => { throw new Error("db down"); } }, now);
  assert.equal(r3.source, "live");
  // a HANGING cache save never delays a live result (bounded, off the critical path)
  const t0 = Date.now();
  const r4 = await forecastWithFallback(async () => live, { load: async () => null, save: () => new Promise<void>(() => {}) }, now, FORECAST_CACHE_MAX_AGE_MS, 50);
  assert.equal(r4.source, "live");
  assert.ok(Date.now() - t0 < 1000, "live result must not wait on the cache write");
  await new Promise((r) => setTimeout(r, 80)); // let the bounded save time out and log, not throw
  console.log("shadow.test.ts (forecast fallback): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });

// #135 pre-boost: sized from the window's sag, placed in the warmest lead hour with a standby allowance.
{
  // Cold-enough day (no winter guard): 40..50 °F, warmest at h=23. Windows 6–9 and 17–22; the 17:00
  // window's lead hours are 14, 15, 16 (all non-window). Outdoor rises with h, so 16 is the warmest lead.
  const fc: ForecastHour[] = Array.from({ length: 24 }, (_, h) => ({ ts: new Date(2026, 9, 15, h, 0, 0), outdoorF: 55 + h * 0.5 }));
  const opts = { ...DEFAULT_OPTS, dhwWindows: [[6, 9], [17, 22]] as [number, number][], preBoosts: [
    { windowStart: 17, boostF: 6, sagP75F: 6.2, n: 11 },
    { windowStart: 6, boostF: 2, sagP75F: 2.0, n: 9 },   // below MIN_PREBOOST_F → nothing
  ] };
  // (soak OFF in these plans — sanitizeDue=false — so the pre-boost is observed alone)
  const plan = computeShadowPlan(fc, null, opts, null, false);
  const boosts = plan.filter((b) => b.boost === true);
  assert.equal(boosts.length, 1, "exactly one pre-boost (the 06:00 window's 2 °F is below the floor)");
  const b = boosts[0];
  assert.equal(new Date(b.ts).getHours(), 16, "the warmest lead hour (16:00) is chosen");
  assert.equal(b.tank_target_f, 126, "floor 120 + sag 6, no standby allowance for the hour right before the bell");
  assert.match(b.reason, /pre-boost to 126°F for 17:00 window \(sag p75 6.2°F over 11 draws; warmest lead hour/);
  assert.ok(b.hp1_setpoint_f >= b.tank_target_f + DEFAULT_OPTS.i1MarginF, "Phase B leads the pump setpoints off the boost (I1)");
  assert.equal(plan.filter((x) => x.reason.includes("pre-charge")).length, 0, "the dormant pre-charge label is gone");

  // Warmest lead hour two hours early → +2.4 °F/h standby allowance for the 1 h of coasting.
  const fc2: ForecastHour[] = fc.map((f, h) => ({ ...f, outdoorF: h === 14 ? 90 : f.outdoorF }));
  const b2 = computeShadowPlan(fc2, null, opts, null, false).filter((x) => x.boost)[0];
  assert.equal(new Date(b2.ts).getHours(), 14);
  assert.equal(b2.tank_target_f, Math.round(120 + 6 + 2.4 * 2), "two hours ahead: 1 h charging + 2 h standby … allowance per elapsed hour");
  assert.match(b2.reason, /standby over 2 h/);

  // If the allowance would breach strictCap, the hour before the bell is used instead.
  const big = { ...opts, preBoosts: [{ windowStart: 17, boostF: 12, sagP75F: 12, n: 6 }] };
  const b3 = computeShadowPlan(fc2, null, big, null, false).filter((x) => x.boost)[0];
  assert.equal(new Date(b3.ts).getHours(), 16, "14:00 would need 120+12+4.8 = 136.8 > 135 → the hour before the bell");
  assert.equal(b3.tank_target_f, 132);
  assert.match(b3.reason, /hour before the bell/);

  // Too few draws (< 6) → no boost; no preBoosts at all → byte-identical to the pre-#135 plan.
  const few = { ...opts, preBoosts: [{ windowStart: 17, boostF: 6, sagP75F: 6, n: 5 }] };
  assert.equal(computeShadowPlan(fc, null, few, null, false).filter((x) => x.boost).length, 0);
  const before = computeShadowPlan(fc, null, { ...DEFAULT_OPTS, dhwWindows: opts.dhwWindows }, null, false);
  const without = computeShadowPlan(fc, null, { ...opts, preBoosts: [] }, null, false);
  assert.deepEqual(without, before, "no preBoosts → identical plan");

  // A contaminated sag cannot chase strictCap: the boost is capped at MAX_PREBOOST_F and says so.
  const huge = { ...opts, preBoosts: [{ windowStart: 17, boostF: 40, sagP75F: 40, n: 8 }] };
  const b4 = computeShadowPlan(fc, null, huge, null, false).filter((x) => x.boost)[0];
  assert.equal(b4.tank_target_f, 132, "120 + 12 (cap), placed at 16:00 with no standby allowance");
  assert.match(b4.reason, /capped at \+12/);

  // A soak in the lead interval IS the pre-boost: with the soak due it lands at the day's warmest hour
  // (h=23 here, not in the lead) → the boost still happens; force the soak into the lead and it is suppressed.
  const soaked = computeShadowPlan(fc, null, opts, null, true);
  for (const x of soaked) if (x.sani) assert.equal(x.boost, undefined, "the soak block keeps its identity");
  const fcSoakInLead: ForecastHour[] = fc.map((f, h) => ({ ...f, outdoorF: h === 15 ? 95 : 55 + h * 0.5 })); // warmest = 15:00 → soak lands in the lead
  const s2 = computeShadowPlan(fcSoakInLead, null, opts, null, true);
  assert.ok(s2.some((x) => x.sani && new Date(x.ts).getHours() === 15), "soak sits in the 17:00 window's lead");
  assert.equal(s2.filter((x) => x.boost).length, 0, "no pre-boost beside a soak in the lead — the soak banks more");
  // same with the #58 bank in the lead
  const banked = computeShadowPlan(fcSoakInLead, null, { ...opts, bankF: 8 }, null, false);
  assert.ok(banked.some((x) => x.bank && new Date(x.ts).getHours() === 15), "bank sits in the lead");
  assert.equal(banked.filter((x) => x.boost).length, 0, "no pre-boost beside a bank in the lead");
  for (const x of [...s2, ...banked]) assert.ok(!(x.boost && (x.sani || x.bank)), "one excursion identity per block");

  // WINTER: the demand floor takes a block's reason only when it raises the target. A pre-boost that
  // sits above the floor keeps its reason (so the poster files it as a bank) and its flag; a floor
  // above the boost wins the target and the reason, and the flag still marks the intended excursion.
  const winter: ForecastHour[] = fc.map((f) => ({ ...f, outdoorF: 30 }));
  const floorLow = { tankTargetF: 122, bindingZone: "baseboard", awtF: 118 };
  const w1 = computeShadowPlan(winter, null, opts, floorLow, false);
  const wb = w1.filter((x) => x.boost)[0];
  assert.ok(wb, "the pre-boost survives the winter pass");
  assert.match(wb.reason, /pre-boost to 126°F/, "the floor (122) did not raise a 126 block, so the reason is kept");
  assert.ok(w1.filter((x) => !x.boost).every((x) => /binding zone/.test(x.reason) && x.tank_target_f === 122), "every other block took the floor");
  const floorHigh = { tankTargetF: 130, bindingZone: "baseboard", awtF: 126 };
  const w2 = computeShadowPlan(winter, null, opts, floorHigh, false).filter((x) => x.boost)[0];
  assert.equal(w2.tank_target_f, 130);
  assert.match(w2.reason, /binding zone/, "a floor above the boost wins target and reason");
  console.log("shadow.test.ts (#135 pre-boost): all assertions passed");
}
