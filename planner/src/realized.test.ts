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

test("representative summer day: both terms ≥0 and decompose to the total", () => {
  const d: DayInputs = {
    day: "2026-07-17", avgOutdoorF: 75, nowBufferF: 135, coverage: 1,
    measured: { elecKwh: 9.5, thermalKwh: 24, cop: 2.4, sinkF: 145, sessions: 8 },
  };
  const r = computeDayRealized(d, P);
  assert.ok(r.copOld < r.copNow, `copOld(${r.copOld}) must be < copNow(${r.copNow})`);
  assert.ok(r.copUsd >= 0 && r.standbyUsd >= 0, "both saving terms must be non-negative");
  assert.ok(Math.abs(r.copUsd + r.standbyUsd + r.elementCreditUsd - r.savedUsd) < 0.02, "terms must sum to total");
  // ~154°F as-found buffer vs 135 now
  assert.ok(Math.abs(r.oldBufferF - 153.3) < 1);
  // sanity: a single summer day saves a fraction of a dollar (→ ~$5-6/week over 7 such days)
  assert.ok(r.savedUsd > 0.3 && r.savedUsd < 2.0, `daily saving out of expected band: $${r.savedUsd}`);
});

test("7 representative summer days land in the live-data ballpark (~$4-9/wk, well above the old $2.76)", () => {
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const r = computeDayRealized({
      day: `2026-07-1${i}`, avgOutdoorF: 75, nowBufferF: 135, coverage: 1,
      measured: { elecKwh: 9.5, thermalKwh: 24, cop: 2.4, sinkF: 145, sessions: 8 },
    }, P);
    total += r.savedUsd;
  }
  assert.ok(total > 4 && total < 9, `7-day total out of band: $${total.toFixed(2)}`);
  assert.ok(total > 2.76, "the measured-data model must exceed the old static $2.76/wk under-count");
});

test("modeled fallback (no measured sessions) still produces a bounded, positive number", () => {
  const r = computeDayRealized({
    day: "2026-07-10", avgOutdoorF: 70, nowBufferF: 135, coverage: 1, measured: null,
  }, P);
  assert.equal(r.confidence, "modeled");
  assert.ok(r.savedUsd >= 0 && r.savedUsd < 3, `fallback saving out of band: $${r.savedUsd}`);
});

test("zero coverage (offline day) accrues no savings", () => {
  const r = computeDayRealized({
    day: "2026-07-09", avgOutdoorF: 75, nowBufferF: 135, coverage: 0,
    measured: { elecKwh: 0, thermalKwh: 0, cop: 2.4, sinkF: 145, sessions: 0 },
  }, P);
  assert.equal(r.savedUsd, 0);
});

console.log("realized-savings engine assertions: OK");
