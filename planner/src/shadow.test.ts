/**
 * @purpose Assertions for the I8 interlock in computeShadowPlan (shadow.ts). Run locally with:
 * npx tsx planner/src/shadow.test.ts — exits non-zero on failure. Pins the safety-critical property
 * that the calendar sanitize boost appears iff the demand-driven checkI8 actuator is NOT armed, so a
 * rollout never ends up with two soak actuators or (worse) none.
 */
import assert from "node:assert/strict";
import { computeShadowPlan, DEFAULT_OPTS, type ForecastHour } from "./shadow";

// A flat summer day: 24 hours, all warm (no winter guard, no natural ≥sanitizeF hour). Timestamps use
// LOCAL components so day-grouping + warmest-hour selection are deterministic regardless of machine TZ.
const forecast: ForecastHour[] = Array.from({ length: 24 }, (_, h) => ({
  ts: new Date(2026, 6, 15, h, 0, 0),
  outdoorF: 70 + h * 0.5, // 70 → 81.5°F, unique warmest hour at h=23
}));

// 1. Default (autoSanitize:false) → the calendar boost fires: exactly one block reaches sanitizeF (140).
{
  const plan = computeShadowPlan(forecast, null, DEFAULT_OPTS);
  const boosted = plan.filter((b) => b.tank_target_f >= DEFAULT_OPTS.sanitizeF);
  assert.equal(boosted.length, 1, "default plan should have exactly one 140°F sanitize block");
  assert.match(boosted[0].reason, /sanitize/i, "boost block reason should mention sanitize");
}

// 2. Armed (autoSanitize:true) → boost STANDS DOWN: no block exceeds the everyday strict cap, and no
//    block is tagged as a sanitize excursion. checkI8 owns the soak in this mode.
{
  const plan = computeShadowPlan(forecast, null, { ...DEFAULT_OPTS, autoSanitize: true });
  const overCap = plan.filter((b) => b.tank_target_f > DEFAULT_OPTS.strictCapF);
  assert.equal(overCap.length, 0, "armed plan must never exceed strictCap (no calendar soak)");
  assert.equal(plan.some((b) => /sanitize/i.test(b.reason)), false, "armed plan has no sanitize block");
}

// 3. Both modes agree on every NON-sanitize block — the interlock only removes the soak, nothing else.
{
  const on = computeShadowPlan(forecast, null, DEFAULT_OPTS);
  const off = computeShadowPlan(forecast, null, { ...DEFAULT_OPTS, autoSanitize: true });
  let differing = 0;
  for (let i = 0; i < on.length; i++) if (on[i].tank_target_f !== off[i].tank_target_f) differing++;
  assert.equal(differing, 1, "exactly one hour (the soak) should differ between the two modes");
}

console.log("shadow.test.ts: all assertions passed ✓");
