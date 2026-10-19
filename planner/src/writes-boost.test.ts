/**
 * @purpose Boost hold, writer side (codex pass 1 on the boost hold). (a) HbxWriter serialises every device write, so
 * an auto-pilot write still in flight when the owner taps a boost (or the reverse) cannot ALSO land: the second
 * writer sees the first's lastWriteAt and is refused 429 — before, both passed the rate-limit check and the later
 * PATCH replaced the boost. (b) expireBoosts() retires an overdue row without restoring while a newer boost is active.
 * (c) A rejected write does not poison the chain. Plain node:assert under tsx: npx tsx planner/src/writes-boost.test.ts
 */
import assert from "node:assert/strict";
import { HbxWriter, WriteError } from "./writes";

type Boost = { targetF: number; restoreAt: Date };
function harness() {
  const patches: Array<Record<string, number>> = [];
  const audits: Array<{ source: string; action: string; result: string }> = [];
  const cfg = { dot: 10, wwsd: 65, dbt: 130, mbt: 126 };
  let live: Record<string, number> = { ...cfg };
  const boosts: Array<{ id: number; targetF: number; restoreAt: Date; restored: boolean }> = [];
  let gate: Promise<void> | null = null; // while set, patchDevice waits on it (an in-flight PATCH)
  const store = {
    getLatestSlx: async () => ({ ts: new Date(), tankF: 120, targetF: 128, outdoorF: 30 }),
    latestConfig: async () => ({ ...live }),
    baselineConfig: async () => ({ ...cfg }),
    insertHbxWrite: async (w: { source: string; action: string; result: string }) => { audits.push(w); },
    insertConfigVersion: async () => {},
    // the real insertBoost retires every open row in the same statement (store.ts; checked on PGlite)
    insertBoost: async (targetF: number, restoreAt: Date) => { for (const b of boosts) b.restored = true; boosts.push({ id: boosts.length + 1, targetF, restoreAt, restored: false }); },
    activeBoost: async (): Promise<Boost | null> => { const b = boosts.filter((x) => !x.restored && x.restoreAt.getTime() > Date.now()).at(-1); return b ? { targetF: b.targetF, restoreAt: b.restoreAt } : null; },
    dueBoosts: async () => boosts.filter((x) => !x.restored && x.restoreAt.getTime() <= Date.now()).map((x) => ({ id: x.id, targetF: x.targetF })),
    markBoostsRestored: async (ids: number[]) => { for (const b of boosts) if (ids.includes(b.id)) b.restored = true; },
  } as any;
  const slx = { patchDevice: async (_b: string, _s: string, fields: Record<string, number>) => {
    if (gate) await gate;
    patches.push(fields); live = { ...live, ...fields };
    return { syncCode: "x", ...live, temps: { temp1: { actual: 120, target: 128 }, temp3: { actual: 30 } } };
  } } as any;
  const hub = { getState: async () => ({ pi_connected: true, ts: Math.floor(Date.now() / 1000) - 10, pumps: [{ id: "pump1", name: "P1", online: true, setpoint_c: 60 }] }) } as any;
  const writer = new HbxWriter(slx, store, hub, "b", "s", async () => {});
  const hold = () => { let release!: () => void; gate = new Promise<void>((r) => { release = r; }); return () => { gate = null; release(); }; };
  return { writer, patches, audits, boosts, hold, live: () => live };
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
  console.log("writes-boost.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
