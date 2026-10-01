/**
 * eval 2026-09-30 F6 — the auto-pilot remembers the last pre-boost block it acted on (set / dry-run / rate-limited /
 * rejected) so /health.dhw.last_pre_boost can say whether the morning boost fired. Plain node:assert under tsx.
 */
import assert from "node:assert/strict";
import { AutoPilot } from "./autopilot";
import { WriteError } from "./writes";

function harness(block: Record<string, unknown>, opts: { dryRun?: boolean; fail?: Error } = {}) {
  const store = { recentPlans: async () => [{ plan: [{ ts: new Date(Date.now() - 600_000).toISOString(), ...block }] }], insertAutopilotLog: async () => {} } as any;
  const writer = {
    status: async () => ({ commanded_target_f: 120, curve_in_force: null }),
    setTarget: async () => { if (opts.fail) throw opts.fail; return {}; },
    setCurve: async () => ({}),
  } as any;
  return new AutoPilot(store, writer, opts.dryRun ?? false, async () => {});
}

(async () => {
  const boost = { tank_target_f: 129, boost: true, reason: "pre-boost to 129°F for 08:00 window (sag p75 9.3°F over 9 draws)" };
  // 1. a written boost is remembered with its result
  { const ap = harness(boost); await ap.applyLatestPlan(); assert.deepEqual({ toF: ap.lastPreBoost?.toF, result: ap.lastPreBoost?.result }, { toF: 129, result: "set" }); assert.match(ap.lastPreBoost!.reason, /pre-boost to 129°F for 08:00 window/); assert.ok(Date.parse(ap.lastPreBoost!.at) > 0); }
  // 2. dry-run and rate-limit and rejection are remembered too — the question "did it fire" needs the honest answer
  { const ap = harness(boost, { dryRun: true }); await ap.applyLatestPlan(); assert.equal(ap.lastPreBoost?.result, "would-set"); }
  { const ap = harness(boost, { fail: new WriteError(429, "rate limited") }); await ap.applyLatestPlan(); assert.equal(ap.lastPreBoost?.result, "rate-limited"); }
  { const ap = harness(boost, { fail: new WriteError(422, "I1 would be violated") }); await ap.applyLatestPlan(); assert.match(ap.lastPreBoost?.result ?? "", /^rejected: /); }
  // 2b. HELD outcomes are remembered too — already commanded within tolerance, and an identification hold (codex on #158)
  { const ap = harness({ ...boost, tank_target_f: 121 }); await ap.applyLatestPlan(); assert.equal(ap.lastPreBoost?.result, "held", "within 2 °F of the commanded 120 → held, still recorded"); }
  { const ap = harness(boost); ap.setHold(new Date(Date.now() + 3600_000), "identification window w1"); await ap.applyLatestPlan(); assert.equal(ap.lastPreBoost?.result, "held"); assert.equal(ap.lastPreBoost?.toF, 129); }
  // 2c. a later non-boost block leaves the last boost in place
  { const ap = harness(boost); await ap.applyLatestPlan(); const keep = ap.lastPreBoost; (ap as any).store.recentPlans = async () => [{ plan: [{ ts: new Date().toISOString(), tank_target_f: 120, reason: "DHW window floor" }] }]; await ap.applyLatestPlan(); assert.deepEqual(ap.lastPreBoost, keep); }
  // 3. a non-boost block never touches it
  { const ap = harness({ tank_target_f: 120, reason: "DHW window floor" }); await ap.applyLatestPlan(); assert.equal(ap.lastPreBoost, null); }
  console.log("autopilot-observability.test.ts (F6 last pre-boost): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
