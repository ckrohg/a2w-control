/**
 * @purpose #232 — a restore returns the plant to the PLAN's command, not the July as-found curve. Before this, a boost
 * expiry (expireBoosts → restoreSerial) and the Control page's "Restore curve" re-applied hbx_config_versions row 1
 * (2026-07-13: dot 5 / dbt 165 / mbt 145 ≈ 158 °F at 46 °F outdoor) and set lastWriteAt, so under SHAPED_CURVE live
 * the device ran a 158 °F target against ~125 °F pump setpoints for up to 15 min: an I1 violation, Phase B chasing it
 * to the 140 °F cap. Now the restore lands what the auto-pilot commands for the block in force (the shaped curve on a
 * curve hour, the flat excursion target otherwise) through the same I4 / I1 / lease guards, rate-limit exempt, and the
 * auto-pilot's next tick reads "already commanded". The as-found endpoints are written only when nothing of the plan
 * is being commanded, or on an explicit `to: "as-found"`. REAL writer + REAL auto-pilot over fakes, prod-like numbers.
 * Plain node:assert under tsx: npx tsx planner/src/writes-restore.test.ts
 */
import assert from "node:assert/strict";
import { HbxWriter, WriteError, isBoostYield } from "./writes";
import { AutoPilot } from "./autopilot";
import { curveOutputF } from "./curve";

const OUTDOOR_F = 46;                                           // 2026-10-26 02:29Z, the review that found #232
const AS_FOUND = { dot: 5, wwsd: 125, dbt: 165, mbt: 145 };     // hbx_config_versions row 1 (2026-07-13)
const PLAN_CURVE = { dot: 30, wwsd: 125, dbt: 120, mbt: 118 };  // the curve in force that night → 119.7 °F at 46 °F
const cToF = (c: number) => (c * 9) / 5 + 32;
/** The near-flat curve setTargetSerial writes for a flat target at OUTDOOR_F over the live dot/wwsd (its own solve). */
function flatCurve(targetF: number, live: { dot: number; wwsd: number }): { dbt: number; mbt: number } {
  const f = Math.max(0, Math.min(1, (OUTDOOR_F - live.dot) / (live.wwsd - live.dot)));
  return { dbt: Math.round(targetF + 4 * f), mbt: Math.round(targetF - 4 * (1 - f)) };
}
type Block = Record<string, unknown>;
const curveBlock: Block = { tank_target_f: 135, reason: "winter guard: mimic HBX curve", shaped_curve: { ...PLAN_CURVE, basis: {} } };
const bankBlock: Block = { tank_target_f: 128, bank: true, reason: "afternoon bank to 128°F (warmest hour, 52°F outdoor)", shaped_curve: { ...PLAN_CURVE, basis: {} } };

function harness(o: { blocks?: Block[] | null; live?: Record<string, number>; setpointC?: number; shaped?: boolean; dryRun?: boolean; wire?: boolean; piConnected?: boolean } = {}) {
  const patches: Array<Record<string, number>> = [];
  const audits: Array<{ source: string; action: string; result: string; detail?: string | null }> = [];
  let live: Record<string, number> = { ...(o.live ?? PLAN_CURVE) };
  const boosts: Array<{ id: number; targetF: number; restoreAt: Date; restored: boolean; createdAt?: Date }> = [];
  const apLogs: Array<{ targetF: number | null; reason: string; result: string }> = [];
  const state = { setpointC: o.setpointC ?? 52, piConnected: o.piConnected ?? true, blocks: o.blocks === undefined ? [curveBlock] : o.blocks, plansError: null as Error | null };
  const store = {
    getLatestSlx: async () => ({ ts: new Date(), tankF: 126, targetF: 128, outdoorF: OUTDOOR_F }),
    latestConfig: async () => ({ ...live }),
    baselineConfig: async () => ({ ...AS_FOUND }),
    insertHbxWrite: async (w: { source: string; action: string; result: string; detail?: string | null }) => { audits.push(w); },
    insertConfigVersion: async () => {},
    insertBoost: async (targetF: number, restoreAt: Date) => { for (const b of boosts) b.restored = true; const id = boosts.length + 1; boosts.push({ id, targetF, restoreAt, restored: false, createdAt: new Date() }); return id; },
    retireBoost: async (id: number) => { for (const b of boosts) if (b.id === id) b.restored = true; },
    activeBoost: async () => { const b = boosts.filter((x) => !x.restored && x.restoreAt.getTime() > Date.now()).at(-1); return b ? { targetF: b.targetF, restoreAt: b.restoreAt } : null; },
    dueBoosts: async () => boosts.filter((x) => !x.restored && x.restoreAt.getTime() <= Date.now()).map((x) => ({ id: x.id, targetF: x.targetF })),
    markBoostsRestored: async (ids: number[]) => { for (const b of boosts) if (ids.includes(b.id)) b.restored = true; },
    retireOpenBoosts: async (before: Date) => { for (const b of boosts) if ((b.createdAt ?? new Date(0)).getTime() <= before.getTime()) b.restored = true; },
    recentPlans: async () => {
      if (state.plansError) throw state.plansError;
      return state.blocks ? [{ plan: state.blocks.map((b, i) => ({ ts: new Date(Date.now() - (state.blocks!.length - i) * 600_000).toISOString(), ...b })) }] : [];
    },
    insertAutopilotLog: async (l: { targetF: number | null; reason: string; result: string }) => { apLogs.push(l); },
  } as any;
  const slx = { patchDevice: async (_b: string, _s: string, fields: Record<string, number>) => {
    patches.push(fields); live = { ...live, ...fields };
    return { syncCode: "x", ...live, temps: { temp1: { actual: 126, target: 128 }, temp3: { actual: OUTDOOR_F } } };
  } } as any;
  const hub = { getState: async () => ({ pi_connected: state.piConnected, ts: Math.floor(Date.now() / 1000) - 10,
    pumps: [{ id: "pump1", name: "P1", online: true, setpoint_c: state.setpointC }, { id: "pump2", name: "P2", online: true, setpoint_c: state.setpointC }] }) } as any;
  const writer = new HbxWriter(slx, store, hub, "b", "s", async () => {});
  const autopilot = new AutoPilot(store, writer, o.dryRun ?? false, async () => {}, o.shaped ?? true);
  if (o.wire !== false) writer.setPlanCommand(() => autopilot.planCommand()); // what index.ts does
  /** a boost whose timer has run out, with the device still holding its near-flat curve (what the expiry sees) */
  const expiredBoost = (targetF: number) => {
    live = { ...live, ...flatCurve(targetF, live as { dot: number; wwsd: number }) };
    boosts.push({ id: boosts.length + 1, targetF, restoreAt: new Date(Date.now() - 60_000), restored: false, createdAt: new Date(Date.now() - 15 * 60_000) });
  };
  const outputAtLive = (p: Record<string, number>) => curveOutputF({ dot: p.dot ?? live.dot, wwsd: p.wwsd ?? live.wwsd, dbt: p.dbt, mbt: p.mbt }, OUTDOOR_F);
  return { writer, autopilot, patches, audits, boosts, apLogs, state, expiredBoost, outputAtLive, live: () => live };
}
async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try { await p; return "ok"; } catch (e) { if (e instanceof WriteError) return e.status; throw e; }
}
/** I1 as the monitor and Phase B see it: every PATCH's output at the live outdoor must sit ≥ 5 °F under the setpoints. */
function assertNoI1Window(h: ReturnType<typeof harness>, label: string) {
  for (const p of h.patches) {
    const out = h.outputAtLive(p);
    assert.ok(out + 5 <= cToF(h.state.setpointC) + 1e-9, `${label}: a PATCH outputs ${out.toFixed(1)} °F at ${OUTDOOR_F} °F against ${cToF(h.state.setpointC).toFixed(1)} °F setpoints — the I1 window #232 describes`);
    assert.ok(out < 150, `${label}: a PATCH outputs ${out.toFixed(1)} °F — the as-found curve came back`);
  }
}

(async () => {
  // 1. Boost expiry on a CURVE hour (SHAPED_CURVE live): the restore is the plan's shaped curve, audited as a restore,
  //    I1-clean against 52 °C setpoints; the auto-pilot's next tick reads "already commanded" — no second write, no
  //    15-min hole. The 165/145 as-found curve never reaches the device.
  {
    const h = harness();
    h.expiredBoost(128);
    await h.writer.expireBoosts();
    assert.deepEqual(h.patches, [{ ...PLAN_CURVE }], "the one PATCH is the plan's curve (dot/dbt/mbt + the unchanged wwsd)");
    assert.equal(h.boosts[0].restored, true, "the boost row is marked restored");
    const a = h.audits.at(-1)!;
    assert.equal(a.source, "boost-expiry"); assert.equal(a.action, "restore"); assert.equal(a.result, "accepted");
    assert.match(a.detail ?? "", /^plan curve restored: 120°F at 30°F → 118°F at 125°F \(output 119\.7°F at 46°F outdoor/);
    assertNoI1Window(h, "curve hour");
    await h.autopilot.applyLatestPlan();
    assert.match(h.autopilot.lastResult, /^holding curve 120@30→118@125 .* — already commanded$/, `the auto-pilot has nothing to write: ${h.autopilot.lastResult}`);
    assert.equal(h.patches.length, 1, "no second PATCH, nothing rate-limited");
    assert.equal(h.apLogs.at(-1)?.result, "held-curve");
  }
  // 2. Boost expiry on an EXCURSION hour (the afternoon bank, 128 °F): the restore is the flat bank target under the
  //    everyday cap, audited as a set_target (it closes the boost's TempIQ window AND opens the excursion's), and the
  //    auto-pilot's next tick is "already commanded" (midpoint within tolerance).
  {
    const h = harness({ blocks: [bankBlock], setpointC: 60 });
    h.expiredBoost(131);
    assert.deepEqual(h.live(), { ...PLAN_CURVE, ...flatCurve(131, PLAN_CURVE) }, "the device holds the boost's 131 °F near-flat curve");
    await h.writer.expireBoosts();
    assert.deepEqual(h.patches, [flatCurve(128, PLAN_CURVE)], "the restore is the bank's 128 °F, solved over the live dot/wwsd like any flat write");
    assert.equal(Math.round(h.outputAtLive(h.patches[0])), 128);
    const a = h.audits.at(-1)!;
    assert.equal(a.action, "set_target"); assert.equal(a.result, "accepted");
    assert.match(a.detail ?? "", /^target 128°F restored \(the plan's target for the block in force; curve 129\/125/);
    assertNoI1Window(h, "excursion hour");
    await h.autopilot.applyLatestPlan();
    assert.match(h.autopilot.lastResult, /^holding 128°F .* — already commanded$/, h.autopilot.lastResult);
    assert.equal(h.patches.length, 1);
  }
  // 3. Flat-target mode (SHAPED_CURVE off): the restore is the block's flat tank_target_f, as applyLatestPlan writes it.
  {
    const h = harness({ blocks: [{ tank_target_f: 120, reason: "DHW window floor" }], shaped: false });
    h.expiredBoost(128);
    await h.writer.expireBoosts();
    assert.deepEqual(h.patches, [flatCurve(120, PLAN_CURVE)]);
    assert.equal(h.audits.at(-1)?.action, "set_target");
    await h.autopilot.applyLatestPlan();
    assert.match(h.autopilot.lastResult, /already commanded/);
    assert.equal(h.patches.length, 1);
  }
  // 4. The as-found curve comes back ONLY when nothing of the plan is being commanded — and the audit says why.
  {
    const asFound = { dbt: AS_FOUND.dbt, mbt: AS_FOUND.mbt, dot: AS_FOUND.dot };
    const a = harness({ wire: false }); // AUTOPILOT_ENABLED=0: no resolver
    a.expiredBoost(128); await a.writer.expireBoosts();
    assert.deepEqual(a.patches, [asFound]); assert.match(a.audits.at(-1)?.detail ?? "", /as-found curve restored .* — no plan command resolver/);
    const b = harness({ dryRun: true }); // the Off/Armed switch is Off: the planner does not command the plan, so a restore must not either
    b.expiredBoost(128); await b.writer.expireBoosts();
    assert.deepEqual(b.patches, [asFound]); assert.match(b.audits.at(-1)?.detail ?? "", /auto-pilot in shadow/);
    const c = harness({ blocks: null }); // no recent plan at all
    c.expiredBoost(128); await c.writer.expireBoosts();
    assert.deepEqual(c.patches, [asFound]);
    const d = harness({ blocks: [{ reason: "no target" }] }); // a block the auto-pilot refuses before classifying
    d.expiredBoost(128); await d.writer.expireBoosts();
    assert.deepEqual(d.patches, [asFound]);
    for (const h of [a, b, c, d]) assert.equal(h.boosts[0].restored, true);
  }
  // 5. The Control page's POST /api/hbx/restore: the default returns to the plan and cancels the boost (endsBoost);
  //    the explicit as-found option is the pre-#232 path, still rate-limit AND I1 exempt (the emergency semantics).
  {
    const h = harness({ setpointC: 60 });
    assert.equal(await status(h.writer.boost(128, 60, "dashboard")), "ok");
    assert.equal(h.boosts.filter((b) => !b.restored).length, 1);
    const r = await h.writer.restore("dashboard", { endsBoost: true });
    assert.deepEqual(h.patches.at(-1), { ...PLAN_CURVE }, "the default restore is the plan's curve");
    assert.match(String(r.detail), /^plan curve restored/, "…and the response says so");
    assert.equal(h.boosts.filter((b) => !b.restored).length, 0, "the owner's restore retired the boost");
    h.state.setpointC = 50; // 122 °F: even the plan's 120 °F curve would be refused by I1 now
    assert.equal(await status(h.writer.restore("dashboard", { endsBoost: true })), 409, "the plan restore honours I1");
    assert.equal(await status(h.writer.restore("dashboard", { endsBoost: true, to: "as-found" })), "ok", "the as-found path stays unguarded, as before");
    assert.deepEqual(h.patches.at(-1), { dbt: 165, mbt: 145, dot: 5 });
    assert.match(h.audits.at(-1)?.detail ?? "", /as-found curve restored .* — as-found requested/);
  }
  // 6. Rate limit: the restore is exempt (a write landed seconds ago — a 15-min boost's own write is the usual case),
  //    while an ordinary auto-pilot write at the same moment is 429. After the restore nothing is left to rate-limit.
  {
    const h = harness();
    h.expiredBoost(128);
    (h.writer as any).lastWriteAt = Date.now();
    assert.equal(await status(h.writer.setCurve(PLAN_CURVE, "autopilot")), 429, "control: an ordinary write is inside the 15-min window");
    await h.writer.expireBoosts();
    assert.deepEqual(h.patches, [{ ...PLAN_CURVE }], "the expiry restore landed inside the window");
    await h.autopilot.applyLatestPlan();
    assert.doesNotMatch(h.autopilot.lastResult, /rate-limited/, h.autopilot.lastResult);
    assert.match(h.autopilot.lastResult, /already commanded/);
  }
  // 7. A REFUSED plan restore never falls back to the as-found curve: I1 short (409) and a Pi the hub cannot vouch
  //    for (503) both leave the device on the boost's own I4/I1-checked target, the row due, and the next poll — once
  //    the condition clears — lands the plan. (The old path wrote 158 °F here, unverified: the hazard itself.)
  {
    const h = harness({ setpointC: 50 });
    h.expiredBoost(120);
    assert.equal(await status(h.writer.expireBoosts()), 409);
    assert.equal(h.patches.length, 0, "nothing reached the device");
    assert.equal(h.boosts[0].restored, false, "the row stays due — retried next poll");
    assert.equal(h.audits.at(-1)?.result, "rejected"); assert.match(h.audits.at(-1)?.detail ?? "", /I1 conflict/);
    h.state.setpointC = 52; h.state.piConnected = false;
    assert.equal(await status(h.writer.expireBoosts()), 503);
    assert.equal(h.patches.length, 0); assert.equal(h.boosts[0].restored, false);
    h.state.piConnected = true;
    await h.writer.expireBoosts();
    assert.deepEqual(h.patches, [{ ...PLAN_CURVE }]); assert.equal(h.boosts[0].restored, true);
  }
  // 8. The plan read itself failing (DB hiccup) fails CLOSED: no write, no as-found, the row stays due.
  {
    const h = harness();
    h.expiredBoost(128);
    h.state.plansError = new Error("connection terminated");
    await assert.rejects(h.writer.expireBoosts(), /connection terminated/);
    assert.equal(h.patches.length, 0); assert.equal(h.boosts[0].restored, false);
    h.state.plansError = null;
    await h.writer.expireBoosts();
    assert.deepEqual(h.patches, [{ ...PLAN_CURVE }]);
  }
  // 9. yieldToBoost (identification's cleanup) still yields on the plan restore; an expiry restore inside its own
  //    slot sees no active boost (the row is due) and is never a yield.
  {
    const h = harness({ setpointC: 60 });
    assert.equal(await status(h.writer.boost(128, 60, "dashboard")), "ok");
    let err: unknown = null;
    try { await h.writer.restore("identification-end#1", { yieldToBoost: true }); } catch (e) { err = e; }
    assert.ok(isBoostYield(err), `expected a boost yield, got ${String(err)}`);
    assert.equal(h.patches.length, 1, "the restore did not erase the boost");
  }
  // 10. The block in force is evaluated at the moment of the restore, not when the boost started: the plan moved to
  //     a new curve during the boost → the restore lands the NEW curve.
  {
    const h = harness();
    h.expiredBoost(128);
    const newer = { dot: 25, wwsd: 125, dbt: 121, mbt: 116 }; // 120.0 °F at 46 °F: still under the 52 °C setpoints
    h.state.blocks = [{ ...curveBlock, shaped_curve: { ...newer, basis: {} } }];
    await h.writer.expireBoosts();
    assert.deepEqual(h.patches, [newer]);
    await h.autopilot.applyLatestPlan();
    assert.match(h.autopilot.lastResult, /already commanded/);
  }
  console.log("writes-restore.test.ts (#232): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
