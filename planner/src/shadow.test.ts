/**
 * @purpose Assertions for the demand-aware I8 soak block in computeShadowPlan (shadow.ts). Run with:
 * npx tsx planner/src/shadow.test.ts — exits non-zero on failure. Pins that the 140°F sanitize block
 * appears iff `sanitizeDue`, so the plan→autopilot→Phase B path (which coordinates the pump-setpoint
 * lead) runs the soak exactly when the caller says a pasteurization is due — and skips it otherwise.
 */
import assert from "node:assert/strict";
import { computeShadowPlan, DEFAULT_OPTS, type ForecastHour } from "./shadow";

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

console.log("shadow.test.ts: all assertions passed ✓");
