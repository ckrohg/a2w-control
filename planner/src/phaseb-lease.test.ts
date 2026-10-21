/**
 * Owner 2026-10-21: "Phase B: no lease armed" emailed at 08:19 ET, three minutes after a 16 s Pi dropout — a false alarm.
 * The hub serves the Pi's LAST push, which can predate the write the verify follows. One "no lease" read is therefore
 * believed only after NO_LEASE_STREAK consecutive writes, and even then it is record tier (engineer-only, never email).
 */
import assert from "node:assert/strict";
import { PhaseB } from "./phaseb";

(async () => {
  let leaseUntil: number | null = null;
  const store = {
    getLatestSlx: async () => ({ ts: new Date(), targetF: 120, outdoorF: 60, tankF: 121 }),
    recentPlans: async () => [{ plan: [{ ts: new Date().toISOString(), tank_target_f: 120, outdoor_f: 60 }] }],
    insertPhaseBLog: async () => {},
    latestConfig: async () => null,
  } as any;
  const hub = {
    sendSetpoint: async () => ({ ok: true }),
    getState: async () => ({ pumps: [{ id: "pump1", remote_lease_until: leaseUntil }] }),
  } as any;
  const notes: { title: string; tier: string; resolved: boolean }[] = [];
  const pb = new PhaseB(store, hub, ["pump1"], false,
    async (title: string, _b: string, _p: string, o: { tier: string; resolved?: boolean }) => { notes.push({ title, tier: o.tier, resolved: !!o.resolved }); }, false);
  const opens = () => notes.filter((n) => /no lease/.test(n.title));

  // the stale pre-write snapshot: one read without a lease, then the next push shows it armed
  await pb.runOnce();
  assert.equal(opens().length, 0, "a single no-lease read is not believed");
  leaseUntil = Date.now() / 1000 + 75 * 60;
  await pb.runOnce();
  assert.equal(opens().length, 0, "and an armed lease on the next write resets the streak");

  // genuinely missing across 3 consecutive writes: logged once, record tier only
  leaseUntil = null;
  for (let i = 0; i < 3; i++) await pb.runOnce();
  assert.equal(opens().length, 1, "missing for 3 writes in a row is recorded once");
  assert.equal(opens()[0].tier, "record", "engineer-only: never an owner email");
  await pb.runOnce();
  assert.equal(opens().length, 1, "latched");

  leaseUntil = Date.now() / 1000 + 75 * 60;
  await pb.runOnce();
  const cleared = notes.find((n) => n.title === "Phase B lease armed");
  assert.ok(cleared && cleared.resolved && cleared.tier === "record");
  console.log("phaseb-lease.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
