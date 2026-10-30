/**
 * @purpose The owner's two failsafe emails (owneralerts.ts, owner 2026-10-29) on realistic 5-min Phase B sequences:
 * a restart's one "no countdown" read never emails; 31+ min without one emails once; re-armed sends one all-clear;
 * flapping never storms; the control-failing email needs ~35 min of failed writes. Run: npx tsx src/owneralerts.test.ts
 */
import assert from "node:assert/strict";
import { PhaseB } from "./phaseb";
import { SustainedEpisode, coldNow, controlOutcome, SAFETY_NET_KEY, CONTROL_KEY } from "./owneralerts";

const CYCLE = 5 * 60_000;
let now = Date.UTC(2026, 9, 29, 12, 0);
Date.now = () => now;

type Note = { title: string; body: string; tier: string; resolved: boolean; key?: string; html?: string };

function rig(opts: { latches?: Record<string, string>; dryRun?: boolean } = {}) {
  const armed: Record<string, boolean> = { pump1: true, pump2: true };
  let writesOk = true;
  /** per-pump failure detail (the bridge's refusal text relayed by the hub); overrides writesOk for that pump */
  const fail: Record<string, string | null> = { pump1: null, pump2: null };
  const extra: Record<string, Record<string, unknown>> = { pump1: {}, pump2: {} };
  const hubSt = { piConnected: true, slxFresh: true };
  const store = {
    getLatestSlx: async () => ({ ts: new Date(hubSt.slxFresh ? now : now - 3_600_000), targetF: 120, outdoorF: 40, tankF: 128 }),
    recentPlans: async () => [],
    insertPhaseBLog: async () => {},
    latestConfig: async () => null,
    getNotifyLatch: async (k: string) => (opts.latches?.[k] ? { tier: opts.latches[k], notifiedAt: new Date(now - 3_600_000) } : null),
  } as any;
  const hub = {
    sendSetpoint: async (id: string) => (!hubSt.piConnected ? { ok: false, detail: "no Pi connected" }
      : fail[id] ? { ok: false, detail: fail[id] } : writesOk ? { ok: true } : { ok: false, detail: "Modbus timeout reading back reg 2004" }),
    getState: async () => ({
      pi_connected: hubSt.piConnected, ts: now / 1000,
      pumps: ["pump1", "pump2"].map((id, i) => ({
        id, name: `Heat Pump ${i + 1}`, online: true, setpoint_c: 55, state: i ? "idle" : "heating",
        remote_lease_until: armed[id] ? now / 1000 + 85 * 60 : null, ...extra[id],
      })),
    }),
  } as any;
  const notes: Note[] = [];
  const pb = new PhaseB(store, hub, ["pump1", "pump2"], !!opts.dryRun,
    async (title: string, body: string, _p: string, o: any) => { notes.push({ title, body, tier: o.tier, resolved: !!o.resolved, key: o.key, html: o.html }); });
  const cycle = async (n = 1) => { for (let i = 0; i < n; i++) { now += CYCLE; await pb.runOnce(); } };
  const pages = () => notes.filter((n) => n.tier === "page");
  return { pb, notes, pages, cycle, armed, fail, extra, hubSt, setWrites: (ok: boolean) => { writesOk = ok; } };
}
const setBoth = (a: Record<string, boolean>, v: boolean) => { a.pump1 = v; a.pump2 = v; };
const JARGON = /lease|phase b|writer|finding|baseline_setpoint/i;

(async () => {
  // ── SustainedEpisode, alone ────────────────────────────────────────────────────────────────────────────────
  {
    const ep = new SustainedEpisode(30 * 60_000);
    assert.equal(ep.step("good", 0), null, "nothing open, nothing to clear");
    assert.equal(ep.step("bad", 1), "open");
    assert.equal(ep.step("bad", 2), null, "already open");
    assert.equal(ep.step("good", 10), null);
    assert.equal(ep.step("unknown", 20), null, "an unknown cycle breaks the all-clear run");
    assert.equal(ep.step("good", 30), null);
    assert.equal(ep.step("good", 30 + 30 * 60_000 - 1), null);
    assert.equal(ep.step("good", 30 + 30 * 60_000), "close");
  }

  // ── restart → one "no countdown" cycle → re-armed: no email ──────────────────────────────────────────────────
  {
    const r = rig();
    setBoth(r.armed, false);   // the bridge just restarted: its countdown lives in memory, the hub serves the old push
    await r.cycle();
    setBoth(r.armed, true);
    await r.cycle(36);         // three hours of normal running
    assert.equal(r.pages().length, 0, "a restart's single unarmed read never reaches the owner");
  }

  // ── 31 minutes unarmed: one email; re-armed: one all-clear ─────────────────────────────────────────────────
  {
    const r = rig();
    await r.cycle(2);
    setBoth(r.armed, false);
    await r.cycle(7);          // reads at 0, 5, … 30 min: unarmed for 30 min — not yet "more than 30"
    assert.equal(r.pages().length, 0, "exactly 30 min is not yet more than 30");
    await r.cycle();           // 35 min
    assert.equal(r.pages().length, 1, "one email, not one per pump");
    const open = r.pages()[0];
    assert.equal(open.title, "Heat-pump safety net is off");
    assert.equal(open.key, SAFETY_NET_KEY);
    assert.ok(!open.resolved);
    assert.match(open.body, /90-minute countdown/);
    assert.match(open.body, /safe warm 52 °C/);
    assert.match(open.body, /both heat pumps/);
    assert.match(open.body, /Nothing is cold right now: the tank is 128 °F/);
    assert.match(open.body, /Both heat pumps are running normally/);
    assert.doesNotMatch(open.body, JARGON, "owner words only");
    assert.ok(open.html && /URGENT/.test(open.html) && /Heat Pump 2/.test(open.html) && !JARGON.test(open.html));

    await r.cycle(12);         // another hour off: no repeat
    assert.equal(r.pages().length, 1, "one email per episode");

    setBoth(r.armed, true);
    await r.cycle(6);          // armed 25 min: not yet stable
    assert.equal(r.pages().length, 1, "the all-clear waits for 30 min of the countdown running");
    await r.cycle();
    assert.equal(r.pages().length, 2);
    const back = r.pages()[1];
    assert.equal(back.title, "Safety net is back on");
    assert.ok(back.resolved && back.key === SAFETY_NET_KEY);
    assert.doesNotMatch(back.body, JARGON);
    await r.cycle(24);
    assert.equal(r.pages().length, 2, "one all-clear");
  }

  // ── one pump only ──────────────────────────────────────────────────────────────────────────────────────────
  {
    const r = rig();
    r.armed.pump2 = false;
    await r.cycle(8);
    assert.equal(r.pages().length, 1);
    assert.match(r.pages()[0].body, /on Heat Pump 2\./);
  }

  // ── flapping: no storm ─────────────────────────────────────────────────────────────────────────────────────
  {
    const r = rig();
    for (let i = 0; i < 72; i++) { setBoth(r.armed, i % 2 === 0); await r.cycle(); }   // 6 h of on/off every cycle
    assert.equal(r.pages().length, 0, "never 30 min without a countdown: no email");

    // long off spells with short on spells between them: one episode, held open until it is stable
    for (let k = 0; k < 4; k++) {
      setBoth(r.armed, false); await r.cycle(8);   // 35+ min off
      setBoth(r.armed, true); await r.cycle(2);    // 10 min on
    }
    assert.equal(r.pages().length, 1, "four off spells in 3 h are one email");
    assert.equal(r.pages().filter((n) => n.resolved).length, 0, "no all-clear while it keeps dropping out");
    await r.cycle(6);
    assert.equal(r.pages().filter((n) => n.resolved).length, 1, "one all-clear once it holds");
  }

  // ── A2W can't control the heat pumps ──────────────────────────────────────────────────────────────────────
  {
    const r = rig();
    await r.cycle(2);
    r.setWrites(false);        // the last countdown keeps running on the Pi: it reverts the pumps 90 min after the last write
    await r.cycle(6);
    assert.equal(r.pages().length, 0, "6 failed cycles (~25 min) is a blip");
    await r.cycle();
    assert.equal(r.pages().length, 1, "the 7th in a row emails");
    const open = r.pages()[0];
    assert.equal(open.title, "A2W can't control the heat pumps");
    assert.equal(open.key, CONTROL_KEY);
    assert.match(open.body, /about 30 minutes/);
    assert.match(open.body, /Within 90 minutes .* safe warm 52 °C on its own/, "the countdown from the last write still stands");
    assert.doesNotMatch(open.body, JARGON);
    await r.cycle(12);
    assert.equal(r.pages().length, 1, "one email per episode, and no 'safety net' email while writes fail");

    r.setWrites(true);
    await r.cycle();
    r.setWrites(false);
    await r.cycle();           // one good write then failing again: still the same episode
    r.setWrites(true);
    setBoth(r.armed, true);
    await r.cycle(6);
    assert.equal(r.pages().length, 1);
    await r.cycle();
    assert.equal(r.pages().length, 2);
    assert.equal(r.pages()[1].title, "A2W is controlling the heat pumps again");
    assert.ok(r.pages()[1].resolved);
  }
  {
    // the Pi lost its countdown (a bridge restart) and then writes stop landing: the pumps stay where they are
    const r = rig();
    await r.cycle();
    r.setWrites(false);
    setBoth(r.armed, false);
    await r.cycle(7);
    assert.equal(r.pages().length, 1);
    assert.match(r.pages()[0].body, /safety net is off too/);
  }
  {
    const r = rig();
    for (let i = 0; i < 72; i++) { r.setWrites(i % 3 !== 0); await r.cycle(); }   // a failure every third cycle
    assert.equal(r.pages().length, 0, "intermittent failures never page");
  }

  // ── review of #243: one unarmed read, then the Pi drops off for 40 min while the hub serves that last push ─────
  {
    const r = rig();
    await r.cycle(2);
    setBoth(r.armed, false);   // the bridge restarted: one normal "no countdown" read
    await r.cycle();
    r.hubSt.piConnected = false; // …then the Pi drops off; the hub keeps serving the unarmed frame
    await r.cycle(9);          // 45 min
    assert.equal(r.pages().length, 0, "no 'safety net off' (nothing landed) and no 'can't control' (the Pi-unreachable page owns it)");
    r.hubSt.piConnected = true;
    setBoth(r.armed, true);
    await r.cycle(12);
    assert.equal(r.pages().length, 0, "and nothing on the way back");
  }
  {
    // the same, but the Pi is connected and the writes fail for another reason: only the control email, and the
    // safety-net clock never ran (it needs landed writes)
    const r = rig();
    await r.cycle(2);
    setBoth(r.armed, false);
    await r.cycle();
    r.setWrites(false);
    await r.cycle(9);
    assert.deepEqual(r.pages().map((n) => n.title), ["A2W can't control the heat pumps"]);
    assert.doesNotMatch(r.pages()[0].body, /still setting/);
  }
  {
    // the switch flipped: a Pi outage counts
    const st = { pi_connected: false, ts: null, pumps: [] };
    assert.equal(controlOutcome(false, "no Pi connected", undefined, st), "unknown", "default: the Pi-unreachable page owns it");
    assert.equal(controlOutcome(false, "no Pi connected", undefined, st, true), "fail");
    assert.equal(controlOutcome(false, "ack timeout", undefined, { ...st, pi_connected: true }), "fail", "a connected Pi that does not answer is a failure");
    assert.equal(controlOutcome(false, "W610 (MAC mismatch); refusing to write to what may be the wrong pump", undefined, null), "fail",
      "a gateway identity mismatch is a fault, not a choice");
  }

  // ── a person's choice is not a failure ────────────────────────────────────────────────────────────────────
  {
    // #212: Heat Pump 2's breaker switched off by hand; the bridge refuses its writes as offline
    const r = rig();
    await r.cycle(2);
    r.extra.pump2 = { deliberate_stop: { circuit: "Air-Water 2", since: now / 1000 } };
    r.fail.pump2 = "pump2 is offline — refusing to queue a stale write";
    r.armed.pump2 = false;
    await r.cycle(36);
    assert.equal(r.pages().length, 0, "a deliberate stop never pages, as 'can't control' or as 'safety net off'");
  }
  {
    // the unit switched to hot-water / standby mode at the wall controller: the bridge's 409
    const r = rig();
    r.fail.pump1 = "unit is in DHW mode — remote setpoint is only supported for heating and cooling; use the wall controller";
    r.armed.pump1 = false;
    await r.cycle(36);
    assert.equal(r.pages().length, 0, "a mode refusal never pages");
  }
  {
    // write_enabled: false on the Pi: the bridge's 403
    const r = rig();
    r.extra.pump1 = { write_enabled: false };
    r.fail.pump1 = "writes are disabled for pump1 (write_enabled: false)";
    await r.cycle(36);
    assert.equal(r.pages().length, 0, "write-disabled never pages");
  }
  {
    // a real refusal still counts: the W610 identity mismatch
    const r = rig();
    r.fail.pump2 = "W610 (MAC mismatch); refusing to write to what may be the wrong pump";
    await r.cycle(7);
    assert.equal(r.pages().length, 1);
    assert.match(r.pages()[0].body, /reached Heat Pump 2\./);
  }

  // ── a SensorLinx gap does not age the safety-net clock ────────────────────────────────────────────────────
  {
    const r = rig();
    setBoth(r.armed, false);
    await r.cycle(3);          // 10 min unarmed
    r.hubSt.slxFresh = false;
    await r.cycle(24);         // 2 h with no fresh HBX target: Phase B writes nothing
    r.hubSt.slxFresh = true;
    await r.cycle();
    assert.equal(r.pages().length, 0, "the run restarts after the gap instead of reading 2 h old");
    await r.cycle(7);
    assert.equal(r.pages().length, 1, "and fires after 30+ min of landed, unarmed writes");
  }

  // ── dry-run proves nothing either way ──────────────────────────────────────────────────────────────────────
  {
    const r = rig({ dryRun: true });
    setBoth(r.armed, false);
    await r.cycle(24);
    assert.equal(r.pages().length, 0, "dry-run sends nothing, so a missing countdown is expected");
  }

  // ── a redeploy mid-episode still sends the all-clear it owes ──────────────────────────────────────────────
  {
    const r = rig({ latches: { [SAFETY_NET_KEY]: "page" } });
    await r.cycle(7);
    assert.deepEqual(r.pages().map((n) => [n.title, n.resolved]), [["Safety net is back on", true]]);
    assert.deepEqual(r.pb.ownerEpisodes(), { safety_net_off: false, control_failing: false });
  }

  // ── "is anything cold?" ───────────────────────────────────────────────────────────────────────────────────
  assert.match(coldNow(110, 120, []), /^The tank is 110 °F, below the 120 °F hot water needs/);
  assert.match(coldNow(null, 120, null), /couldn't read the tank.*couldn't read the heat pumps/);
  assert.match(coldNow(125, 120, [{ id: "pump2", name: "Heat Pump 2", online: false, setpoint_c: null }]), /Heat Pump 2 is not answering\./);

  console.log("owneralerts.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
