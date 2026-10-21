/**
 * a2w#156 — the auto-pilot lifts the everyday I4 cap to sanitizeCapF ONLY for the block the plan marked `sani`.
 * A non-soak target above strictCap is refused (the plan and the auto-pilot disagree about what the hour is), never
 * written under the soak's ceiling. Plain node:assert script under tsx like the other planner suites.
 */
import assert from "node:assert/strict";
import { AutoPilot, commandForBlock } from "./autopilot";
import { DEFAULT_OPTS } from "./shadow";
import { curveOutputF } from "./curve";

type Call = { target: number; capF: number | undefined };
function harness(block: Record<string, unknown>, commanded: number | null = 120, stormCapF?: number, shaped = false, dryRun = false) {
  const calls: Call[] = []; const logs: Array<{ result: string }> = []; const curves: unknown[] = [];
  const store = {
    recentPlans: async () => [{ plan: [{ ts: new Date(Date.now() - 600_000).toISOString(), ...block }] }],
    insertAutopilotLog: async (row: { result: string }) => { logs.push(row); },
    activeBoost: async () => null,
  } as any;
  const writer = {
    status: async () => ({ commanded_target_f: commanded, curve_in_force: null }),
    setTarget: async (target: number, _source: string, capF?: number) => { calls.push({ target, capF }); return {}; },
    setCurve: async (c: unknown) => { if (!shaped) throw new Error("setCurve must not be called in flat-target mode"); curves.push(c); return {}; },
  } as any;
  const ap = new AutoPilot(store, writer, dryRun, async () => {}, shaped, stormCapF);
  return { ap, calls, logs, curves };
}

(async () => {
  // 1. a non-soak block above the everyday cap is REFUSED — no write, a logged rejection
  {
    const h = harness({ tank_target_f: 142, reason: "binding zone: Living Room Baseboard needs 137°F (winter solver shadow)" });
    await h.ap.applyLatestPlan();
    assert.equal(h.calls.length, 0, "no setTarget for a non-soak block above strictCap");
    assert.match(h.ap.lastResult, /rejected 142°F: non-soak block above the everyday cap 135°F/);
    assert.ok(h.logs.some((l) => l.result === "rejected: non-soak block above its cap"), "the rejection is recorded in autopilot_log");
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
  // 5. STORM identity (codex on #157): a storm block runs up to STORM_CAP_F when the owner raised it, and is refused
  //    above that; with the default cap (135) a storm block above 135 is refused like any other non-soak block
  {
    const raised = harness({ tank_target_f: 142, storm: true, reason: "storm mode: banking heat (High Wind Warning)" }, 120, 145);
    await raised.ap.applyLatestPlan();
    assert.deepEqual(raised.calls[0], { target: 142, capF: 145 }, "a storm block is written under STORM_CAP_F");
    const over = harness({ tank_target_f: 147, storm: true, reason: "storm mode: banking heat (High Wind Warning)" }, 120, 145);
    await over.ap.applyLatestPlan();
    assert.equal(over.calls.length, 0); assert.match(over.ap.lastResult, /storm block above STORM_CAP_F 145°F/);
    const dflt = harness({ tank_target_f: 142, storm: true, reason: "storm mode: banking heat (x)" });
    await dflt.ap.applyLatestPlan();
    assert.equal(dflt.calls.length, 0, "default STORM_CAP_F is the everyday cap: 142 refused");
    const under = harness({ tank_target_f: 135, storm: true, reason: "storm mode: banking heat (x)" });
    await under.ap.applyLatestPlan();
    assert.deepEqual(under.calls[0], { target: 135, capF: DEFAULT_OPTS.strictCapF });
  }
  // 6. the same rejection on two polls is recorded ONCE (record dedups by result|target) and leaves lastTargetF/lastResult stable
  {
    const h = harness({ tank_target_f: 142, reason: "binding zone: X needs 137°F" });
    await h.ap.applyLatestPlan(); await h.ap.applyLatestPlan();
    assert.equal(h.logs.filter((l) => l.result.startsWith("rejected:")).length, 1);
    assert.equal(h.ap.lastTargetF, 142); assert.match(h.ap.lastResult, /^rejected 142°F/);
  }
  // 7. SHAPED-CURVE mode (codex pass 2): a storm block whose reason was rewritten by forecast preheat is STILL an
  //    excursion by its flag — the flat storm target is written, the curve is not
  {
    const h = harness({ tank_target_f: 134, storm: true, reason: "forecast demand: preheat for the 06:00 cold front", shaped_curve: { dot: 46, dbt: 120, mbt: 118, wwsd: 125 } }, 120, 145, true);
    await h.ap.applyLatestPlan();
    assert.equal(h.curves.length, 0, "no curve write on a storm block");
    assert.deepEqual(h.calls[0], { target: 134, capF: 145 });
    // and a plain curve hour still commands the curve
    const c = harness({ tank_target_f: 120, reason: "DHW window floor", shaped_curve: { dot: 46, dbt: 120, mbt: 118, wwsd: 125 } }, 120, 145, true);
    await c.ap.applyLatestPlan();
    assert.equal(c.curves.length, 1); assert.equal(c.calls.length, 0);
  }
  // 8. COMBINED identity (codex pass 2): a storm window over the soak hour (sani + storm) may run to the HIGHER cap
  {
    const both = harness({ tank_target_f: 150, sani: true, storm: true, reason: "storm mode: banking heat (x)" }, 120, 150);
    await both.ap.applyLatestPlan();
    assert.deepEqual(both.calls[0], { target: 150, capF: 150 }, "sani 145 and storm 150 → 150");
    const over = harness({ tank_target_f: 151, sani: true, storm: true, reason: "storm mode: banking heat (x)" }, 120, 150);
    await over.ap.applyLatestPlan();
    assert.equal(over.calls.length, 0); assert.match(over.ap.lastResult, /soak\+storm block above both caps 150°F/);
    const soakOnlyCap = harness({ tank_target_f: 145, sani: true, storm: true, reason: "storm mode: banking heat (x)" }); // default storm cap 135 → the soak's 145 wins
    await soakOnlyCap.ap.applyLatestPlan();
    assert.deepEqual(soakOnlyCap.calls[0], { target: 145, capF: DEFAULT_OPTS.sanitizeCapF });
  }
  // 9. DRY-RUN previews the same verdict (codex pass 3): an unflagged 142 reads "would reject", a soak 142 reads "would set"; nothing is written either way
  {
    const bad = harness({ tank_target_f: 142, reason: "binding zone: X needs 137°F" }, 120, undefined, false, true);
    await bad.ap.applyLatestPlan();
    assert.equal(bad.calls.length, 0); assert.match(bad.ap.lastResult, /^DRY-RUN would reject 142°F: non-soak block above the everyday cap 135°F/);
    assert.ok(bad.logs.some((l) => l.result === "would-reject: non-soak block above its cap"));
    const ok = harness({ tank_target_f: 142, sani: true, reason: "daily sanitize to 140°F (I8)" }, 120, undefined, false, true);
    await ok.ap.applyLatestPlan();
    assert.equal(ok.calls.length, 0); assert.match(ok.ap.lastResult, /^DRY-RUN would set 142°F/);
  }
  // 10. a STORM_CAP_F configured BELOW the everyday cap cannot lower it (nit, pass 3)
  {
    const h = harness({ tank_target_f: 135, storm: true, reason: "storm mode: banking heat (x)" }, 120, 120);
    await h.ap.applyLatestPlan();
    assert.deepEqual(h.calls[0], { target: 135, capF: DEFAULT_OPTS.strictCapF });
  }
  // 11. commandForBlock — the number the identification driver's gates compare against — agrees with what
  //     applyLatestPlan WRITES for the same block (identification-plan-vs-command-2026-10-20.md: the 2026-10-19
  //     19:04 ET "winter guard" block said 135 °F, the auto-pilot wrote its 120/118 curve, the driver waited for 135)
  {
    const curve = { dot: 29, wwsd: 125, dbt: 120, mbt: 118 };
    const guard = { tank_target_f: 135, reason: "winter guard: mimic HBX curve", shaped_curve: curve, outdoor_f: 48.8 };
    // shaped-curve mode: a non-excursion block is commanded as its curve → the curve's output at the live outdoor
    assert.deepEqual(commandForBlock(guard, 49, true), { targetF: 120, basis: "curve" });
    assert.equal(commandForBlock(guard, 49, true)!.targetF, Math.round(curveOutputF(curve, 49)));
    assert.deepEqual(commandForBlock({ ...guard, shaped_curve: { dot: 5, wwsd: 125, dbt: 135, mbt: 118 } }, 49, true), { targetF: 129, basis: "curve" }, "a steep winter curve: 135 − 17·44/120 = 128.8");
    assert.deepEqual(commandForBlock({ ...guard, shaped_curve: { dot: 5, wwsd: 125, dbt: 135, mbt: 118 } }, 0, true), { targetF: 135, basis: "curve" }, "below dot the device holds dbt");
    // flat-target mode: the declared target, curve or not
    assert.deepEqual(commandForBlock(guard, 49, false), { targetF: 135, basis: "flat" });
    // an excursion is a flat write in shaped mode too — by flag and by the legacy reason regex
    for (const ex of [{ bank: true }, { sani: true }, { boost: true }, { storm: true }, { reason: "afternoon bank to 128°F (warmest hour)" }, { reason: "daily sanitize to 140°F = 60°C" }, { reason: "storm mode: banking heat" }, { reason: "pre-boost to 128°F for 08:00 window" }]) {
      assert.deepEqual(commandForBlock({ ...guard, tank_target_f: 128, ...ex }, 49, true), { targetF: 128, basis: "flat" }, JSON.stringify(ex));
    }
    // no curve on the block → flat; a curve hour with no outdoor to evaluate at → nothing to compare (fail closed);
    // no finite tank_target_f → nothing (applyLatestPlan refuses such a block before classifying it)
    assert.deepEqual(commandForBlock({ ...guard, shaped_curve: undefined }, 49, true), { targetF: 135, basis: "flat" });
    assert.deepEqual(commandForBlock({ ...guard, shaped_curve: { dot: 29, wwsd: 125, dbt: "120", mbt: 118 } }, 49, true), { targetF: 135, basis: "flat" }, "a malformed curve is no curve (curveDecision)");
    assert.equal(commandForBlock(guard, null, true), null);
    assert.equal(commandForBlock(guard, NaN, true), null);
    assert.equal(commandForBlock({ ...guard, tank_target_f: undefined }, 49, true), null);
    assert.equal(commandForBlock({ ...guard, tank_target_f: undefined, shaped_curve: undefined }, 49, false), null);
    assert.equal(commandForBlock(null, 49, true), null);
    // and the INSTANCE agrees with its own writes: the live block → setCurve (the 120/118 curve) and commandForBlock 120;
    // the bank block → setTarget 128 and commandForBlock 128; flat-target mode → setTarget 135 and commandForBlock 135
    const shaped = harness(guard, 140, undefined, true);
    await shaped.ap.applyLatestPlan();
    assert.equal(shaped.calls.length, 0, "a curve hour writes no flat target");
    assert.deepEqual(shaped.curves, [curve], "the block's shaped curve is the command");
    assert.match(shaped.ap.lastResult, /^commanded curve 120@29→118@125/);
    assert.deepEqual(shaped.ap.commandForBlock(guard, 49), { targetF: 120, basis: "curve" });
    assert.equal(shaped.ap.lastTargetF, 135, "the ledger still carries the declared target beside the set-curve row (as autopilot_log 1886 did)");
    const bankBlock = { ...guard, tank_target_f: 128, bank: true, reason: "afternoon bank to 128°F (warmest hour, 52°F outdoor)" };
    const bank = harness(bankBlock, 120, undefined, true);
    await bank.ap.applyLatestPlan();
    assert.deepEqual(bank.calls, [{ target: 128, capF: DEFAULT_OPTS.strictCapF }]);
    assert.equal(bank.curves.length, 0);
    assert.deepEqual(bank.ap.commandForBlock(bankBlock, 49), { targetF: 128, basis: "flat" });
    const flat = harness(guard, 120, undefined, false);
    await flat.ap.applyLatestPlan();
    assert.deepEqual(flat.calls, [{ target: 135, capF: DEFAULT_OPTS.strictCapF }], "flat-target mode writes the declared 135");
    assert.deepEqual(flat.ap.commandForBlock(guard, 49), { targetF: 135, basis: "flat" });
  }
  console.log("autopilot.test.ts (#156 cap by the block's identity): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
