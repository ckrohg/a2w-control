/**
 * eval 2026-09-30 F4 — PhaseB.streaks() is a CURRENT per-pump count of consecutive write failures: every configured pump is
 * present, 0 when never failed, reset by a success and by a dry-run cycle (nothing attempted ⇒ nothing failing).
 */
import assert from "node:assert/strict";
import { PhaseB } from "./phaseb";

function harness(opts: { dryRun?: boolean; fail?: Set<string> }) {
  const store = {
    getLatestSlx: async () => ({ ts: new Date(), targetF: 120, outdoorF: 60, tankF: 121 }),
    recentPlans: async () => [{ plan: [{ ts: new Date().toISOString(), tank_target_f: 120, outdoor_f: 60 }] }],
    insertPhaseBLog: async () => {},
    latestConfig: async () => null,
  } as any;
  const hub = { sendSetpoint: async (pumpId: string) => (opts.fail?.has(pumpId) ? { ok: false, detail: "cannot connect" } : { ok: true }), getState: async () => ({ pumps: [] }) } as any;
  const notes: string[] = [];
  const pb = new PhaseB(store, hub, ["pump1", "pump2"], opts.dryRun ?? false, async (t: string) => { notes.push(t); }, false);
  return { pb, notes };
}

(async () => {
  { const { pb } = harness({}); assert.deepEqual(pb.streaks(), { pump1: 0, pump2: 0 }, "every configured pump present at 0 before any cycle"); }
  { const { pb } = harness({ fail: new Set(["pump2"]) }); await pb.runOnce(); await pb.runOnce(); assert.deepEqual(pb.streaks(), { pump1: 0, pump2: 2 }); }
  { const h = harness({ fail: new Set(["pump2"]) }); await h.pb.runOnce(); await h.pb.runOnce(); const d = harness({ dryRun: true }); assert.deepEqual(d.pb.streaks(), { pump1: 0, pump2: 0 }); }
  // dry-run RESETS: a pump that was failing reads 0 once the lane is dry-run (nothing attempted)
  { const { pb } = harness({ fail: new Set(["pump1", "pump2"]) }); await pb.runOnce(); assert.deepEqual(pb.streaks(), { pump1: 1, pump2: 1 }); pb.setDryRun(true); await pb.runOnce(); assert.deepEqual(pb.streaks(), { pump1: 0, pump2: 0 }); }
  // the alert latch moves with the streak: alerted after 3 failures → dry-run cycle → active again → 3 more failures PAGES AGAIN
  {
    const h = harness({ fail: new Set(["pump1"]) });
    for (let i = 0; i < 3; i++) await h.pb.runOnce();
    assert.equal(h.notes.filter((n) => /Phase B/.test(n) && !/recovered|armed/.test(n)).length, 1, "paged once at 3 consecutive failures");
    h.pb.setDryRun(true); await h.pb.runOnce(); assert.equal(h.pb.streaks().pump1, 0);
    h.pb.setDryRun(false); for (let i = 0; i < 3; i++) await h.pb.runOnce();
    assert.equal(h.pb.streaks().pump1, 3);
    assert.equal(h.notes.filter((n) => /Phase B/.test(n) && !/recovered|armed/.test(n)).length, 2, "the latch was cleared with the streak, so the second sustained failure pages too");
  }
  console.log("phaseb-streaks.test.ts (F4 current per-pump failure count): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
