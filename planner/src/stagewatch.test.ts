/**
 * @purpose Assertions for the per-stage unserved-call alarm (#185, stagewatch.ts). Replays Oct 16 00:30–00:54 ET
 * (04:30–04:54Z: stage 2 called, HP2 FAULT/E21, HP1 idle, lagT 180) and pins: the fault-while-called page at once, the
 * stage-unserved page within 10 min naming the unit, its state, the code and lagT; stage-2-only with pump2 FAULT and
 * pump1 heating still pages; both heating → none; inside the grace → none; defrost suspends the clock; unverifiable
 * hub state moves nothing; restore() closes instead of re-paging. Run with: npx tsx planner/src/stagewatch.test.ts
 */
import assert from "node:assert/strict";
import { StageWatch, parseStagePumpMap, DEFAULT_STAGE_PUMP_MAP, STAGE_START_GRACE_MS, type StagePump, type StageEvent } from "./stagewatch";

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

console.log("stagewatch.test.ts: all assertions passed");
