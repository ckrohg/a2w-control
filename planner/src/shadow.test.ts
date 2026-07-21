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

console.log("shadow.test.ts: all assertions passed ✓");
