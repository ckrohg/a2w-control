/**
 * @purpose Boost hold, writer side (codex pass 1 on the boost hold). (a) HbxWriter serialises every device write, so
 * an auto-pilot write still in flight when the owner taps a boost (or the reverse) cannot ALSO land: the second
 * writer sees the first's lastWriteAt and is refused 429 — before, both passed the rate-limit check and the later
 * PATCH replaced the boost. (b) expireBoosts() retires an overdue row without restoring while a newer boost is active.
 * (c) A rejected write does not poison the chain. Plain node:assert under tsx: npx tsx planner/src/writes-boost.test.ts
 */
import assert from "node:assert/strict";
import { HbxWriter, WriteError, isBoostYield } from "./writes";
import { AutoPilot } from "./autopilot";

type Boost = { targetF: number; restoreAt: Date };
function harness(planTargetF = 126) {
  const patches: Array<Record<string, number>> = [];
  const audits: Array<{ source: string; action: string; result: string }> = [];
  const cfg = { dot: 10, wwsd: 65, dbt: 130, mbt: 126 };
  let live: Record<string, number> = { ...cfg };
  const boosts: Array<{ id: number; targetF: number; restoreAt: Date; restored: boolean; createdAt?: Date }> = [];
  const apLogs: Array<{ targetF: number | null; reason: string; result: string }> = [];
  const failRetire = { n: 0 }; // retireOpenBoosts throws this many more times
  const failConfig = { n: 0 }; // patch()'s post-PATCH accepted-write audit insert throws this many more times
  let gate: Promise<void> | null = null; // while set, patchDevice waits on it (an in-flight PATCH)
  const store = {
    getLatestSlx: async () => ({ ts: new Date(), tankF: 120, targetF: 128, outdoorF: 30 }),
    latestConfig: async () => ({ ...live }),
    baselineConfig: async () => ({ ...cfg }),
    insertHbxWrite: async (w: { source: string; action: string; result: string }) => {
      if (w.result === "accepted" && failConfig.n > 0) { failConfig.n--; throw new Error("connection terminated"); }
      audits.push(w);
    },
    insertConfigVersion: async () => {},
    // the real insertBoost retires every open row in the same statement (store.ts; checked on PGlite)
    insertBoost: async (targetF: number, restoreAt: Date) => { for (const b of boosts) b.restored = true; boosts.push({ id: boosts.length + 1, targetF, restoreAt, restored: false, createdAt: new Date() }); },
    activeBoost: async (): Promise<Boost | null> => { const b = boosts.filter((x) => !x.restored && x.restoreAt.getTime() > Date.now()).at(-1); return b ? { targetF: b.targetF, restoreAt: b.restoreAt } : null; },
    dueBoosts: async () => boosts.filter((x) => !x.restored && x.restoreAt.getTime() <= Date.now()).map((x) => ({ id: x.id, targetF: x.targetF })),
    markBoostsRestored: async (ids: number[]) => { for (const b of boosts) if (ids.includes(b.id)) b.restored = true; },
    retireOpenBoosts: async (before: Date) => {
      if (failRetire.n > 0) { failRetire.n--; throw new Error("connection terminated"); }
      for (const b of boosts) if ((b.createdAt ?? new Date(0)).getTime() <= before.getTime()) b.restored = true;
    },
    // for an AutoPilot over this REAL writer
    recentPlans: async () => [{ plan: [{ ts: new Date(Date.now() - 600_000).toISOString(), tank_target_f: planTargetF, reason: "DHW window floor" }] }],
    insertAutopilotLog: async (l: { targetF: number | null; reason: string; result: string }) => { apLogs.push(l); },
  } as any;
  const slx = { patchDevice: async (_b: string, _s: string, fields: Record<string, number>) => {
    if (gate) await gate;
    patches.push(fields); live = { ...live, ...fields };
    return { syncCode: "x", ...live, temps: { temp1: { actual: 120, target: 128 }, temp3: { actual: 30 } } };
  } } as any;
  const hub = { getState: async () => ({ pi_connected: true, ts: Math.floor(Date.now() / 1000) - 10, pumps: [{ id: "pump1", name: "P1", online: true, setpoint_c: 60 }] }) } as any;
  const writer = new HbxWriter(slx, store, hub, "b", "s", async () => {});
  const hold = () => { let release!: () => void; gate = new Promise<void>((r) => { release = r; }); return () => { gate = null; release(); }; };
  const autopilot = new AutoPilot(store, writer, false, async () => {});
  return { writer, autopilot, patches, audits, boosts, hold, apLogs, failRetire, failConfig, store, slx, hub, live: () => live };
}
const settle = () => new Promise((r) => setImmediate(r));
async function status(p: Promise<unknown>): Promise<number | "ok"> {
  try { await p; return "ok"; } catch (e) { if (e instanceof WriteError) return e.status; throw e; }
}

(async () => {
  // (a1) the auto-pilot's PATCH is in flight; the owner taps a boost → the boost waits its turn, then is refused 429.
  //      Exactly ONE device write lands, and no hbx_boosts row claims a boost the device never got.
  {
    const h = harness();
    const release = h.hold();
    const ap = status(h.writer.setTarget(126, "autopilot"));
    await settle();
    const bo = status(h.writer.boost(129, 60, "dashboard"));
    await settle();
    assert.equal(h.patches.length, 0, "the auto-pilot PATCH is still on the wire");
    release();
    assert.equal(await ap, "ok");
    assert.equal(await bo, 429, "the boost sees the auto-pilot's write and is rate-limited — it does not land on top");
    assert.equal(h.patches.length, 1);
    assert.equal(h.boosts.length, 0, "no boost row for a refused boost");
  }
  // (a2) the reverse: the boost's PATCH is in flight; the auto-pilot write waits and is refused 429 — the boost stands
  {
    const h = harness();
    const release = h.hold();
    const bo = status(h.writer.boost(129, 60, "dashboard"));
    await settle();
    const ap = status(h.writer.setTarget(126, "autopilot"));
    const cv = status(h.writer.setCurve({ dot: 10, wwsd: 65, dbt: 131, mbt: 126 }, "autopilot"));
    await settle();
    release();
    assert.equal(await bo, "ok");
    assert.equal(await ap, 429); assert.equal(await cv, 429);
    assert.equal(h.patches.length, 1, "only the boost reached the device");
    assert.equal(h.boosts.length, 1, "the boost row is written inside the same serial slot as its write");
  }
  // (a3) a restore queued behind an in-flight write runs after it (never refused: restore is exempt from the rate limit)
  {
    const h = harness();
    const release = h.hold();
    const ap = status(h.writer.setTarget(126, "autopilot"));
    const rs = status(h.writer.restore("dashboard"));
    await settle(); release();
    assert.equal(await ap, "ok"); assert.equal(await rs, "ok");
    assert.equal(h.patches.length, 2); assert.deepEqual(h.patches[1], { dbt: 130, mbt: 126, dot: 10 }, "the restore is the LAST write");
  }
  // (c) a rejected write does not poison the chain: the next write runs normally
  {
    const h = harness();
    assert.equal(await status(h.writer.setTarget(Number.NaN, "x")), 422);
    assert.equal(await status(h.writer.boost(128, 5, "dashboard")), 422, "minutes outside 15–120 still rejected");
    assert.equal(await status(h.writer.setTarget(126, "autopilot")), "ok");
  }
  // (b1) a due boost with nothing newer → restore, row marked
  {
    const h = harness();
    h.boosts.push({ id: 1, targetF: 129, restoreAt: new Date(Date.now() - 60_000), restored: false });
    await h.writer.expireBoosts();
    assert.equal(h.patches.length, 1); assert.deepEqual(h.patches[0], { dbt: 130, mbt: 126, dot: 10 });
    assert.equal(h.boosts[0].restored, true);
  }
  // (b2) an OVERDUE row while a newer boost is active → retired without a restore (the active boost stays in force)
  {
    const h = harness();
    h.boosts.push({ id: 1, targetF: 125, restoreAt: new Date(Date.now() - 3600_000), restored: false });
    h.boosts.push({ id: 2, targetF: 129, restoreAt: new Date(Date.now() + 3600_000), restored: false });
    await h.writer.expireBoosts();
    assert.equal(h.patches.length, 0, "no restore over the active boost");
    assert.equal(h.boosts[0].restored, true, "the overdue row is retired");
    assert.equal(h.boosts[1].restored, false, "the active boost keeps its own expiry");
  }
  // (b3) a new boost supersedes an older open one: when the newer (shorter) one is due, its expiry restores — the
  //      older row no longer reads as active and cannot keep the auto-pilot held
  {
    const h = harness();
    assert.equal(await status(h.writer.boost(129, 120, "dashboard")), "ok");
    h.boosts[0].restoreAt = new Date(Date.now() + 2 * 3600_000);
    // a second boost is a fresh write slot later: fake the elapsed rate-limit window
    (h.writer as any).lastWriteAt = 0;
    assert.equal(await status(h.writer.boost(128, 15, "dashboard")), "ok");
    assert.equal(h.boosts[0].restored, true, "the older boost row is retired by the newer one");
    h.boosts[1].restoreAt = new Date(Date.now() - 1000); // the 15-min boost runs out
    await h.writer.expireBoosts();
    assert.equal(h.patches.length, 3, "two boosts + the restore");
    assert.deepEqual(h.patches[2], { dbt: 130, mbt: 126, dot: 10 });
  }
  // (d1) yieldToBoost (codex pass 2): an automatic restore — exempt from the rate limit — refuses while a boost is active
  {
    const h = harness();
    assert.equal(await status(h.writer.boost(129, 60, "dashboard")), "ok");
    let err: unknown = null;
    try { await h.writer.restore("identification-abort#1", { yieldToBoost: true }); } catch (e) { err = e; }
    assert.ok(isBoostYield(err), `expected a boost yield, got ${String(err)}`);
    assert.equal(h.patches.length, 1, "the restore did not erase the boost");
    assert.equal(h.audits.at(-1)?.result, "rejected"); assert.equal(h.audits.at(-1)?.action, "restore");
    assert.equal(await status(h.writer.restore("dashboard")), "ok", "without the option a restore still always runs");
  }
  // (d2) a write QUEUED behind a boost's in-flight PATCH sees the boost row inside its own slot and yields (not 429)
  {
    const h = harness();
    const release = h.hold();
    const bo = status(h.writer.boost(129, 60, "dashboard"));
    await settle();
    const rs = h.writer.restore("identification-end#1", { yieldToBoost: true }).then(() => "ok", (e) => e);
    await settle(); release();
    assert.equal(await bo, "ok");
    assert.ok(isBoostYield(await rs), "the queued restore yields to the boost that landed ahead of it");
    assert.equal(h.patches.length, 1);
  }
  // (e1) REAL writer + auto-pilot: a boost holds the auto-pilot; the owner's dashboard restore (endsBoost) cancels the
  //      boost, so the auto-pilot is no longer held for a boost that is gone
  {
    const h = harness();
    assert.equal(await status(h.writer.boost(129, 120, "dashboard")), "ok");
    (h.writer as any).lastWriteAt = 0; // past the 15-min window
    await h.autopilot.applyLatestPlan();
    assert.match(h.autopilot.lastResult, /^held for boost to 129°F/); assert.equal(h.patches.length, 1);
    assert.equal(await status(h.writer.restore("dashboard", { endsBoost: true })), "ok");
    assert.ok(h.boosts.every((b) => b.restored), "the dashboard restore retired the boost row");
    (h.writer as any).lastWriteAt = 0;
    await h.autopilot.applyLatestPlan();
    assert.doesNotMatch(h.autopilot.lastResult, /boost/, "no phantom boost hold");
    assert.match(h.autopilot.lastResult, /already commanded/, "back on its own decision (the restored curve's 128 °F is within tolerance of 126)");
  }
  // (e2) a dashboard set-target (endsBoost) replaces the boost too; a REJECTED one leaves the boost standing
  {
    const h = harness();
    assert.equal(await status(h.writer.boost(129, 120, "dashboard")), "ok");
    assert.equal(await status(h.writer.setTarget(127, "dashboard", undefined, { endsBoost: true })), 429, "inside 15 min: refused");
    assert.ok(h.boosts.every((b) => !b.restored), "a refused human write does not cancel the boost");
    (h.writer as any).lastWriteAt = 0;
    assert.equal(await status(h.writer.setTarget(127, "dashboard", undefined, { endsBoost: true })), "ok");
    assert.ok(h.boosts.every((b) => b.restored), "an accepted one does");
  }
  // (e3) REAL writer + auto-pilot: the auto-pilot passed its boost check, then a boost landed ahead of its write in the
  //      queue → the in-slot re-check yields and the decision is a HOLD, not a rejection. (Plan 120 °F: far enough
  //      from the commanded 128 that the auto-pilot does try to write; the yield is checked before the envelope.)
  {
    const h = harness(120);
    const release = h.hold();
    const bo = status(h.writer.boost(129, 60, "dashboard"));
    await settle();
    const ap = h.autopilot.applyLatestPlan();
    await settle(); await settle(); release();
    assert.equal(await bo, "ok"); await ap;
    // recorded exactly like the pre-check's hold (codex pass 3): the BOOST's target holds the plant, the plan's is in the reason
    assert.match(h.autopilot.lastResult, /^held for boost to 129°F until .* — plan wants 120°F, not applied$/, `got: ${h.autopilot.lastResult}`);
    assert.equal(h.autopilot.lastTargetF, 129);
    const row = h.apLogs.at(-1)!;
    assert.equal(row.result, "held"); assert.equal(row.targetF, 129);
    assert.match(row.reason, /^boost 129°F until .* — plan wants 120°F \(DHW window floor\), resumes after$/);
    assert.equal(h.patches.length, 1, "only the boost reached the device");
  }
  // (f) the dashboard cancel lands but retiring the boost row fails ONCE (codex pass 3): the response and status() say
  //     so, the expiry restore is held while the row is stale, and the next slot / poll retires it
  {
    const h = harness();
    assert.equal(await status(h.writer.boost(129, 60, "dashboard")), "ok");
    (h.writer as any).lastWriteAt = 0;
    h.failRetire.n = 2; // the cancel's retire AND the first retry fail
    const r = await h.writer.setTarget(127, "dashboard", undefined, { endsBoost: true });
    assert.equal(r.boost_retire_failed, true, "the response says the cancel is incomplete");
    assert.equal((await h.writer.status()).boost_cancel_pending, true, "…and so does the writer status the dashboard reads");
    h.boosts[0].restoreAt = new Date(Date.now() - 1000); // the stale boost's timer runs out while the DB is still failing
    await h.writer.expireBoosts();
    assert.equal(h.patches.length, 2, "NO expiry restore over the owner's 127 °F while the row is stale");
    await h.writer.expireBoosts(); // the DB is back: the retry succeeds
    assert.equal((await h.writer.status()).boost_cancel_pending, false);
    assert.ok(h.boosts.every((b) => b.restored), "the stale row is retired");
    assert.equal(h.patches.length, 2, "and it is retired, not restored — the owner's command stands");
  }
  // (f2) a NEW boost while a cancel is still pending retires the stale row itself and is the only active one
  {
    const h = harness();
    assert.equal(await status(h.writer.boost(129, 60, "dashboard")), "ok");
    (h.writer as any).lastWriteAt = 0; h.failRetire.n = 2;
    await h.writer.restore("dashboard", { endsBoost: true });
    (h.writer as any).lastWriteAt = 0;
    assert.equal(await status(h.writer.boost(128, 30, "dashboard")), "ok");
    assert.equal((await h.writer.status()).boost_cancel_pending, false);
    assert.deepEqual(h.boosts.map((b) => b.restored), [true, false], "only the new boost is open");
  }
  // (g) the dashboard cancel's PATCH lands but patch()'s bookkeeping throws AFTER it (codex pass 4): the error still
  //     reaches the caller, and the boost is retired anyway — the device took the owner's command
  {
    const h = harness();
    assert.equal(await status(h.writer.boost(129, 60, "dashboard")), "ok");
    (h.writer as any).lastWriteAt = 0;
    h.failConfig.n = 1;
    let err: unknown = null;
    try { await h.writer.restore("dashboard", { endsBoost: true }); } catch (e) { err = e; }
    assert.match(String(err), /connection terminated/, "the bookkeeping failure is not hidden");
    assert.equal(h.patches.length, 2, "the restore reached the device");
    assert.ok(h.boosts.every((b) => b.restored), "…so the cancelled boost is retired");
    // a human write refused BEFORE the device (rate limit) still leaves the boost alone
    const k = harness();
    assert.equal(await status(k.writer.boost(129, 60, "dashboard")), "ok");
    assert.equal(await status(k.writer.setTarget(127, "dashboard", undefined, { endsBoost: true })), 429);
    assert.ok(k.boosts.every((b) => !b.restored));
  }
  // (h) codex pass 5: planner A's cancel retire fails; planner B (sharing the DB) starts a NEW boost afterwards. A's
  //     delayed retry retires only rows created before A's cancel landed — B's boost stays active.
  {
    const a = harness();
    assert.equal(await status(a.writer.boost(129, 60, "dashboard")), "ok");
    (a.writer as any).lastWriteAt = 0; a.failRetire.n = 1;
    const r = await a.writer.restore("dashboard", { endsBoost: true });
    assert.equal(r.boost_retire_failed, true);
    await new Promise((res) => setTimeout(res, 5)); // B's boost is strictly later than A's cancel
    const b = new HbxWriter(a.slx, a.store, a.hub, "b", "s", async () => {});
    assert.equal(await status(b.boost(128, 60, "dashboard")), "ok"); // B's insertBoost retires A's stale row too
    a.boosts.push({ id: 99, targetF: 127, restoreAt: new Date(Date.now() + 3600_000), restored: false, createdAt: new Date() }); // and another, later
    await a.writer.expireBoosts(); // A's retry runs
    assert.equal((await a.writer.status()).boost_cancel_pending, false);
    assert.equal(a.boosts[0].restored, true, "A's cancelled boost is retired");
    assert.deepEqual(a.boosts.slice(1).map((x) => x.restored), [false, false], "the boosts started after A's cancel are untouched");
  }
  // (i) codex pass 6: the cutoff is when the cancel's PATCH LANDED, not when patch() returned. A's post-PATCH ntfy
  //     stalls; B starts a boost in that gap; A's retire must leave B's row open.
  {
    const a = harness();
    let releaseNotify!: () => void; let notifyGate: Promise<void> | null = null;
    const slow = new HbxWriter(a.slx, a.store, a.hub, "b", "s", async () => { if (notifyGate) await notifyGate; });
    assert.equal(await status(slow.boost(129, 60, "dashboard")), "ok");
    (slow as any).lastWriteAt = 0;
    notifyGate = new Promise<void>((r) => { releaseNotify = r; });
    const cancel = slow.restore("dashboard", { endsBoost: true });
    await new Promise((res) => setTimeout(res, 5)); // A's PATCH has landed; its ntfy is stalled
    assert.equal(a.patches.length, 2);
    const b = new HbxWriter(a.slx, a.store, a.hub, "b", "s", async () => {});
    assert.equal(await status(b.boost(128, 60, "dashboard")), "ok");
    releaseNotify(); await cancel;
    assert.equal(a.boosts[0].restored, true, "A's cancelled boost is retired");
    assert.equal(a.boosts[1].restored, false, "B's boost, started after A's PATCH landed, stays active");
  }
  console.log("writes-boost.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
