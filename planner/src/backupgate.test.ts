/**
 * @purpose Assertions for the backup-element gate (backupgate.ts) on REAL data — four windows of the restored history at
 * the planner's 5-min poll cadence (slx_readings + the mirror's pump states, null = no live Pi frame), replayed the way
 * index.ts feeds it (a StageWatch stepped on the same rows supplies the per-stage episodes). Pins:
 *   - the Oct 15–16 incident (HP2 E21 lead, 14.2 h with no heat): ONE would-close, 95 min into the call; one would-open
 *     once HP2 heated again; nothing else;
 *   - Oct 17–19, the first cold nights with every pump healthy, shower sags to ~101 °F and a stuck 83-min defrost: NOTHING;
 *   - Jul 22 – Aug 7 (lagT 60, HP2 faulted for weeks, HP1 joining as lag stage with the HBX backup call ~60 min in): NOTHING
 *     — the remaining pump always recovered the tank inside the 90-min hold;
 *   - Aug 12–13 (20.1 h stage-2 call, HP2 fault, HP1 never called): one would-close, one would-open;
 * plus the floor rule, blind spells, dwell, restore, and the live command / override / re-open-disabled paths.
 * Run with: npx tsx planner/src/backupgate.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BackupGate, BG, DEFAULT_THRESHOLDS, parseGateConfig, type GateEvent, type GateInput, type GatePump } from "./backupgate";
import { StageWatch, DEFAULT_STAGE_PUMP_MAP } from "./stagewatch";

type FxRow = [number, number | null, number | null, string | null, string[] | null];
const fx = (name: string): FxRow[] => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")).rows;
const et = (s: number) => new Date(s * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

function replay(rows: FxRow[], gate = new BackupGate("shadow", true)): { at: number; e: GateEvent }[] {
  const sw = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  const out: { at: number; e: GateEvent }[] = [];
  for (const [ts, tank, tgt, st, ps] of rows) {
    const nowMs = ts * 1000;
    const stages = st == null ? null : [...st].map((c) => c === "1");
    const pumps: GatePump[] | null = ps ? ps.map((s, k) => ({ id: `pump${k + 1}`, online: s !== "offline", state: s })) : null;
    sw.step({ nowMs, stagesCalled: stages, pumps: stages?.some(Boolean) ? pumps : [], lagTMin: null });
    const status = sw.status();
    const withEp = pumps?.map((p) => ({ ...p, stageEpisode: Object.values(status).some((s) => s.pump === p.id && (s.unserved_open || s.fault_open)) })) ?? null;
    for (const e of gate.step({ nowMs, tankF: tank, tankTargetF: tgt, stagesCalled: stages, pumps: withEp })) out.push({ at: ts, e });
  }
  return out;
}

// ── 1. config ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const d = parseGateConfig({});
  assert.equal(d.mode, "shadow", "shadow by default");
  assert.equal(d.reopen, false, "re-open off by default");
  assert.deepEqual(d.t, DEFAULT_THRESHOLDS);
  assert.deepEqual(d.errors, []);
  assert.equal(DEFAULT_THRESHOLDS.floorF, 100);
  assert.equal(DEFAULT_THRESHOLDS.floorHoldMs, 30 * 60_000);
  const o = parseGateConfig({ BACKUP_GATE: "live", BACKUP_GATE_REOPEN: "1", BACKUP_GATE_FLOOR_F: "95", BACKUP_GATE_FLOOR_MIN: "45" });
  assert.equal(o.mode, "live"); assert.equal(o.reopen, true);
  assert.equal(o.t.floorF, 95); assert.equal(o.t.floorHoldMs, 45 * 60_000);
  assert.equal(parseGateConfig({ BACKUP_GATE: "off" }).mode, "off");
  const bad = parseGateConfig({ BACKUP_GATE: "yes", BACKUP_GATE_FLOOR_F: "85", BACKUP_GATE_FAIL_HOLD_MIN: "30", BACKUP_GATE_REOPEN: "true" });
  assert.equal(bad.mode, "shadow", "an unknown mode is shadow, never live");
  assert.equal(bad.t.floorF, 100, "a floor below the HBX's own 90 °F bkTemp is refused");
  assert.equal(bad.t.failHoldMs, BG.FAIL_HOLD_MS, "a fail hold shorter than lagT 60 is refused");
  assert.equal(bad.reopen, false, "only the literal 1 enables re-open");
  assert.equal(bad.errors.length, 3);
}

// ── 2. REPLAY the Oct 15–16 incident: one would-close 90 min into the call, one would-open after recovery ───────────────
{
  const rows = fx("backupgate-incident-20261015.json");
  // the 14.2-h call: the first called poll from 11:55 ET on (a short morning call at 10:25 is served normally)
  const callStart = rows.find((r) => r[0] >= Date.parse("2026-10-15T15:55:00Z") / 1000 && r[3]?.includes("1"))![0];
  assert.equal(et(callStart), "10/15, 12:00", "fixture: the stage-2 call starts at noon");
  const ev = replay(rows);
  const closes = ev.filter((x) => x.e.kind === "close"), opens = ev.filter((x) => x.e.kind === "open");
  assert.equal(closes.length, 1, `exactly one would-close (${ev.map((x) => `${et(x.at)} ${x.e.kind}`).join(", ")})`);
  const c = closes[0];
  assert.equal(c.e.rule, "failed_not_recovering");
  const into = (c.at - callStart) / 60;
  assert.ok(into >= 90 && into <= 100, `would-close 90–100 min into the call (at ${into.toFixed(0)} min, ${et(c.at)})`);
  assert.equal(c.e.priority, "default", "shadow is never a phone push (#211 pushes high/urgent)");
  assert.match(c.e.title, /shadow.*WOULD close/i);
  assert.match(c.e.body, /SHADOW — nothing was switched/);
  assert.match(c.e.body, /pump2 is fault/);
  assert.equal(opens.length, 1, "one would-open once HP2 heats again");
  assert.ok(opens[0].at > Date.parse("2026-10-16T05:54:00Z") / 1000, `the would-open waits for the recovery (at ${et(opens[0].at)})`);
  assert.equal(opens[0].e.rule, "recovered");
  assert.equal(ev.length, 2, "nothing else");
}

// ── 3. REPLAY Oct 17–19, every pump healthy: shower sags, defrost dips, a stuck defrost, first cold nights → NOTHING ─────
{
  const rows = fx("backupgate-heavy-20261017.json");
  const called = rows.filter((r) => r[3]?.includes("1"));
  const minCalled = Math.min(...called.map((r) => r[1] ?? 999));
  assert.ok(minCalled < 101.5, `fixture holds the deep healthy sags (min ${minCalled} °F while called)`);
  assert.ok(called.length > 150, `fixture holds long single-pump calls (${called.length} called polls)`);
  const ev = replay(rows);
  assert.deepEqual(ev.map((x) => `${et(x.at)} ${x.e.kind}`), [], "no would-close on normal heavy days");
  // and the same days stay quiet at any floor the owner may pick from 90 up to 104 °F
  for (const floorF of [90, 95, 100, 104]) {
    const g = new BackupGate("shadow", true, { ...DEFAULT_THRESHOLDS, floorF });
    assert.equal(replay(rows, g).length, 0, `floor ${floorF} °F: nothing`);
  }
}

// ── 4. REPLAY Jul 22 – Aug 7 (lagT 60, HP2 faulted lead, HP1 + HBX backup call join ~60 min in) → NOTHING ───────────────
{
  const rows = fx("backupgate-lagt60-failedlead-202607.json");
  const both = rows.filter((r) => r[3] === "11" && r[4]?.[1] === "fault").length;
  assert.ok(both >= 20, `fixture holds the lag-stage arrivals with HP2 faulted (${both} polls with both stages called)`);
  const ev = replay(rows);
  assert.deepEqual(ev.map((x) => `${et(x.at)} ${x.e.kind} ${x.e.rule}`), [],
    "a failed pump whose partner recovers the tank never closes the breaker");
  // the 60-min hold would NOT have been safe: it closes on Jul 23 while HP1 was about to recover the tank
  const short = new BackupGate("shadow", true, { ...DEFAULT_THRESHOLDS, failHoldMs: 60 * 60_000 });
  assert.ok(replay(rows, short).some((x) => x.e.kind === "close"), "a 60-min hold false-closes here — why it is 90");
}

// ── 5. REPLAY Aug 12–13 (20.1 h call, HP2 fault, HP1 never called): one would-close, one would-open ──────────────────────
{
  const ev = replay(fx("backupgate-aug12-20h.json"));
  assert.deepEqual(ev.map((x) => x.e.kind), ["close", "open"]);
  assert.equal(ev[0].e.rule, "failed_not_recovering");
  assert.equal(et(ev[0].at).slice(0, 5), "08/12");
}

// ── synthetic helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
const T0 = Date.parse("2026-12-20T08:00:00Z");
const at = (m: number) => T0 + m * 60_000;
const P = (id: string, state: string, extra: Partial<GatePump> = {}): GatePump => ({ id, online: state !== "offline", state, ...extra });
const both = (s1: string, s2: string) => [P("pump1", s1), P("pump2", s2)];
function run(g: BackupGate, from: number, to: number, f: (m: number) => Partial<GateInput>): { m: number; e: GateEvent }[] {
  const out: { m: number; e: GateEvent }[] = [];
  for (let m = from; m <= to; m += 5) {
    const i: GateInput = { nowMs: at(m), tankF: 120, tankTargetF: 120, stagesCalled: [true, true], pumps: both("heating", "heating"), ...f(m) };
    for (const e of g.step(i)) out.push({ m, e });
  }
  return out;
}

// ── 6. floor rule: every available pump running, tank below the floor and not rising for 30 min ────────────────────────
{
  const g = new BackupGate();
  const ev = run(g, 0, 60, () => ({ tankF: 97, tankTargetF: 120 }));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].e.rule, "floor");
  // the 20-min rise is first known at m=15 (a sample ≥ 10 min back, within 7.5 min of 20 min back) → closes at m=45
  assert.equal(ev[0].m, 45, `floor closes 30 min after it is first judged (at ${ev[0].m})`);
  assert.match(ev[0].e.body, /below the 100 °F floor/);
  // a tank climbing out of a hole (+1 °F / 5 min) is being kept up with
  assert.equal(run(new BackupGate(), 0, 120, (m) => ({ tankF: 80 + m / 5, tankTargetF: 120 })).length, 0, "rising → no close");
  // an available pump that is idle (lagT not yet up) means the HBX still has capacity to add
  assert.equal(run(new BackupGate(), 0, 120, () => ({ tankF: 97, pumps: both("heating", "idle") })).length, 0, "lag pump idle → no floor close");
  // ... unless that pump is FAILED: then "every available pump" is the one running
  const f2 = run(new BackupGate(), 0, 60, () => ({ tankF: 97, pumps: [P("pump1", "heating"), P("pump2", "fault")] }));
  assert.deepEqual(f2.map((x) => x.e.rule), ["floor"]);
  // above the floor, both pumps running flat out, tank sagging but holding: the owner's "massive load" — no close
  assert.equal(run(new BackupGate(), 0, 600, () => ({ tankF: 104, tankTargetF: 125 })).length, 0);
  // a defrost counts as engaged
  assert.equal(run(new BackupGate(), 0, 60, () => ({ tankF: 97, pumps: both("defrost", "heating") })).length, 1);
}

// ── 7. failed_not_recovering: hold, reset on a rise, blind spells neither credit nor reset ───────────────────────────────
{
  const failed = () => ({ tankF: 105, tankTargetF: 120, stagesCalled: [false, true], pumps: [P("pump1", "idle"), P("pump2", "fault")] });
  const ev = run(new BackupGate(), 0, 200, failed);
  assert.equal(ev.length, 1); assert.equal(ev[0].e.rule, "failed_not_recovering");
  assert.equal(ev[0].m, 105, `closes 90 min after the first judged poll (m=15) → m=105 (at ${ev[0].m})`);
  // a 3 °F rise in 20 min PAUSES the clock (the partner pump is lifting the tank) — it closes later, not sooner
  const g = new BackupGate();
  const ev2 = run(g, 0, 200, (m) => ({ ...failed(), tankF: m >= 80 && m <= 100 ? 105 + (m - 80) / 5 * 1.5 : 105 }));
  assert.ok(!ev2.length || ev2[0].m > 105, "a recovery resets the hold");
  // within the target margin → not a failure to recover
  assert.equal(run(new BackupGate(), 0, 300, () => ({ ...failed(), tankF: 114 })).length, 0, "6 °F below target: holding");
  // a failed pump while the HBX is NOT calling never closes
  assert.equal(run(new BackupGate(), 0, 300, () => ({ ...failed(), stagesCalled: [false, false] })).length, 0);
  // blind (no live Pi frame) m=55..110 in the middle: no reset, no credit. Credited 15→50 (35 min); the first poll after
  // the spell credits nothing (no previous step) → 55 more min from m=115
  const g3 = new BackupGate();
  const ev3 = run(g3, 0, 300, (m) => ({ ...failed(), pumps: m > 50 && m <= 110 ? null : failed().pumps }));
  assert.equal(ev3.length, 1);
  assert.equal(ev3[0].m, 170, `blind spell paused the clock (closed at ${ev3[0].m})`);
  // offline in a LIVE frame is a failure; a stage episode is a failure even while the pump reports idle
  assert.equal(run(new BackupGate(), 0, 200, () => ({ ...failed(), pumps: [P("pump1", "idle"), P("pump2", "offline")] })).length, 1);
  assert.equal(run(new BackupGate(), 0, 200, () => ({ ...failed(), pumps: [P("pump1", "idle"), P("pump2", "idle", { stageEpisode: true })] })).length, 1);
  // no failed pump: the same tank never closes by this rule
  assert.equal(run(new BackupGate(), 0, 400, () => ({ ...failed(), pumps: both("idle", "heating") })).length, 0);
}

// ── 7b. the survivor's defrost sawtooth in a real failure: dips and partial recoveries with a net decline must not
//        restart the 90 min every cycle (a rise pauses the clock, it does not reset it) ─────────────────────────────
{
  // 40-min cycle: 20 min of decline −6 °F (defrost / draw), 20 min of recovery +5 °F (a rise ≥ 3 every cycle) — net
  // −1 °F per cycle, always above the 100 °F floor, while the HBX calls, HP2 is faulted and HP1 heats
  const saw = (m: number) => { const k = Math.floor(m / 40), t = m % 40; const base = 122 - k; return t < 20 ? base - (6 * t) / 20 : base - 6 + (5 * (t - 20)) / 20; };
  const input = (m: number) => ({ tankF: saw(m), tankTargetF: 132, stagesCalled: [true, true], pumps: [P("pump1", "heating"), P("pump2", "fault")] });
  const ev = run(new BackupGate(), 0, 600, input);
  assert.ok(Array.from({ length: 121 }, (_, i) => saw(i * 5)).every((f) => f > 100), "fixture: never under the floor");
  assert.equal(ev.length, 1, "a sawtooth with a net decline still closes");
  assert.equal(ev[0].e.rule, "failed_not_recovering", "by the failure rule, not the floor");
  assert.ok(ev[0].m <= 300, `closed at ${ev[0].m} min`);
  // ... while a steady climb (+1 °F / 5 min from 100) never does: it pauses, then the deficit closes and resets it
  assert.equal(run(new BackupGate(), 0, 400, (m) => ({ tankF: Math.min(125, 100 + m / 5), tankTargetF: 120, stagesCalled: [true, true],
    pumps: [P("pump1", "heating"), P("pump2", "fault")] })).length, 0);
}

// ── 8. recovery, dwell and restore (shadow: the state is virtual) ──────────────────────────────────────────────────────
{
  const g = new BackupGate();
  run(g, 0, 60, () => ({ tankF: 97, tankTargetF: 120 }));          // floor close at m=45
  assert.equal(g.breakerState, "closed"); assert.equal(g.closedByGate, true);
  // healthy and satisfied from m=65: the 60-min hold is met at m=125 but the 120-min dwell only at m=165
  const ev = run(g, 65, 300, () => ({ tankF: 125, tankTargetF: 120, stagesCalled: [false, false], pumps: both("idle", "idle") }));
  assert.equal(ev.length, 1); assert.equal(ev[0].e.kind, "open"); assert.equal(ev[0].m, 165, `dwell holds the re-open (at ${ev[0].m})`);
  assert.match(ev[0].e.title, /shadow.*WOULD re-open/i);
  // a failed pump never counts as recovered
  const g2 = new BackupGate();
  g2.restore({ closedByGate: true, atMs: at(-500) });
  assert.equal(g2.breakerState, "closed");
  assert.equal(run(g2, 0, 400, () => ({ tankF: 125, stagesCalled: [false, false], pumps: [P("pump1", "idle"), P("pump2", "fault")] })).length, 0);
  // a restore of "open" changes nothing
  const g3 = new BackupGate(); g3.restore({ closedByGate: false, atMs: at(0) }); assert.equal(g3.breakerState, "open");
  // shadow ignores the real relay entirely
  const g4 = new BackupGate();
  run(g4, 0, 30, () => ({ relay: "CLOSED" }));
  assert.equal(g4.breakerState, "open", "shadow's state is virtual");
}

// ── 9. LIVE: command / verified apply / retry; a human OPEN is an override; re-open disabled pages once ──────────────────
{
  const g = new BackupGate("live", false);
  const low = () => ({ tankF: 97, tankTargetF: 120, relay: "OPEN" as const });
  const ev = run(g, 0, 50, low);
  assert.equal(ev.length, 1); assert.match(ev[0].e.title, /A2W closed/);
  assert.equal(g.pendingAction, "close"); assert.equal(g.breakerState, "open", "nothing changes until the Pi verifies");
  assert.equal(run(g, 55, 60, low).length, 0, "no second command while one is pending");
  g.applied(false, at(60));
  assert.equal(run(g, 65, 70, low).length, 0, "a failed command is not retried for 15 min");
  const retry = run(g, 75, 80, low);
  assert.equal(retry.length, 1, "retried after 15 min");
  g.applied(true, at(80));
  assert.equal(g.breakerState, "closed"); assert.equal(g.closedByGate, true);
  // the owner switches it OFF by hand → override page, and no re-close for 12 h even though the floor still holds
  const ov = run(g, 85, 85, () => ({ ...low(), relay: "OPEN" }));
  assert.deepEqual(ov.map((x) => x.e.kind), ["override"]);
  assert.equal(run(g, 90, 600, low).length, 0, "stands down");
  // a breaker someone else CLOSED is never re-opened by the gate
  const g2 = new BackupGate("live", true);
  run(g2, 0, 10, () => ({ relay: "CLOSED" }));
  assert.equal(g2.breakerState, "closed"); assert.equal(g2.closedByGate, false);
  assert.equal(run(g2, 15, 600, () => ({ tankF: 125, stagesCalled: [false, false], pumps: both("idle", "idle"), relay: "CLOSED" })).length, 0);
  // re-open disabled: one reopen_blocked page, the breaker stays closed
  const g3 = new BackupGate("live", false);
  g3.restore({ closedByGate: true, atMs: at(-200) });
  const rb = run(g3, 0, 300, () => ({ tankF: 125, stagesCalled: [false, false], pumps: both("idle", "idle"), relay: "CLOSED" }));
  assert.deepEqual(rb.map((x) => x.e.kind), ["reopen_blocked"]);
  assert.match(rb[0].e.body, /re-opening is disabled/);
  assert.equal(g3.breakerState, "closed");
  // re-open enabled: an open command, applied → open
  const g4 = new BackupGate("live", true);
  g4.restore({ closedByGate: true, atMs: at(-200) });
  const ro = run(g4, 0, 300, () => ({ tankF: 125, stagesCalled: [false, false], pumps: both("idle", "idle"), relay: "CLOSED" }));
  assert.deepEqual(ro.map((x) => x.e.kind), ["open"]);
  g4.applied(true, at(300));
  assert.equal(g4.breakerState, "open");
}

// ── 9b. LIVE failures: a refusal stands down for the episode; a timeout retries; either pages ONCE; a lost ack is
//        confirmed from the relay ─────────────────────────────────────────────────────────────────────────────────
{
  const low = () => ({ tankF: 97, tankTargetF: 120, relay: "OPEN" as const });
  const g = new BackupGate("live", true);
  assert.equal(run(g, 0, 45, low).length, 1);
  assert.deepEqual(g.applied(false, at(45), true), { page: true }, "first refusal pages");
  assert.equal(run(g, 50, 300, low).length, 0, "refused: no retry while the condition holds");
  assert.equal((g.status(at(300)) as Record<string, unknown>).stand_down, "close");
  // the condition ends (tank recovers above the floor, call ends) → the stand-down ends with it; a new episode acts again
  run(g, 305, 310, () => ({ tankF: 120, tankTargetF: 120, stagesCalled: [false, false], relay: "OPEN" as const }));
  assert.equal((g.status(at(310)) as Record<string, unknown>).stand_down, null);
  const again = run(g, 315, 400, low);
  assert.equal(again.length, 1, "the next episode tries again");
  // a timeout: retried every 15 min, paged once
  const g2 = new BackupGate("live", true);
  run(g2, 0, 45, low);
  assert.deepEqual(g2.applied(false, at(45)), { page: true });
  const r1 = run(g2, 50, 60, low); assert.equal(r1.length, 1, "retried after 15 min");
  assert.deepEqual(g2.applied(false, at(60)), { page: false }, "the retry's failure does not page again");
  // the lost command actually landed: the relay reads CLOSED → the gate's own close, confirmed (not "someone else")
  const c = run(g2, 65, 65, () => ({ ...low(), relay: "CLOSED" as const }));
  assert.deepEqual(c.map((x) => [x.e.kind, x.e.confirms]), [["confirmed", "close"]]);
  assert.equal(g2.breakerState, "closed"); assert.equal(g2.closedByGate, true, "so it may re-open it later");
}

// ── 10. status() is what /health serves ───────────────────────────────────────────────────────────────────────────────
{
  const g = new BackupGate();
  run(g, 0, 25, () => ({ tankF: 97, tankTargetF: 120 }));
  const s = g.status(at(25)) as Record<string, any>;
  assert.equal(s.mode, "shadow"); assert.equal(s.gate_state, "open"); assert.equal(s.gate_state_virtual, true);
  assert.equal(s.thresholds.floor_f, 100); assert.equal(s.thresholds.fail_hold_min, 90);
  assert.equal(s.clocks.floor_min, 10, "judged from m=15, credited to m=25");
  assert.equal(s.conditions.floor, true); assert.equal(s.conditions.called, true);
}

console.log("backupgate.test.ts: all assertions passed");
