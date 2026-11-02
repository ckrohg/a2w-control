/**
 * @purpose Boost hold, writer side (codex pass 1 on the boost hold). (a) HbxWriter serialises every device write, so
 * an auto-pilot write still in flight when the owner taps a boost (or the reverse) cannot ALSO land: the second
 * writer sees the first's lastWriteAt and is refused 429 — before, both passed the rate-limit check and the later
 * PATCH replaced the boost. (b) expireBoosts() retires an overdue row without restoring while a newer boost is active.
 * (c) A rejected write does not poison the chain. (m) #231: a dashboard boost the pump setpoints do not cover is armed
 * (202) — Phase B leads it, the poll loop writes it once covered — while every other refusal stays one; an abandoned
 * boost releases its lead within 20 min. (m8) A dashboard boost inside the 15-min rate-limit window is armed too and
 * written only after the window, one arming row and no rejected row per poll; other callers keep the 429.
 * Plain node:assert under tsx: npx tsx planner/src/writes-boost.test.ts
 */
import assert from "node:assert/strict";
import { HbxWriter, WriteError, isBoostYield, PENDING_BOOST_MAX_MS } from "./writes";
import { AutoPilot } from "./autopilot";
import { PhaseB } from "./phaseb";

type Boost = { targetF: number; restoreAt: Date };
function harness(planTargetF = 126, cfg: Record<string, number> = { dot: 10, wwsd: 65, dbt: 130, mbt: 126 }) {
  const patches: Array<Record<string, number>> = [];
  const audits: Array<{ source: string; action: string; result: string; detail?: string }> = [];
  // #231: what the hub shows for both pumps (60 °C = 140 °F covers every boost here unless a case lowers it)
  const pi = { setpointC: 60, connected: true, tsS: () => Math.floor(Date.now() / 1000) - 10, fail: false };
  let live: Record<string, number> = { ...cfg };
  const boosts: Array<{ id: number; targetF: number; restoreAt: Date; restored: boolean; createdAt?: Date }> = [];
  const apLogs: Array<{ targetF: number | null; reason: string; result: string }> = [];
  const failRetire = { n: 0 }; // retireOpenBoosts throws this many more times
  const insertGate: { p: Promise<void> | null } = { p: null }; // while set, insertBoost waits on it
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
    insertBoost: async (targetF: number, restoreAt: Date) => {
      if (insertGate.p) await insertGate.p;
      for (const b of boosts) b.restored = true;
      const id = boosts.length + 1; boosts.push({ id, targetF, restoreAt, restored: false, createdAt: new Date() }); return id;
    },
    retireBoost: async (id: number) => { for (const b of boosts) if (b.id === id) b.restored = true; },
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
  const hub = { getState: async () => {
    if (pi.fail) throw new Error("ECONNREFUSED");
    return { pi_connected: pi.connected, ts: pi.tsS(), pumps: [{ id: "pump1", name: "P1", online: true, setpoint_c: pi.setpointC }, { id: "pump2", name: "P2", online: true, setpoint_c: pi.setpointC }] };
  } } as any;
  const writer = new HbxWriter(slx, store, hub, "b", "s", async () => {});
  // #231: a fake Phase B lead — records every term the writer publishes
  const lead = { can: true, terms: [] as Array<number | null>, expiries: [] as Array<number | undefined> };
  writer.setBoostLead({ canLead: () => lead.can, set: (t, exp) => { lead.terms.push(t); lead.expiries.push(exp); } });
  const hold = () => { let release!: () => void; gate = new Promise<void>((r) => { release = r; }); return () => { gate = null; release(); }; };
  const autopilot = new AutoPilot(store, writer, false, async () => {});
  return { writer, autopilot, patches, audits, boosts, hold, apLogs, failRetire, failConfig, insertGate, store, slx, hub, pi, lead, live: () => live };
}
/** #231: the July as-found curve (165/145) as the baseline: at 30 °F outdoor the I4 ceiling is the 135 °F cap itself. */
const AS_FOUND = { dot: 10, wwsd: 65, dbt: 165, mbt: 145 };
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
  // (j) codex pass 8: a write slot stuck in a hung DB query (the main pool has no query timeouts) must not block the
  //     restore — it proceeds past RESTORE_QUEUE_WAIT_MS — while ordinary writes keep waiting their turn
  {
    const h = harness();
    (h.writer as any).restoreQueueWaitMs = 30;
    const realLatest = h.store.getLatestSlx;
    let unstick!: () => void; const stuck = new Promise<void>((r) => { unstick = r; });
    h.store.getLatestSlx = async () => { await stuck; return realLatest(); }; // the auto-pilot's envelope read hangs
    const ap = status(h.writer.setTarget(126, "autopilot"));
    await settle();
    h.store.getLatestSlx = realLatest;
    const later = status(h.writer.setTarget(127, "dashboard")); // queued behind the stuck slot
    const rs = await status(h.writer.restore("dashboard"));
    assert.equal(rs, "ok", "the restore ran although an earlier slot never settled");
    assert.deepEqual(h.patches, [{ dbt: 130, mbt: 126, dot: 10 }]);
    let laterDone = false; void later.then(() => { laterDone = true; });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(laterDone, false, "an ordinary write still waits for the stuck slot");
    unstick();
    assert.equal(await ap, 429, "the unstuck write sees the restore's lastWriteAt — it does not land over it");
    assert.equal(await later, 429);
    assert.equal(h.patches.length, 1);
  }
  // (k) codex pass 9: the overtaken write had ALREADY passed its rate-limit check and stalls in the writer-lease query
  //     inside patch(). When it resumes it must not PATCH over the restore that overtook it (re-checked in the lock).
  {
    const h = harness();
    let unstick!: () => void; const stuck = new Promise<void>((r) => { unstick = r; });
    let leaseCalls = 0;
    h.store.holdsWriterLease = async () => { leaseCalls++; if (leaseCalls === 1) await stuck; return true; };
    const w = new HbxWriter(h.slx, h.store, h.hub, "b", "s", async () => {}, false, { instanceId: "a", staleMs: 60_000 });
    (w as any).restoreQueueWaitMs = 30;
    const ap = status(w.setTarget(126, "autopilot"));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(leaseCalls, 1, "the auto-pilot write is past its guards, stuck in the lease query");
    assert.equal(await status(w.restore("dashboard")), "ok");
    assert.deepEqual(h.patches, [{ dbt: 130, mbt: 126, dot: 10 }], "the restore landed");
    unstick();
    assert.equal(await ap, 429, "the stale write is refused inside the device lock");
    assert.equal(h.patches.length, 1, "it never reached the device — the owner's restore stands");
    assert.match(h.audits.at(-1)?.detail ?? "", /^superseded: /);
  }
  // (l) codex pass 10: a boost whose PATCH landed stalls in its ntfy; the owner's dashboard restore overtakes it
  //     (cancelling it). When the boost resumes it must NOT record an open row — no phantom hold on the restored curve.
  {
    const h = harness();
    let unstick!: () => void; let gate: Promise<void> | null = null;
    const w = new HbxWriter(h.slx, h.store, h.hub, "b", "s", async () => { if (gate) await gate; });
    (w as any).restoreQueueWaitMs = 30;
    gate = new Promise<void>((r) => { unstick = r; });
    const bo = w.boost(129, 60, "dashboard");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(h.patches.length, 1, "the boost PATCH landed; its ntfy is stalled");
    gate = null;
    assert.equal(await status(w.restore("dashboard", { endsBoost: true })), "ok");
    unstick();
    const r = await bo;
    assert.equal(r.boost_superseded, true);
    assert.equal(h.boosts.filter((b) => !b.restored).length, 0, "no open boost row after the owner's cancel");
    h.store.recentPlans = async () => [{ plan: [{ ts: new Date(Date.now() - 600_000).toISOString(), tank_target_f: 120, reason: "x" }] }];
    const ap = new AutoPilot(h.store, w, true, async () => {});
    await ap.applyLatestPlan();
    assert.doesNotMatch(ap.lastResult, /boost/, "the auto-pilot is not held");
  }
  // (l2) the restore overtakes while the boost's row INSERT is in flight → the inserted row is retired by id
  {
    const h = harness();
    (h.writer as any).restoreQueueWaitMs = 30;
    let unstick!: () => void; h.insertGate.p = new Promise<void>((r) => { unstick = r; });
    const bo = h.writer.boost(129, 60, "dashboard");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await status(h.writer.restore("dashboard", { endsBoost: true })), "ok"); // its retire finds no row yet
    h.insertGate.p = null; unstick();
    const r = await bo;
    assert.equal(r.boost_superseded, true);
    assert.equal(h.boosts.length, 1); assert.equal(h.boosts[0].restored, true, "the late row is retired");
  }
  // ── #231: a boost above the pump setpoints is ARMED (202), led by Phase B, and written once they cover it ────────
  // (m1) acceptance: 135 °F / 60 min with the setpoints at 52 °C (125.6 °F) → arming; a REAL Phase B leads the pumps to
  //      60 °C on its next cycle; the poll after (the Pi's frame shows them) writes it — one accepted set_target, one
  //      hbx_boosts row; lead.boost_f reads 135 while pending and null after
  {
    const h = harness(126, AS_FOUND);
    h.pi.setpointC = 52;
    const sent: number[] = [];
    const pbStore = { ...h.store, insertPhaseBLog: async () => {}, getRecentSeries: async () => [], getNotifyLatch: async () => null, upsertNotifyLatch: async () => {} };
    const pbHub = { sendSetpoint: async (_p: string, c: number) => { sent.push(c); return { ok: true, detail: "" }; }, getState: h.hub.getState };
    const pb = new PhaseB(pbStore as any, pbHub as any, ["pump1", "pump2"], false, async () => {}, false, async () => true);
    h.writer.setBoostLead({ canLead: () => !pb.isDryRun, set: (t, exp) => pb.setPendingBoost(t, exp) });
    const r = await h.writer.boost(135, 60, "dashboard", undefined, { armIfLow: true });
    assert.equal(r.arming, true); assert.equal(r.setpoints_needed_f, 140); assert.equal(r.target_f, 135);
    assert.equal(h.patches.length, 0, "nothing written while arming");
    assert.equal(h.boosts.length, 0, "no boost row while arming");
    assert.equal(pb.pendingBoostF, 135, "Phase B carries the boost term");
    const st = await h.writer.status() as any;
    assert.equal(st.pending_boost?.target_f, 135); assert.equal(st.pending_boost?.setpoints_needed_f, 140);
    assert.equal(h.audits.at(-1)?.action, "boost"); assert.equal(h.audits.at(-1)?.result, "arming");
    // poll 1: Phase B sends 60 °C; the hub still shows the Pi's previous frame → not written yet
    await pb.runOnce();
    assert.deepEqual(sent, [60, 60], "135 + 5 = 140 °F → 60 °C");
    assert.equal(pb.lastLead?.boost_f, 135);
    await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 0, "the hub does not show the raised setpoints yet");
    // the Pi pushes its next frame; poll 2: the retry sees every online pump ≥ 140 °F and writes
    h.pi.setpointC = 60;
    await pb.runOnce();
    await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 1, "the boost landed");
    assert.equal(h.audits.filter((a) => a.action === "set_target" && a.result === "accepted").length, 1, "audited as ONE set_target");
    assert.equal(h.audits.filter((a) => a.result === "rejected").length, 0, "no rejected attempts on the way");
    assert.equal(h.boosts.length, 1, "ONE hbx_boosts row"); assert.equal(h.boosts[0].targetF, 135);
    assert.ok(Math.abs(h.boosts[0].restoreAt.getTime() - (Date.now() + 60 * 60_000)) < 5_000, "the 60-min timer runs from the write");
    assert.equal(pb.pendingBoostF, null, "the term is cleared once the boost is written");
    const st2 = await h.writer.status() as any;
    assert.equal(st2.pending_boost, null); assert.equal(st2.pending_boost_ended?.outcome, "landed");
    assert.equal(st2.active_boost?.target_f, 135);
    await pb.runOnce();
    assert.equal(pb.lastLead?.boost_f, null);
  }
  // (m2) a boost the setpoints already cover writes at once — no arming, no Phase B term (no behaviour change)
  {
    const h = harness(126, AS_FOUND);
    const r = await h.writer.boost(135, 60, "dashboard", undefined, { armIfLow: true });
    assert.equal(r.arming, undefined); assert.equal(r.ok, true); assert.ok(typeof r.boost_restore_at === "string");
    assert.equal(h.patches.length, 1); assert.equal(h.boosts.length, 1);
    assert.deepEqual(h.lead.terms, [], "Phase B never asked to lead");
  }
  // (m3) every OTHER refusal is still a refusal — same status as before, nothing pending, no Phase B term
  {
    const cases: Array<[string, (h: ReturnType<typeof harness>) => void, number, number]> = [
      ["above the 135 °F cap", () => {}, 136, 422],
      ["below the I4 floor", () => {}, 100, 422],
      ["Pi disconnected", (h) => { h.pi.connected = false; }, 135, 503],
      ["Pi frame stale", (h) => { h.pi.tsS = () => Math.floor(Date.now() / 1000) - 3600; }, 135, 503],
      ["hub unreachable", (h) => { h.pi.fail = true; }, 135, 503],
      ["Phase B in dry-run cannot lead (409 as today)", (h) => { h.lead.can = false; }, 135, 409],
      ["writer lease not held (409 as today)", (h) => {
        h.store.holdsWriterLease = async () => false;
        const w = new HbxWriter(h.slx, h.store, h.hub, "b", "s", async () => {}, false, { instanceId: "a", staleMs: 60_000 });
        w.setBoostLead({ canLead: () => true, set: (t) => { h.lead.terms.push(t); } });
        h.writer = w;
      }, 135, 409],
    ];
    for (const [name, setup, target, want] of cases) {
      const h = harness(126, AS_FOUND);
      h.pi.setpointC = 52;
      setup(h);
      assert.equal(await status(h.writer.boost(target, 60, "dashboard", undefined, { armIfLow: true })), want, name);
      assert.equal((await h.writer.status() as any).pending_boost, null, `${name}: nothing pending`);
      assert.deepEqual(h.lead.terms, [], `${name}: Phase B not asked to lead`);
      assert.equal(h.patches.length, 0); assert.equal(h.boosts.length, 0);
      assert.equal(h.audits.at(-1)?.result, "rejected", `${name}: audited as a rejection, as before`);
    }
    // without armIfLow (the rehearsal script, any non-dashboard caller) the short-setpoint boost is the old 409
    const h = harness(126, AS_FOUND);
    h.pi.setpointC = 52;
    assert.equal(await status(h.writer.boost(135, 60, "dashboard")), 409);
    assert.deepEqual(h.lead.terms, []);
  }
  // (m4) an abandoned boost releases within the 20-min bound: the setpoints never rise; past PENDING_BOOST_MAX_MS the
  //      retry drops it, releases the Phase B term and audits "expired" — and Phase B's own bound releases it anyway
  {
    const h = harness(126, AS_FOUND);
    h.pi.setpointC = 52;
    const pb = new PhaseB({} as any, {} as any, ["pump1"], false, async () => {});
    h.writer.setBoostLead({ canLead: () => true, set: (t, exp) => pb.setPendingBoost(t, exp) });
    const r = await h.writer.boost(135, 60, "dashboard", undefined, { armIfLow: true });
    assert.equal(r.arming, true);
    assert.ok(Date.parse(String(r.expires_at)) - Date.now() <= PENDING_BOOST_MAX_MS);
    await h.writer.retryPendingBoost();
    assert.equal(pb.pendingBoostF, 135, "still arming inside the bound");
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + PENDING_BOOST_MAX_MS + 1000;
      assert.equal(pb.pendingBoostF, null, "Phase B's own bound releases the term with nobody clearing it");
      pb.setPendingBoost(135, realNow() + 60_000); // re-published (as if the writer had not noticed yet)
      await h.writer.retryPendingBoost();
      assert.equal(pb.pendingBoostF, null, "the writer's retry releases it");
      const st = await h.writer.status() as any;
      assert.equal(st.pending_boost, null); assert.equal(st.pending_boost_ended?.outcome, "expired");
    } finally { Date.now = realNow; }
    assert.equal(h.audits.at(-1)?.result, "expired"); assert.equal(h.audits.at(-1)?.action, "boost");
    h.pi.setpointC = 60;
    await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 0, "an expired boost is never written late");
    assert.equal(h.boosts.length, 0);
  }
  // (m5) the owner's restore (endsBoost) while a boost is arming cancels it — the term is released, nothing lands later
  {
    const h = harness(126, AS_FOUND);
    h.pi.setpointC = 52;
    assert.equal((await h.writer.boost(135, 60, "dashboard", undefined, { armIfLow: true })).arming, true);
    assert.equal(await status(h.writer.restore("dashboard", { endsBoost: true })), "ok");
    assert.equal(h.lead.terms.at(-1), null, "Phase B's term released");
    h.pi.setpointC = 60;
    await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 1, "only the restore reached the device");
    assert.equal(h.boosts.length, 0);
    // a new boost request replaces an armed one
    const k = harness(126, AS_FOUND);
    k.pi.setpointC = 52;
    await k.writer.boost(135, 60, "dashboard", undefined, { armIfLow: true });
    await k.writer.boost(134, 30, "dashboard", undefined, { armIfLow: true });
    assert.deepEqual(k.lead.terms, [135, null, 134]);
    assert.equal((await k.writer.status() as any).pending_boost?.target_f, 134);
  }
  // (m6) a transient refusal at the retry keeps it pending: the auto-pilot wrote while it was arming (rate limit) — the
  //      boost is not dropped, and lands once the window has passed (still inside the 20-min bound)
  {
    const h = harness(126, AS_FOUND);
    h.pi.setpointC = 55; // 131 °F: covers the auto-pilot's 126, short of the boost's 140
    assert.equal((await h.writer.boost(135, 60, "dashboard", undefined, { armIfLow: true })).arming, true);
    assert.equal(await status(h.writer.setTarget(126, "autopilot")), "ok");
    h.pi.setpointC = 60;
    await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 1, "rate-limited: not written yet");
    assert.equal((await h.writer.status() as any).pending_boost?.target_f, 135, "still pending");
    (h.writer as any).lastWriteAt = 0; // the 15-min window passes
    await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 2); assert.equal(h.boosts.length, 1);
  }
  // (m7) identification-arming parity (identify.ts continueArming, #167): high setpoints in a frozen frame from a
  //      dropped Pi are NOT coverage — the retry waits; an envelope that moved under the boost drops it (not transient)
  {
    const h = harness(126, AS_FOUND);
    h.pi.setpointC = 52;
    await h.writer.boost(135, 60, "dashboard", undefined, { armIfLow: true });
    h.pi.setpointC = 60; h.pi.connected = false;
    await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 0, "a disconnected Pi's last frame does not count");
    assert.equal((await h.writer.status() as any).pending_boost?.target_f, 135);
    h.pi.connected = true;
    h.store.baselineConfig = async () => ({ dot: 10, wwsd: 65, dbt: 130, mbt: 126 }); // the I4 ceiling drops under 135
    h.store.latestConfig = async () => ({ dot: 10, wwsd: 65, dbt: 130, mbt: 126 });
    await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 0);
    const st = await h.writer.status() as any;
    assert.equal(st.pending_boost, null); assert.equal(st.pending_boost_ended?.outcome, "refused");
    assert.equal(h.lead.terms.at(-1), null);
  }
  // ── #231 follow-up (owner, 2026-11-02): a dashboard boost inside the 15-min window WAITS, then starts ────────────
  // A clock the cases can move: Date.now() is the writer's (and the harness's) only clock.
  const realNow = Date.now;
  const at = (offsetMs: number) => { Date.now = () => realNow() + offsetMs; };
  const rejectedSetTargets = (h: ReturnType<typeof harness>) => h.audits.filter((a) => a.action === "set_target" && a.result === "rejected").length;
  // (m8a) setpoints already covering it: the auto-pilot wrote a moment ago → 202 rate_limit, nothing written in the
  //       window (several polls), no rejected row per poll, written on the first poll after it — inside the 20-min term
  try {
    const h = harness(126, AS_FOUND);
    assert.equal(await status(h.writer.setTarget(126, "autopilot")), "ok");
    const r = await h.writer.boost(135, 60, "dashboard", undefined, { armIfLow: true });
    assert.equal(r.arming, true); assert.equal(r.reason, "rate_limit"); assert.equal(r.setpoints_needed_f, 140);
    assert.ok(typeof r.expires_at === "string" && typeof r.detail === "string");
    assert.match(String(r.detail), /rate limited/);
    assert.equal(Date.parse(String(r.expires_at)) - Date.now() <= PENDING_BOOST_MAX_MS, true, "the term is the usual 20 min");
    assert.deepEqual(h.lead.terms, [135], "Phase B holds the setpoints on the boost while it waits");
    const st = await h.writer.status() as any;
    assert.equal(st.pending_boost?.reason, "rate_limit"); assert.equal(st.pending_boost?.setpoints_needed_f, 140);
    for (const m of [1, 5, 10, 14.9]) { at(m * 60_000); await h.writer.retryPendingBoost(); }
    assert.equal(h.patches.length, 1, "no device write inside the window — only the auto-pilot's");
    assert.equal(rejectedSetTargets(h), 0, "no rejected set_target row per poll while the window holds");
    assert.equal(h.audits.filter((a) => a.action === "boost" && a.result === "arming").length, 1, "ONE arming row");
    at(15 * 60_000 + 1000);
    await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 2, "written once the window has passed");
    assert.equal(h.boosts.length, 1); assert.equal(h.boosts[0].targetF, 135);
    assert.ok(Math.abs(h.boosts[0].restoreAt.getTime() - (Date.now() + 60 * 60_000)) < 5_000, "the 60-min timer runs from the write");
    const st2 = await h.writer.status() as any;
    assert.equal(st2.pending_boost, null); assert.equal(st2.pending_boost_ended?.outcome, "landed");
    assert.equal(h.lead.terms.at(-1), null, "the lead is released");
    assert.equal(rejectedSetTargets(h), 0);
  } finally { Date.now = realNow; }
  // (m8b) setpoints short AND inside the window: armed at I1 (reason setpoints); Phase B covers them while the window
  //       still holds → no write, no rejected row, the reason now reads rate_limit; written after the window
  try {
    const h = harness(126, AS_FOUND);
    h.pi.setpointC = 55; // 131 °F: covers the auto-pilot's 126, short of the boost's 140
    assert.equal(await status(h.writer.setTarget(126, "autopilot")), "ok");
    const r = await h.writer.boost(135, 60, "dashboard", undefined, { armIfLow: true });
    assert.equal(r.arming, true); assert.equal(r.reason, "setpoints"); assert.equal(r.setpoints_needed_f, 140);
    at(5 * 60_000); await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 1, "setpoints still short");
    h.pi.setpointC = 60;
    at(10 * 60_000); await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 1, "covered, but still inside the window: not written");
    assert.equal((await h.writer.status() as any).pending_boost?.reason, "rate_limit", "the dashboard now says what it waits for");
    assert.equal(rejectedSetTargets(h), 0);
    at(15 * 60_000 + 1000); await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 2); assert.equal(h.boosts.length, 1);
    assert.equal(rejectedSetTargets(h), 0);
  } finally { Date.now = realNow; }
  // (m8c) the term still expires at PENDING_BOOST_MAX_MS: a rate-limited boost whose polls never got to write it is
  //       dropped, its lead released, "expired" audited, and never written late
  try {
    const h = harness(126, AS_FOUND);
    assert.equal(await status(h.writer.setTarget(126, "autopilot")), "ok");
    assert.equal((await h.writer.boost(135, 60, "dashboard", undefined, { armIfLow: true })).reason, "rate_limit");
    at(PENDING_BOOST_MAX_MS + 1000);
    await h.writer.retryPendingBoost();
    const st = await h.writer.status() as any;
    assert.equal(st.pending_boost, null); assert.equal(st.pending_boost_ended?.outcome, "expired");
    assert.equal(h.lead.terms.at(-1), null);
    assert.equal(h.audits.at(-1)?.result, "expired");
    await h.writer.retryPendingBoost();
    assert.equal(h.patches.length, 1, "only the auto-pilot's write"); assert.equal(h.boosts.length, 0);
  } finally { Date.now = realNow; }
  // (m8d) callers without armIfLow keep today's 429; a boost that cannot arm (Phase B dry-run, lease not held) is the
  //       429 too — audited as a rejection, nothing pending, no lead term
  {
    const cases: Array<[string, (h: ReturnType<typeof harness>) => void, { armIfLow?: boolean }]> = [
      ["no armIfLow (rehearsal / any other caller)", () => {}, {}],
      ["Phase B in dry-run cannot lead", (h) => { h.lead.can = false; }, { armIfLow: true }],
      ["writer lease not held", (h) => {
        let lease = true;
        h.store.holdsWriterLease = async () => lease;
        const w = new HbxWriter(h.slx, h.store, h.hub, "b", "s", async () => {}, false, { instanceId: "a", staleMs: 60_000 });
        w.setBoostLead({ canLead: () => true, set: (t) => { h.lead.terms.push(t); } });
        h.writer = w;
        (h as any).dropLease = () => { lease = false; };
      }, { armIfLow: true }],
    ];
    for (const [name, setup, opts] of cases) {
      const h = harness(126, AS_FOUND);
      setup(h);
      assert.equal(await status(h.writer.setTarget(126, "autopilot")), "ok", `${name}: the earlier write`);
      (h as any).dropLease?.();
      assert.equal(await status(h.writer.boost(135, 60, "dashboard", undefined, opts)), 429, name);
      assert.equal((await h.writer.status() as any).pending_boost, null, `${name}: nothing pending`);
      assert.deepEqual(h.lead.terms, [], `${name}: Phase B not asked to lead`);
      assert.equal(h.patches.length, 1); assert.equal(h.boosts.length, 0);
      assert.equal(h.audits.at(-1)?.result, "rejected"); assert.match(h.audits.at(-1)?.detail ?? "", /^rate limited/);
    }
    // and the auto-pilot itself is still refused 429 inside a window
    const h = harness(126, AS_FOUND);
    assert.equal(await status(h.writer.setTarget(126, "autopilot")), "ok");
    assert.equal(await status(h.writer.setTarget(127, "autopilot")), 429);
  }
  console.log("writes-boost.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
