/**
 * @purpose Incident 2026-10-14..16 follow-up: an active boost (hbx_boosts, POST /api/hbx/boost) HOLDS the auto-pilot.
 * Before this the auto-pilot never read hbx_boosts and wrote its plan over the owner's boost as soon as the 15-min
 * rate limit cleared. The hold covers flat and shaped-curve mode and dry run, is logged as `held` (never a
 * rejection), ends when the boost's restore_at passes, and fails closed if the boost lookup itself fails.
 * Plain node:assert script under tsx like the other planner suites.
 */
import assert from "node:assert/strict";
import { AutoPilot } from "./autopilot";

type Boost = { targetF: number; restoreAt: Date } | null;
type Log = { targetF: number | null; reason: string; result: string; dryRun: boolean };

function harness(block: Record<string, unknown>, opts: { boost?: Boost; commanded?: number | null; shaped?: boolean; dryRun?: boolean } = {}) {
  const writes: Array<{ kind: "target" | "curve"; arg: unknown }> = [];
  const logs: Log[] = [];
  const state = { boost: opts.boost ?? null as Boost, boostError: null as Error | null, block };
  const store = {
    recentPlans: async () => [{ plan: [{ ts: new Date(Date.now() - 600_000).toISOString(), ...state.block }] }],
    insertAutopilotLog: async (row: Log) => { logs.push(row); },
    activeBoost: async () => { if (state.boostError) throw state.boostError; return state.boost; },
  } as any;
  const writer = {
    status: async () => ({ commanded_target_f: opts.commanded === undefined ? 120 : opts.commanded, curve_in_force: null }),
    setTarget: async (target: number) => { writes.push({ kind: "target", arg: target }); return {}; },
    setCurve: async (c: unknown) => { writes.push({ kind: "curve", arg: c }); return {}; },
  } as any;
  const ap = new AutoPilot(store, writer, opts.dryRun ?? false, async () => {}, opts.shaped ?? false);
  return { ap, writes, logs, state };
}

const restoreAt = new Date(Date.now() + 3 * 3600_000);
const boost130: Boost = { targetF: 130, restoreAt };
const plan = { tank_target_f: 112, reason: "DHW window floor" };
const curveBlock = { tank_target_f: 112, reason: "binding zone: Living Room Baseboard needs 108°F", shaped_curve: { dot: 5, wwsd: 70, dbt: 125, mbt: 100 } };

(async () => {
  // 1. LIVE flat-target mode: an active boost → no write, a `held` decision that names the boost, its target and the plan's
  {
    const h = harness(plan, { boost: boost130 });
    await h.ap.applyLatestPlan();
    assert.equal(h.writes.length, 0, "the auto-pilot must not write over an active boost");
    assert.match(h.ap.lastResult, /^held for boost to 130°F until .* — plan wants 112°F, not applied$/);
    assert.equal(h.ap.lastTargetF, 130, "the heartbeat target is what is actually held: the boost's");
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0].result, "held", "logged as held — the dashboard renders `held` as ok, never as a rejection");
    assert.equal(h.logs[0].targetF, 130);
    assert.match(h.logs[0].reason, /^boost 130°F until .* — plan wants 112°F \(DHW window floor\), resumes after$/);
    assert.ok(!h.logs.some((l) => l.result.startsWith("rejected")));
  }
  // 2. shaped-curve mode: a curve hour is held too — no setCurve over the boost
  {
    const h = harness(curveBlock, { boost: boost130, shaped: true });
    await h.ap.applyLatestPlan();
    assert.equal(h.writes.length, 0, "no setCurve while a boost is active");
    assert.equal(h.logs[0]?.result, "held");
    // control: the same block without a boost commands the curve (the harness is not what stops the write)
    const c = harness(curveBlock, { shaped: true });
    await c.ap.applyLatestPlan();
    assert.deepEqual(c.writes.map((w) => w.kind), ["curve"]);
  }
  // 3. dry run: held, not "would-set" — the shadow log must not claim the auto-pilot would overwrite the boost
  {
    const h = harness(plan, { boost: boost130, dryRun: true });
    await h.ap.applyLatestPlan();
    assert.equal(h.writes.length, 0);
    assert.equal(h.logs[0].result, "held");
    assert.equal(h.logs[0].dryRun, true);
  }
  // 4. an excursion above its cap during a boost is held, not rejected (nothing is decided while a human holds the target)
  {
    const h = harness({ tank_target_f: 142, reason: "binding zone: X needs 137°F" }, { boost: boost130 });
    await h.ap.applyLatestPlan();
    assert.equal(h.writes.length, 0);
    assert.equal(h.logs[0].result, "held");
  }
  // 5. the boost lapses (restore_at passed → activeBoost() null) → the auto-pilot resumes the plan on the next poll
  {
    const h = harness(plan, { boost: boost130 });
    await h.ap.applyLatestPlan();
    assert.equal(h.writes.length, 0);
    h.state.boost = null;
    await h.ap.applyLatestPlan();
    assert.deepEqual(h.writes, [{ kind: "target", arg: 112 }], "the plan target is written once the boost is over");
    assert.match(h.ap.lastResult, /^set 112°F/);
    assert.deepEqual(h.logs.map((l) => l.result), ["held", "set"]);
  }
  // 6. dedup: polls through ONE boost are one row; the hold is a distinct row from an "already commanded" hold at
  //    the same target, and a second boost (new restore_at) at the same target is its own row
  {
    const h = harness({ tank_target_f: 130, reason: "storm mode: banking heat (x)" }, { commanded: 130 });
    await h.ap.applyLatestPlan();
    assert.equal(h.logs.length, 1); assert.match(h.ap.lastResult, /already commanded/);
    h.state.boost = boost130;
    await h.ap.applyLatestPlan(); await h.ap.applyLatestPlan(); await h.ap.applyLatestPlan();
    assert.equal(h.logs.length, 2, "already-commanded → boost hold is a transition, logged once");
    h.state.boost = { targetF: 130, restoreAt: new Date(restoreAt.getTime() + 3600_000) };
    await h.ap.applyLatestPlan();
    assert.equal(h.logs.length, 3, "a new boost at the same target is a new row");
    assert.equal(h.writes.length, 0);
  }
  // 7. a plan pre-boost hour reached during the hold is remembered as held, with the PLAN's target (/health.dhw)
  {
    const h = harness({ tank_target_f: 129, boost: true, reason: "pre-boost to 129°F for 08:00 window" }, { boost: boost130 });
    await h.ap.applyLatestPlan();
    assert.equal(h.writes.length, 0);
    assert.equal(h.ap.lastPreBoost?.toF, 129);
    assert.equal(h.ap.lastPreBoost?.result, "held: boost active");
    assert.match(h.ap.lastPreBoost!.reason, /pre-boost to 129°F/);
  }
  // 8. the boost hold wins over an identification hold (identify.ts aborts its window on a boost anyway)
  {
    const h = harness(plan, { boost: boost130 });
    h.ap.setHold(new Date(Date.now() + 3600_000), "identification window w1");
    await h.ap.applyLatestPlan();
    assert.match(h.ap.lastResult, /^held for boost/);
  }
  // 9. fail closed: if the boost lookup throws, nothing is written (index.ts logs "autopilot failed" and retries next poll)
  {
    const h = harness(plan);
    h.state.boostError = new Error("connection terminated");
    await assert.rejects(h.ap.applyLatestPlan(), /connection terminated/);
    assert.equal(h.writes.length, 0, "an unreadable hbx_boosts must not be treated as no boost");
  }
  // 10. no boost → behaviour unchanged: the plan target is written
  {
    const h = harness(plan);
    await h.ap.applyLatestPlan();
    assert.deepEqual(h.writes, [{ kind: "target", arg: 112 }]);
  }
  console.log("autopilot boost hold: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
