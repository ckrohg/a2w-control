/**
 * @purpose Assertions for the per-stage unserved-call alarm (#185, stagewatch.ts). Replays Oct 16 00:30–00:54 ET
 * (04:30–04:54Z: stage 2 called, HP2 FAULT/E21, HP1 idle, lagT 180) and pins: the fault-while-called page at once, the
 * stage-unserved page within 10 min naming the unit, its state, the code and lagT; stage-2-only with pump2 FAULT and
 * pump1 heating still pages; both heating → none; inside the grace → none; defrost suspends the clock; unverifiable
 * hub state moves nothing; restore() closes instead of re-paging. #212: a pump a person switched off (the Pi's
 * per-pump deliberate_stop, in the hub frame shape the bridge sends: offline, Air-Water 2 OPEN) is not unserved or
 * faulted, closes what was open, and pages ONE reminder per stop when its stage is called 4 h into it; the "no heat"
 * helper. Run with: npx tsx planner/src/stagewatch.test.ts
 */
import assert from "node:assert/strict";
import { StageWatch, parseStagePumpMap, partitionRestore, calledStagesAllStopped, DEFAULT_STAGE_PUMP_MAP, STAGE_START_GRACE_MS, STOPPED_REMIND_MS, type StagePump, type StageEvent } from "./stagewatch";
import { episodeTier } from "./alertpolicy";

const t0 = Date.parse("2026-10-16T04:30:00Z");
const min = (m: number) => t0 + m * 60_000;
const hp1 = (state: string, extra: Partial<StagePump> = {}): StagePump => ({ id: "pump1", name: "Heat Pump 1", online: true, state, active_faults: 0, ...extra });
const hp2 = (state: string, extra: Partial<StagePump> = {}): StagePump => ({ id: "pump2", name: "Heat Pump 2", online: true, state, active_faults: 0, ...extra });
const E21 = { active_faults: 1, fault_codes: ["E21"] };

// ── 1. STAGE_PUMP_MAP parsing ────────────────────────────────────────────────────────────────────────────────────
assert.deepEqual(parseStagePumpMap(undefined), { map: { ...DEFAULT_STAGE_PUMP_MAP }, error: null });
assert.deepEqual(parseStagePumpMap('{"1":"pump2","2":"pump1"}'), { map: { "1": "pump2", "2": "pump1" }, error: null }, "a swapped wiring is honoured");
for (const bad of ["{", "[]", '{"0":"pump1"}', '{"1":""}', '{"one":"pump1"}', "{}",
  '{"1":"pump1"}', '{"1":"pump1","2":"pump1"}', '{"1":"pump1","3":"pump2"}']) {
  const r = parseStagePumpMap(bad);
  assert.deepEqual(r.map, { ...DEFAULT_STAGE_PUMP_MAP }, `bad ${bad} → default`);
  assert.match(r.error ?? "", /STAGE_PUMP_MAP ignored/);
}

// ── 2. REPLAY Oct 16 00:30–00:54 ET: stage 2 called, HP2 FAULT/E21, HP1 idle — pages within 10 min ──────────────────
{
  const w = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  const events: { at: number; e: StageEvent }[] = [];
  for (let m = 0; m <= 24; m += 5) {
    for (const e of w.step({ nowMs: min(m), stagesCalled: [false, true], pumps: [hp1("idle"), hp2("fault", E21)], lagTMin: 180 })) events.push({ at: m, e });
  }
  const fault = events.find((x) => x.e.type === "fault_called");
  const unserved = events.find((x) => x.e.type === "stage_unserved");
  assert.equal(fault?.at, 0, "fault-while-called pages at the first poll");
  assert.equal(fault?.e.priority, "high");
  assert.match(fault?.e.title ?? "", /Stage 2 called but Heat Pump 2 is FAULTED/);
  assert.match(fault?.e.body ?? "", /E21/);
  assert.ok(unserved && unserved.at <= 10, `stage-unserved pages within 10 min (at ${unserved?.at})`);
  assert.equal(unserved!.e.priority, "high");
  assert.match(unserved!.e.body, /Stage 2 called for 10 min but Heat Pump 2 is fault, E21 — not heating/);
  assert.match(unserved!.e.body, /Heat Pump 1 \(stage 1\) is not called — the HBX waits up to lagT \(180 min\)/);
  assert.equal(events.filter((x) => x.e.kind === "open").length, 2, "each edge pages once, not every poll");
  // 00:55 the owner power-cycles HP2: fault clears, it heats → both close (resolved)
  const after = w.step({ nowMs: min(25), stagesCalled: [false, true], pumps: [hp1("idle"), hp2("heating")], lagTMin: 180 });
  assert.deepEqual(after.map((e) => [e.kind, e.type]).sort(), [["close", "fault_called"], ["close", "stage_unserved"]]);
  assert.ok(after.every((e) => e.priority === "default"));
}

// ── 3. stage-2-only, pump2 FAULT, pump1 HEATING (the all-idle alarm is blind to this) → still pages ─────────────────
{
  const w = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  const ev: StageEvent[] = [];
  for (let m = 0; m <= 10; m += 5) ev.push(...w.step({ nowMs: min(m), stagesCalled: [false, true], pumps: [hp1("heating"), hp2("fault", E21)], lagTMin: 180 }));
  assert.deepEqual(ev.map((e) => e.type), ["fault_called", "stage_unserved"]);
}

// ── 4. both called, both heating → nothing; inside the grace → nothing ────────────────────────────────────────────
{
  const w = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  for (let m = 0; m <= 60; m += 5) assert.deepEqual(w.step({ nowMs: min(m), stagesCalled: [true, true], pumps: [hp1("heating"), hp2("heating")], lagTMin: 180 }), []);
  const g = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  for (let m = 0; m <= 5; m += 5) assert.deepEqual(g.step({ nowMs: min(m), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }), [], "a compressor start takes minutes");
  assert.equal(g.step({ nowMs: min(9), stagesCalled: [true, false], pumps: [hp1("heating"), hp2("idle")], lagTMin: 180 }).length, 0, "started inside the grace");
}

// ── 5. defrost SUSPENDS the clock (neither runs nor resets) ─────────────────────────────────────────────────────
{
  const w = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  // idle 0 → idle 5 (+5) → defrost 10–20 (suspended, the 5→10 interval that ENDED in defrost is not credited) → idle
  // 25 (resumes, credits nothing for the defrost interval) → idle 30 (+5 = 10 min) → page (codex pass 5)
  const seq = ["idle", "idle", "defrost", "defrost", "defrost", "idle"];
  const ev: { m: number; e: StageEvent }[] = [];
  seq.forEach((st, k) => { for (const e of w.step({ nowMs: min(k * 5), stagesCalled: [true, false], pumps: [hp1(st), hp2("idle")], lagTMin: 180 })) ev.push({ m: k * 5, e }); });
  assert.deepEqual(ev, [], "5 min before the defrost, nothing for the defrost or the interval leaving it");
  const more = w.step({ nowMs: min(30), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 });
  assert.equal(more.length, 1, "the clock resumed where it stood");
  assert.match(more[0].title, /Stage 1 called 10 min but Heat Pump 1 is not heating/);
  // codex pass 5: heating at 0, first idle at 10 → the 0–10 interval is NOT unserved; the clock starts at 10
  const hw = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  hw.step({ nowMs: min(0), stagesCalled: [true, false], pumps: [hp1("heating"), hp2("idle")], lagTMin: 180 });
  assert.deepEqual(hw.step({ nowMs: min(10), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }), [], "no credit for time spent heating");
  assert.deepEqual(hw.step({ nowMs: min(15), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }), []);
  assert.equal(hw.step({ nowMs: min(20), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }).length, 1, "10 min after the first idle observation");
}

// ── 6. unverifiable hub state (pumps null) or unknown stages: nothing moves, and the blind spell never counts ──────
{
  const w = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  w.step({ nowMs: min(0), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 });
  assert.deepEqual(w.step({ nowMs: min(5), stagesCalled: [true, false], pumps: null, lagTMin: 180 }), []);
  assert.deepEqual(w.step({ nowMs: min(60), stagesCalled: null, pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }), []);
  assert.deepEqual(w.step({ nowMs: min(65), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }), [], "the clock restarted after the blind spell");
  assert.equal(w.status()["1"].called_not_heating_min, 0);
}

// ── 7. stage released → episodes close; the swapped wiring maps stage 1 to pump2 ────────────────────────────────
{
  const w = new StageWatch({ "1": "pump2", "2": "pump1" });
  const ev: StageEvent[] = [];
  for (let m = 0; m <= 10; m += 5) ev.push(...w.step({ nowMs: min(m), stagesCalled: [true, false], pumps: [hp1("heating"), hp2("idle")], lagTMin: 60 }));
  assert.equal(ev.length, 1);
  assert.match(ev[0].body, /Heat Pump 2 is idle/, "stage 1 → pump2 under the swapped map");
  assert.match(ev[0].body, /lagT \(60 min\)/);
  const rel = w.step({ nowMs: min(15), stagesCalled: [false, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 60 });
  assert.deepEqual(rel.map((e) => [e.kind, e.type]), [["close", "stage_unserved"]]);
}

// ── 8. restore(): an episode open in the DB closes on clear, never re-pages; offline / missing pumps are not heating
{
  const w = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  w.restore([{ type: "stage_unserved", stage: "2" }, { type: "fault_called", stage: "2" }]);
  assert.deepEqual(w.step({ nowMs: min(0), stagesCalled: [false, true], pumps: [hp1("idle"), hp2("fault", E21)], lagTMin: 180 }), [], "still true → no duplicate page");
  assert.equal(w.step({ nowMs: min(5), stagesCalled: [false, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }).length, 2, "cleared → both close");
  const o = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  const ev: StageEvent[] = [];
  for (let m = 0; m <= 10; m += 5) ev.push(...o.step({ nowMs: min(m), stagesCalled: [true, false], pumps: [{ ...hp1("heating"), online: false }], lagTMin: null }));
  assert.equal(ev.length, 1, "an offline pump is not heating");
  assert.match(ev[0].body, /Heat Pump 1 is offline/);
  assert.match(ev[0].body, /lagT \(lagT\)|waits up to lagT/);
  assert.equal(STAGE_START_GRACE_MS, 600_000);
}

// ── 9. codex pass 1 — P17 anti-freeze (info) counts in the hub's active_faults but is NOT a fault; a skipped-poll gap
// credits no called time ─────────────────────────────────────────────────────────────────────────────────────────
{
  const w = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  for (let m = 0; m <= 30; m += 5) {
    assert.deepEqual(w.step({ nowMs: min(m), stagesCalled: [true, false], pumps: [hp1("heating", { active_faults: 1, fault_codes: [] }), hp2("idle")], lagTMin: 180 }), [],
      "heating with P17 active: no page");
  }
  // codex pass 2: a STALE mirror code (HP1's cleared E21 still in pump_snapshots) on a pump whose live state is not
  // fault never pages — codes only annotate a live fault
  const c = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  assert.deepEqual(c.step({ nowMs: min(0), stagesCalled: [true, false], pumps: [hp1("heating", { active_faults: 1, fault_codes: ["E21"] }), hp2("idle")], lagTMin: 180 }), []);
  assert.deepEqual(c.step({ nowMs: min(5), stagesCalled: [true, false], pumps: [hp1("heating"), hp2("fault", E21)], lagTMin: 180 }), [],
    "HP2 faulted but its stage is not called: nothing (yet)");
  // skipped polls: called at 0, then nothing until 60 min, then 65 → only 5 min credited, no page
  const g = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  g.step({ nowMs: min(0), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 });
  assert.deepEqual(g.step({ nowMs: min(60), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }), [], "an hour-long gap credits nothing");
  assert.deepEqual(g.step({ nowMs: min(65), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }), []);
  assert.equal(g.step({ nowMs: min(70), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }).length, 1, "10 min of OBSERVED call after the gap → page");
  // codex pass 6: a 10- or 15-min gap (one or two skipped polls) credits nothing either — it may hide a heating spell
  for (const skip of [10, 15]) {
    const q = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
    q.step({ nowMs: min(0), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 });
    assert.deepEqual(q.step({ nowMs: min(skip), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 }), [], `${skip}-min gap credits nothing`);
    assert.equal(q.status()["1"].called_not_heating_min, 0);
  }
  // a slightly late poll (6 min) still counts
  const late = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  late.step({ nowMs: min(0), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 });
  late.step({ nowMs: min(6), stagesCalled: [true, false], pumps: [hp1("idle"), hp2("idle")], lagTMin: 180 });
  assert.equal(late.status()["1"].called_not_heating_min, 6);
}

// ── 10. codex pass 10: after STAGE_PUMP_MAP is corrected, an open episode for the OLD unit is closed, not re-adopted
{
  const open = [
    { id: 1, kind: "fault_called", key: "1", pumpId: "pump1" },   // stage 1 now maps to pump2 → stale
    { id: 2, kind: "stage_unserved", key: "2", pumpId: "pump1" }, // stage 2 now maps to pump1 → keep
    { id: 3, kind: "span_local_stale", key: "span", pumpId: null }, // not a stage episode → keep
  ];
  const r = partitionRestore(open, { "1": "pump2", "2": "pump1" });
  assert.deepEqual(r.stale.map((o) => o.id), [1]);
  assert.deepEqual(r.keep.map((o) => o.id), [2, 3]);
  assert.deepEqual(partitionRestore(open, { "1": "pump1", "2": "pump2" }).stale.map((o) => o.id), [2]);
}

// ── 11. #212: a pump a PERSON switched off is a deliberate stop, not an unserved stage ─────────────────────────────────
{
  // the hub frame the bridge sends while Air-Water 2 is OPEN by a person: Modbus timed out (measured 2026-10-19), so
  // the pump is offline, and deliberate_stop carries the circuit and the Pi-clock time it went off
  const since = min(0) / 1000;
  const off2 = (atMin = 0): StagePump => ({ id: "pump2", name: "Heat Pump 2", online: false, state: "offline", active_faults: 0,
    deliberate_stop: { circuit: "Air-Water 2", since: since + atMin * 60, announced: true } });
  const w = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  const ev: { at: number; e: StageEvent }[] = [];
  const run = (from: number, to: number, called: boolean[], pumps: () => StagePump[]) => {
    for (let m = from; m <= to; m += 5) for (const e of w.step({ nowMs: min(m), stagesCalled: called, pumps: pumps(), lagTMin: 60 })) ev.push({ at: m, e });
  };
  // HBX rotation makes stage 2 the lead: stage 2 alone for the full lagT (60 min), HP1 idle → no unserved, no fault
  run(0, 60, [false, true], () => [hp1("idle"), off2()]);
  assert.deepEqual(ev, [], "a deliberately stopped pump's stage is never 'unserved'");
  assert.equal(w.status()["2"].pump_state, "switched off outside A2W");
  assert.equal(w.status()["2"].called_not_heating_min, 0);
  // 3 h 55 min into the stop, still nothing
  run(235, 235, [false, true], () => [hp1("idle"), off2()]);
  assert.deepEqual(ev, []);
  // 4 h into the stop with its stage called: ONE reminder
  run(240, 300, [false, true], () => [hp1("heating"), off2()]);
  assert.deepEqual(ev.map((x) => [x.at, x.e.kind, x.e.type]), [[240, "open", "stopped_reminder"]], "once per stop");
  const r = ev[0].e;
  assert.equal(r.priority, "high");
  assert.equal(episodeTier(r.type), "page", "a forgotten switch-off is the owner's to fix: a page");
  assert.match(r.title, /Heat Pump 2 is still switched off and the HBX is calling for it/);
  assert.match(r.body, /'Air-Water 2' breaker was switched off outside A2W at 12:30 AM \(4 h ago/);
  assert.match(r.body, /switch it back on/);
  assert.equal(w.remindersOpen(), true);
  // the call ends; nothing moves without seeing the pump
  run(305, 330, [false, false], () => []);
  assert.equal(ev.length, 1);
  // switched back on, no call (index.ts reads the hub while a reminder is open): the reminder closes
  run(335, 335, [false, false], () => [hp1("idle"), hp2("idle")]);
  assert.deepEqual(ev.slice(1).map((x) => [x.e.kind, x.e.type]), [["close", "stopped_reminder"]]);
  assert.match(ev[1].e.title, /Heat Pump 2 is switched back on/);
  assert.equal(w.remindersOpen(), false);
  // a NEW stop later gets its own reminder after another 4 h
  run(400, 400 + 235, [false, true], () => [hp1("heating"), off2(400)]);
  assert.equal(ev.length, 2);
  run(640, 640, [false, true], () => [hp1("heating"), off2(400)]);
  assert.deepEqual(ev.slice(2).map((x) => x.e.type), ["stopped_reminder"]);
}
{
  // episodes open when the person switches the pump off (E21, then switched off — maybe to power-cycle it by hand) close
  const w = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  const ev: StageEvent[] = [];
  for (let m = 0; m <= 15; m += 5) ev.push(...w.step({ nowMs: min(m), stagesCalled: [false, true], pumps: [hp1("idle"), hp2("fault", E21)], lagTMin: 60 }));
  assert.deepEqual(ev.map((e) => e.type), ["fault_called", "stage_unserved"]);
  const off = w.step({ nowMs: min(20), stagesCalled: [false, true], lagTMin: 60,
    pumps: [hp1("idle"), { id: "pump2", name: "Heat Pump 2", online: false, state: "offline", deliberate_stop: { circuit: "Air-Water 2", since: min(18) / 1000 } }] });
  assert.deepEqual(off.map((e) => [e.kind, e.type]).sort(), [["close", "fault_called"], ["close", "stage_unserved"]]);
  assert.ok(off.every((e) => /switched off outside A2W at 12:48 AM — a deliberate stop, not a fault/.test(e.body)));
  // a restart re-adopts an open reminder: never re-sent for the same stop, closed when the pump is back
  const r = new StageWatch({ ...DEFAULT_STAGE_PUMP_MAP });
  r.restore([{ type: "stopped_reminder", stage: "2" }]);
  const stopped = { id: "pump2", online: false, state: "offline", deliberate_stop: { since: min(0) / 1000 - 6 * 3600 } };
  assert.deepEqual(r.step({ nowMs: min(0), stagesCalled: [false, true], pumps: [hp1("idle"), stopped], lagTMin: 60 }), []);
  assert.deepEqual(r.step({ nowMs: min(5), stagesCalled: [false, true], pumps: [hp1("idle"), hp2("heating")], lagTMin: 60 }).map((e) => [e.kind, e.type]),
    [["close", "stopped_reminder"]]);
  // a reminder episode for the wrong unit after a STAGE_PUMP_MAP correction is stale like the others
  assert.deepEqual(partitionRestore([{ id: 9, kind: "stopped_reminder", key: "2", pumpId: "pump2" }], { "1": "pump2", "2": "pump1" }).stale.map((o) => o.id), [9]);
  assert.equal(STOPPED_REMIND_MS, 4 * 3_600_000);
}
{
  // the all-idle "no heat" check stands down only when EVERY called stage's pump is deliberately stopped
  const map = { ...DEFAULT_STAGE_PUMP_MAP };
  const off = (id: string): StagePump => ({ id, online: false, state: "offline", deliberate_stop: { since: 1 } });
  assert.equal(calledStagesAllStopped([false, true], map, [hp1("idle"), off("pump2")]), true, "stage 2 alone, HP2 switched off");
  assert.equal(calledStagesAllStopped([true, true], map, [hp1("idle"), off("pump2")]), false, "stage 1 called too: HP1 should heat");
  assert.equal(calledStagesAllStopped([true, true], map, [off("pump1"), off("pump2")]), true, "both switched off");
  assert.equal(calledStagesAllStopped([false, false], map, [off("pump1"), off("pump2")]), false, "no call");
  assert.equal(calledStagesAllStopped(null, map, [off("pump2")]), false, "unknown stages");
  assert.equal(calledStagesAllStopped([false, true], map, [hp1("idle"), hp2("offline", { online: false })]), false, "offline is not a stop");
  assert.equal(calledStagesAllStopped([false, true], map, [hp1("idle"), { ...off("pump2"), deliberate_stop: null }]), false);
  assert.equal(calledStagesAllStopped([false, true], map, [hp1("idle")]), false, "a pump missing from the frame is not a stop");
}

console.log("stagewatch.test.ts: all assertions passed");
