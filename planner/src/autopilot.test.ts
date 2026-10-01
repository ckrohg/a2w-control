/**
 * a2w#156 — the auto-pilot lifts the everyday I4 cap to sanitizeCapF ONLY for the block the plan marked `sani`.
 * A non-soak target above strictCap is refused (the plan and the auto-pilot disagree about what the hour is), never
 * written under the soak's ceiling. Plain node:assert script under tsx like the other planner suites.
 */
import assert from "node:assert/strict";
import { AutoPilot } from "./autopilot";
import { DEFAULT_OPTS } from "./shadow";

type Call = { target: number; capF: number | undefined };
function harness(block: Record<string, unknown>, commanded: number | null = 120) {
  const calls: Call[] = []; const logs: Array<{ result: string }> = [];
  const store = {
    recentPlans: async () => [{ plan: [{ ts: new Date(Date.now() - 600_000).toISOString(), ...block }] }],
    insertAutopilotLog: async (row: { result: string }) => { logs.push(row); },
  } as any;
  const writer = {
    status: async () => ({ commanded_target_f: commanded, curve_in_force: null }),
    setTarget: async (target: number, _source: string, capF?: number) => { calls.push({ target, capF }); return {}; },
    setCurve: async () => { throw new Error("setCurve must not be called in flat-target mode"); },
  } as any;
  const ap = new AutoPilot(store, writer, false, async () => {});
  return { ap, calls, logs };
}

(async () => {
  // 1. a non-soak block above the everyday cap is REFUSED — no write, a logged rejection
  {
    const h = harness({ tank_target_f: 142, reason: "binding zone: Living Room Baseboard needs 137°F (winter solver shadow)" });
    await h.ap.applyLatestPlan();
    assert.equal(h.calls.length, 0, "no setTarget for a non-soak block above strictCap");
    assert.match(h.ap.lastResult, /rejected 142°F: non-soak block above the everyday cap 135°F/);
    assert.ok(h.logs.some((l) => l.result.startsWith("rejected: non-soak block above everyday cap")), "the rejection is recorded in autopilot_log");
  }
  // 2. the soak block (sani) above the everyday cap is written with the sanitize ceiling
  {
    const h = harness({ tank_target_f: 142, sani: true, reason: "daily sanitize to 140°F = 60°C (I8 pasteurization, warmest hour) — raised to the demand floor 142°F (binding zone: Living Room Baseboard needs 137°F (winter solver shadow))" });
    await h.ap.applyLatestPlan();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.calls[0], { target: 142, capF: DEFAULT_OPTS.sanitizeCapF });
    assert.match(h.ap.lastResult, /^set 142°F/);
  }
  // 3. an ordinary block at or below the everyday cap is written with the everyday cap — even when flagged sani the cap is the soak's (the flag decides, not the size)
  {
    const h = harness({ tank_target_f: 130, reason: "DHW window floor" });
    await h.ap.applyLatestPlan();
    assert.deepEqual(h.calls[0], { target: 130, capF: DEFAULT_OPTS.strictCapF });
    const s = harness({ tank_target_f: 130, sani: true, reason: "daily sanitize to 140°F (I8)" });
    await s.ap.applyLatestPlan();
    assert.deepEqual(s.calls[0], { target: 130, capF: DEFAULT_OPTS.sanitizeCapF });
  }
  // 4. the magnitude never decides: exactly strictCap without sani passes with the everyday cap; one degree above is refused
  {
    const ok = harness({ tank_target_f: DEFAULT_OPTS.strictCapF, reason: "binding zone: X needs 131°F" });
    await ok.ap.applyLatestPlan();
    assert.deepEqual(ok.calls[0], { target: DEFAULT_OPTS.strictCapF, capF: DEFAULT_OPTS.strictCapF });
    const no = harness({ tank_target_f: DEFAULT_OPTS.strictCapF + 1, reason: "binding zone: X needs 131°F" });
    await no.ap.applyLatestPlan();
    assert.equal(no.calls.length, 0);
  }
  console.log("autopilot.test.ts (#156 cap by the block's sani flag): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
