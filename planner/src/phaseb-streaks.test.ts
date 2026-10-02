/**
 * eval 2026-09-30 F4 — PhaseB.streaks() is a CURRENT per-pump count of consecutive write failures: every configured pump is
 * present, 0 when never failed, reset by a success and by a dry-run cycle (nothing attempted ⇒ nothing failing).
 */
import assert from "node:assert/strict";
import { PhaseB } from "./phaseb";

function harness(opts: { dryRun?: boolean; fail?: Set<string>; canWrite?: () => Promise<boolean> }) {
  // `fail` is read on every call, so a test can flip a pump from failing to healthy mid-sequence
  const logs: Array<{ pumpId: string; result: string }> = [];
  const sends: string[] = [];
  const store = {
    getLatestSlx: async () => ({ ts: new Date(), targetF: 120, outdoorF: 60, tankF: 121 }),
    recentPlans: async () => [{ plan: [{ ts: new Date().toISOString(), tank_target_f: 120, outdoor_f: 60 }] }],
    insertPhaseBLog: async (row: { pumpId: string; result: string }) => { logs.push({ pumpId: row.pumpId, result: row.result }); },
    latestConfig: async () => null,
  } as any;
  const hub = { sendSetpoint: async (pumpId: string) => { sends.push(pumpId); return opts.fail?.has(pumpId) ? { ok: false, detail: "cannot connect" } : { ok: true }; }, getState: async () => ({ pumps: [] }) } as any;
  const notes: string[] = [];
  const pb = new PhaseB(store, hub, ["pump1", "pump2"], opts.dryRun ?? false, async (t: string) => { notes.push(t); }, false, opts.canWrite);
  return { pb, notes, logs, sends };
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
  // the RECOVERY page survives a dry-run interlude (codex pass 3): page → dry-run → active success ⇒ "Phase B recovered" once
  {
    const fail = new Set(["pump1"]); const h = harness({ fail });
    for (let i = 0; i < 3; i++) await h.pb.runOnce();
    assert.equal(h.notes.filter((n) => n === "Phase B tracking failing").length, 1);
    h.pb.setDryRun(true); await h.pb.runOnce(); h.pb.setDryRun(false);
    fail.clear(); await h.pb.runOnce();
    assert.equal(h.notes.filter((n) => n === "Phase B recovered").length, 1, "the failure page gets its recovery page even though a dry-run cycle sat between");
    await h.pb.runOnce();
    assert.equal(h.notes.filter((n) => n === "Phase B recovered").length, 1, "…and only once");
    // a pump that never paged never gets a 'recovered' page
    assert.equal(h.notes.filter((n) => /pump2/.test(n)).length, 0);
  }
  // Graceful handover (#162): canWrite is asked FRESH before every send; false (lease not held / shutting down) skips the
  // pump without touching the Modbus streak and records a 'skipped: no writer lease' row; a rejected lease query skips too
  {
    let calls = 0;
    const h = harness({ canWrite: async () => { calls++; return false; } });
    await h.pb.runOnce();
    assert.equal(calls, 2, "one fresh lease check per pump");
    assert.deepEqual(h.sends, [], "no pump setpoint sent without the lease");
    assert.deepEqual(h.pb.streaks(), { pump1: 0, pump2: 0 }, "a lease gap is not a Modbus failure");
    assert.deepEqual(h.logs.map((l) => l.result), ["skipped: no writer lease", "skipped: no writer lease"]);
    assert.match(h.pb.lastResults.pump1, /writer lease not held/);
    const r = harness({ canWrite: async () => { throw new Error("db blip"); } });
    await r.pb.runOnce();
    assert.deepEqual(r.sends, [], "a failed lease query fails CLOSED (skip)");
    const ok = harness({ canWrite: async () => true });
    await ok.pb.runOnce();
    assert.deepEqual(ok.sends, ["pump1", "pump2"], "with the lease, both pumps are sent");
  }
  console.log("phaseb-streaks.test.ts (F4 current per-pump failure count): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
