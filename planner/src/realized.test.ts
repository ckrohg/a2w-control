// @purpose Unit tests for the realized-savings engine — pins the counterfactual physics and the
// ~$5-6/week summer ballpark the live-data recompute produced, so a refactor can't silently drift
// the headline savings number. Run: npx tsx --test src/realized.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDayRealized, asfoundBufferF, carnotFactor, type DayInputs, type RealizedParams } from "./realized";

const P: RealizedParams = { rateUsdKwh: 0.30, uaBtuHrF: 25, ambientF: 70, dailyKwhFallback: 11.8 };

test("as-found curve reconstructs the ~154°F summer buffer from real outdoor temp", () => {
  assert.ok(Math.abs(asfoundBufferF(75) - 153.3) < 1, `expected ~153°F at 75°F out, got ${asfoundBufferF(75)}`);
  // colder outdoor → hotter as-found buffer, clamped to the design band [145,165]
  assert.ok(asfoundBufferF(5) <= 165 && asfoundBufferF(125) >= 145);
});

test("hotter old sink gives a LOWER Carnot factor (lower COP)", () => {
  assert.ok(carnotFactor(163, 75) < carnotFactor(145, 75), "163°F sink must be less efficient than 145°F");
});

test("representative summer day: terms decompose to the total; as-found + fixed regimes sane", () => {
  const d: DayInputs = {
    day: "2026-07-17", avgOutdoorF: 75, nowBufferF: 135, coverage: 1,
    measured: { elecKwh: 9.5, thermalKwh: 24, cop: 2.4, sinkF: 145, sessions: 8 },
  };
  const r = computeDayRealized(d, P);
  assert.ok(r.copOld < r.copNow, `copOld(${r.copOld}) must be < copNow(${r.copNow})`);
  assert.ok(r.elementCreditUsd >= 0, "element credit must be ≥0");
  assert.ok(Math.abs(r.copUsd + r.standbyUsd + r.elementCreditUsd - r.savedUsd) < 0.02, "terms must sum to total");
  assert.ok(Math.abs(r.oldBufferF - 153.3) < 1); // ~154°F as-found buffer
  // the as-found regime always costs more than actual (saving > 0) and than the hardcoded-cool regime
  assert.ok(r.cfElecKwh > r.actualElecKwh && r.cfElecKwh > r.fixedElecKwh, "as-found must be the priciest");
  assert.ok(r.savedUsd > 0 && r.fixedSavedUsd > 0, "both smart and hardcoded-cool must save vs as-found");
  // smart premium = savedUsd − fixedSavedUsd (may be small/either sign in summer — flat rate, DHW-only)
  assert.ok(Math.abs(r.savedUsd - r.fixedSavedUsd - r.smartPremiumUsd) < 0.02, "premium identity");
});

test("hotter as-found buffer (winter-ish, cold outdoor) trips the element → element credit > 0", () => {
  const r = computeDayRealized({
    day: "2026-01-15", avgOutdoorF: 20, nowBufferF: 135, coverage: 1,
    measured: { elecKwh: 20, thermalKwh: 45, cop: 2.2, sinkF: 145, sessions: 10 },
  }, P);
  assert.ok(r.oldBufferF > 158, `cold-day as-found buffer should be hot (${r.oldBufferF})`);
  assert.ok(r.elementCreditUsd > 0, "hot as-found buffer above the pump max must credit the element");
});

test("7 representative summer days exceed the old static $2.76/wk under-count", () => {
  let total = 0, fixedTotal = 0;
  for (let i = 0; i < 7; i++) {
    const r = computeDayRealized({
      day: `2026-07-1${i}`, avgOutdoorF: 75, nowBufferF: 130, coverage: 1,
      measured: { elecKwh: 9.5, thermalKwh: 24, cop: 2.4, sinkF: 145, sessions: 8 },
    }, P);
    total += r.savedUsd; fixedTotal += r.fixedSavedUsd;
  }
  assert.ok(total > 2.76, `smart 7-day ($${total.toFixed(2)}) must exceed the old static $2.76`);
  assert.ok(fixedTotal > 2.76, `hardcoded-cool 7-day ($${fixedTotal.toFixed(2)}) must also exceed it`);
  assert.ok(total < 20 && fixedTotal < 20, "sane upper bound");
});

test("modeled fallback (no measured sessions) still produces a bounded, positive number", () => {
  const r = computeDayRealized({
    day: "2026-07-10", avgOutdoorF: 70, nowBufferF: 135, coverage: 1, measured: null,
  }, P);
  assert.equal(r.confidence, "modeled");
  assert.ok(r.savedUsd >= 0 && r.savedUsd < 3, `fallback saving out of band: $${r.savedUsd}`);
});

test("real SPAN energy overrides the baseline (energyMetered flips true, actual = span kWh)", () => {
  const base: DayInputs = {
    day: "2026-07-20", avgOutdoorF: 75, nowBufferF: 130, coverage: 1,
    measured: { elecKwh: 9.5, thermalKwh: 24, cop: 2.4, sinkF: 145, sessions: 8 },
  };
  const modeled = computeDayRealized(base, P);
  assert.equal(modeled.energyMetered, false);
  assert.equal(modeled.actualElecKwh, 11.8); // baseline (dailyKwhFallback × coverage)
  const metered = computeDayRealized({ ...base, spanKwh: 8.3 }, P);
  assert.equal(metered.energyMetered, true);
  assert.equal(metered.actualElecKwh, 8.3); // real SPAN energy
  assert.ok(metered.savedUsd > 0);
});

test("zero coverage (offline day) accrues no savings", () => {
  const r = computeDayRealized({
    day: "2026-07-09", avgOutdoorF: 75, nowBufferF: 135, coverage: 0,
    measured: { elecKwh: 0, thermalKwh: 0, cop: 2.4, sinkF: 145, sessions: 0 },
  }, P);
  assert.equal(r.savedUsd, 0);
});

console.log("realized-savings engine assertions: OK");
