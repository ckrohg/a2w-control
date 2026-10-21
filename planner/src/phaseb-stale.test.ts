/**
 * @purpose Phase B's operative term honours the #215 stale-report proof (stale-target.ts): when SensorLinx's report
 * is provably a frozen post-lowering snapshot, the curve in force's output leads instead of the report
 * (stale-slx-target-2026-10-19.md; identification-plan-vs-command-2026-10-20.md §5 item 5). The live case: Oct 19
 * 19:30 ET, report 139.9 °F from the 14:09 soak, device on the 120/118 curve (119.6 °F at 49 °F), tank 130 °F
 * coasting with no call — Phase B sent 63 °C for the evening; the pumps need 52 °C. Pure operativeLeadF first, then
 * runOnce end to end: the proven-stale case (the curve leads), the unproven cases (the report leads, byte-identical to
 * #222), a report BELOW the curve (the device-curve term leads either way), the device on a bank's flat line, the
 * plan / probe / device-curve terms still winning the max, read failures, flat mode, and the I1 consistency the
 * monitor in index.ts relies on (the setpoint sent always covers the operative term + margin).
 */
import assert from "node:assert/strict";
import { PhaseB, operativeLeadF, staleProofApplicable, commandedMidpointF, staleProofNote, computeTracking } from "./phaseb";
import { curveOutputF } from "./curve";
import type { RecentPoll } from "./stale-target";
import { DEFAULT_OPTS } from "./shadow";

const cToF = (c: number) => (c * 9) / 5 + 32;
const sendsFor = (targetF: number) => computeTracking(targetF, ["p"])[0].value_c;

const CURVE = { dot: 29, wwsd: 125, dbt: 120, mbt: 118 };                 // the Oct 19 stamped curve
const DEVICE = { ...CURVE, htDif: 4 };                                      // …as the device holds it (hbx_config_versions)
const BANK = { dot: 29, wwsd: 125, dbt: 129, mbt: 125, htDif: 4 };          // the afternoon bank's near-flat line
const AS_FOUND = { dot: 30, wwsd: 125, dbt: 141, mbt: 137, htDif: 4 };      // the as-found curve (a refused set_curve)
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const guard = { ts: hourAgo, tank_target_f: 135, outdoor_f: 48.8, reason: "winter guard: mimic HBX curve", shaped_curve: CURVE };
const floor = { ts: hourAgo, tank_target_f: 120, outdoor_f: 48.8, reason: "DHW window floor", shaped_curve: CURVE };
const soak = { ts: hourAgo, tank_target_f: 140, outdoor_f: 52, reason: "daily sanitize to 140°F = 60°C (I8 pasteurization, warmest hour)", sani: true, shaped_curve: CURVE };
const bank = { ts: hourAgo, tank_target_f: 128, outdoor_f: 52, reason: "afternoon bank to 128°F (warmest hour, 52°F outdoor)", bank: true, shaped_curve: CURVE };

const idle = (minAgo: number, tankF: number | null, o: Partial<RecentPoll> = {}): RecentPoll =>
  ({ ts: new Date(Date.now() - minAgo * 60_000), tankF, anyCall: false, hdActive: true, ...o });
/** the Oct 19 evening: three idle polls, demand present, tank 130 °F — below 139.9 − 3, above 119.6 − 3 */
const COASTING = [idle(10, 130.2), idle(5, 130.1), idle(0, 130.1)];

function harness(opts: {
  targetF: number; plan?: any[]; outdoorF?: number | null; deviceCurve?: Record<string, number> | null;
  recent?: RecentPoll[] | (() => Promise<RecentPoll[]>); shaped?: boolean; probeF?: number | null;
}) {
  const sends: Array<{ pump: string; c: number }> = [];
  const logs: string[] = [];
  let seriesReads = 0;
  const store = {
    getLatestSlx: async () => ({ ts: new Date(), targetF: opts.targetF, outdoorF: opts.outdoorF === undefined ? 49 : opts.outdoorF, tankF: 130.1 }),
    recentPlans: async () => [{ computedAt: new Date(), plan: opts.plan ?? [] }],
    insertPhaseBLog: async () => {},
    latestConfig: async () => (opts.deviceCurve === undefined ? DEVICE : opts.deviceCurve),
    getRecentSeries: async () => { seriesReads++; return typeof opts.recent === "function" ? opts.recent() : (opts.recent ?? []); },
  } as any;
  const hub = { sendSetpoint: async (pump: string, c: number) => { sends.push({ pump, c }); return { ok: true, detail: "" }; }, getState: async () => ({ pumps: [] }) } as any;
  const pb = new PhaseB(store, hub, ["pump1", "pump2"], false, async () => {}, opts.shaped ?? true, async () => true);
  if (opts.probeF !== undefined) pb.setProbeTarget(opts.probeF);
  const origLog = console.log;
  const run = async () => { console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); }; try { await pb.runOnce(); } finally { console.log = origLog; } };
  return { pb, sends, logs, run, reads: () => seriesReads };
}
/** I1 as index.ts checkI1 sees it: the setpoints the last cycle sent must cover its operative term + margin */
const assertI1 = (h: ReturnType<typeof harness>) => {
  for (const s of h.sends.slice(-2)) assert.ok(cToF(s.c) >= (h.pb.lastLead!.operative_f + DEFAULT_OPTS.i1MarginF) - 1e-9, `${s.c} °C covers operative ${h.pb.lastLead!.operative_f} + ${DEFAULT_OPTS.i1MarginF}`);
};

(async () => {
  const now = Date.now();
  const curveNow = Math.round(curveOutputF(CURVE, 49) * 10) / 10;
  assert.equal(curveNow, 119.6, "the 120/118 curve at 49 °F, 0.1 °F as writer.status() reports it");

  // ── operativeLeadF, pure ─────────────────────────────────────────────────────────────────────────────────────────
  // 1. the live case: a 139.9 report, the device on the 120/118 curve, three idle polls at 130 °F → the curve leads
  {
    assert.equal(commandedMidpointF(DEVICE), 119); assert.equal(commandedMidpointF(null), null); assert.equal(commandedMidpointF({ dbt: 120 }), null);
    assert.equal(staleProofApplicable(139.9, DEVICE), true, "139.9 sits 20.9 above the 119 command");
    assert.equal(staleProofApplicable(119.7, DEVICE), false, "within the 3 °F tolerance: nothing to prove");
    assert.equal(staleProofApplicable(122, DEVICE), false, "exactly at the tolerance is still adopted");
    assert.equal(staleProofApplicable(110, DEVICE), false, "a report BELOW the command: no idle proof exists for a raise");
    assert.equal(staleProofApplicable(139.9, null), false, "no config → no command to compare with");
    const op = operativeLeadF({ reportedF: 139.9, cfg: DEVICE, outdoorNowF: 49, recent: COASTING, nowMs: now });
    assert.equal(op.basis, "stale→curve"); assert.equal(op.f, 119.6, "the curve in force's output at the live outdoor");
    assert.deepEqual([op.reportedF, op.commandedF, op.curveNowF], [139.9, 119, 119.6]);
    assert.equal(op.verdict.kind, "stale");
    assert.match(staleProofNote(op.verdict) ?? "", /tank 130\.1 °F below the report's call threshold \(margin 3\.0 °F\) for 3 polls/);
    // no outdoor to evaluate at → the command (the midpoint) stands in, as in identify.ts
    const noOutdoor = operativeLeadF({ reportedF: 139.9, cfg: DEVICE, outdoorNowF: null, recent: COASTING, nowMs: now });
    assert.equal(noOutdoor.basis, "stale→curve"); assert.equal(noOutdoor.f, 119); assert.equal(noOutdoor.curveNowF, null);
    // the live differential sizes the margin: htDif 8 → 5 °F; the tank must sit below 134.9
    const wide = operativeLeadF({ reportedF: 139.9, cfg: { ...DEVICE, htDif: 8 }, outdoorNowF: 49, recent: [idle(10, 135.5), idle(5, 135.2), idle(0, 135.0)], nowMs: now });
    assert.equal(wide.basis, "report"); assert.match(staleProofNote(wide.verdict) ?? "", /is not below 134\.9/);
  }
  // 2. anything short of proof → the report leads, with the reason; not applicable → no reason at all
  {
    const cases: Array<[string, RecentPoll[], RegExp]> = [
      ["no polls", [], /needs 3 idle polls/],
      ["two polls", [idle(5, 130.1), idle(0, 130.1)], /have 2/],
      ["a stage called", [idle(10, 141.0, { anyCall: true }), idle(5, 141.3), idle(0, 140.7)], /a stage was called/],
      ["no heat demand", [idle(10, 130.2), idle(5, 130.1, { hdActive: false }), idle(0, 130.1)], /no heat demand/],
      ["tank still above the report's threshold", [idle(10, 138.0), idle(5, 137.5), idle(0, 137.0)], /is not below 136\.9/],
      ["tank below the command's own threshold", [idle(10, 115.0), idle(5, 114.5), idle(0, 114.0)], /below the command's own call threshold 116\.6/],
      ["polls not consecutive", [idle(40, 130.2), idle(25, 130.1), idle(0, 130.1)], /span 40 min/],
      ["no tank reading", [idle(10, 130.2), idle(5, null), idle(0, 130.1)], /no tank reading/],
    ];
    for (const [name, recent, why] of cases) {
      const op = operativeLeadF({ reportedF: 139.9, cfg: DEVICE, outdoorNowF: 49, recent, nowMs: now });
      assert.equal(op.basis, "report", name); assert.equal(op.f, 139.9, name);
      assert.equal(op.verdict.kind, "unproven", name); assert.match(staleProofNote(op.verdict) ?? "", why, name);
    }
    const adopted = operativeLeadF({ reportedF: 119.7, cfg: DEVICE, outdoorNowF: 49, recent: COASTING, nowMs: now });
    assert.deepEqual([adopted.basis, adopted.f, adopted.verdict.kind, staleProofNote(adopted.verdict)], ["report", 119.7, "not_applicable", null]);
    const noCfg = operativeLeadF({ reportedF: 139.9, cfg: null, outdoorNowF: 49, recent: COASTING, nowMs: now });
    assert.deepEqual([noCfg.basis, noCfg.f, noCfg.commandedF, noCfg.curveNowF, noCfg.verdict.kind], ["report", 139.9, null, null, "not_applicable"]);
  }
  // 3. a report BELOW the curve (the odd exact 110 °F reports, a raise not yet reported): never "stale" — the report is
  //    the operative term, and the device-curve term of the max covers the curve. An idle series changes nothing.
  {
    const op = operativeLeadF({ reportedF: 110, cfg: DEVICE, outdoorNowF: 49, recent: [idle(10, 112), idle(5, 111.5), idle(0, 111)], nowMs: now });
    assert.deepEqual([op.basis, op.f, op.verdict.kind], ["report", 110, "not_applicable"]);
  }

  // ── runOnce, end to end ───────────────────────────────────────────────────────────────────────────────────────────
  // 4. the Oct 19 evening on the winter-guard hour: 52 °C instead of 63, every term on /health
  {
    const h = harness({ targetF: 139.9, plan: [guard], recent: COASTING });
    await h.run();
    assert.deepEqual(h.sends, [{ pump: "pump1", c: 52 }, { pump: "pump2", c: 52 }]);
    assert.equal(sendsFor(139.9), 63, "what the frozen report sent");
    const lead = h.pb.lastLead!;
    assert.equal(lead.operative_basis, "stale→curve"); assert.equal(lead.operative_f, 119.6); assert.equal(lead.reported_f, 139.9);
    assert.match(lead.stale_proof ?? "", /for 3 polls with demand and no call — the device is on the curve in force/);
    assert.equal(lead.effective_f, 120, "the plan's command for the guard hour (120) is the max");
    assert.equal(lead.plan_basis, "curve"); assert.equal(lead.plan_f, 120); assert.equal(lead.device_curve_f, 119.6);
    assert.equal(h.reads(), 1, "one series read, the proof being applicable");
    assertI1(h);
    assert.equal(h.logs.filter((l) => /provably frozen/.test(l)).length, 1, "the flip is logged once…");
    await h.run();
    assert.equal(h.logs.filter((l) => /provably frozen/.test(l)).length, 1, "…not every cycle");
    assert.match(h.pb.lastResults.pump1, /^ok 52°C/);
  }
  // 5. the same evening with NO plan block: the curve alone leads — 119.6 + 5 → 52 °C — and the proof ends when a
  //    call starts (the call refreshes the report): back to the report, logged once
  {
    const polls: RecentPoll[][] = [COASTING, [idle(10, 130.1), idle(5, 129.9), idle(0, 118.0, { anyCall: true })]];
    const h = harness({ targetF: 139.9, recent: async () => polls.shift() ?? [] });
    await h.run();
    assert.deepEqual(h.sends.map((s) => s.c), [52, 52]);
    assert.equal(h.pb.lastLead?.effective_f, 119.6);
    await h.run();
    assert.deepEqual(h.sends.slice(2).map((s) => s.c), [63, 63], "an unproven report wins again");
    assert.equal(h.pb.lastLead?.operative_basis, "report"); assert.match(h.pb.lastLead?.stale_proof ?? "", /a stage was called/);
    assert.equal(h.logs.filter((l) => /leading the SensorLinx report again/.test(l)).length, 1);
    assertI1(h);
  }
  // 6. unproven → byte-identical to #222: the same sends, the same result strings, with or without any series at all
  {
    const noPolls = harness({ targetF: 139.9, plan: [guard], recent: [] });
    await noPolls.run();
    const broken = harness({ targetF: 139.9, plan: [guard], recent: async () => { throw new Error("db blip"); } });
    await broken.run();
    const noCfg = harness({ targetF: 139.9, plan: [guard], deviceCurve: null, recent: COASTING });
    await noCfg.run();
    for (const h of [noPolls, broken, noCfg]) {
      assert.deepEqual(h.sends.map((s) => s.c), [63, 63]);
      assert.equal(h.pb.lastResults.pump1, "ok 63°C (lease 90m requested)");
      assert.equal(h.pb.lastLead?.operative_basis, "report"); assert.equal(h.pb.lastLead?.operative_f, 139.9); assert.equal(h.pb.lastLead?.effective_f, 139.9);
    }
    assert.match(broken.pb.lastLead?.stale_proof ?? "", /needs 3 idle polls/, "a failed series read is unproven, never an exception");
    assert.equal(noCfg.reads(), 0, "no config → no command → nothing to prove, no series read");
    assert.equal(noCfg.pb.lastLead?.device_curve_f, null);
    // an adopted report: no series read at all (the common case)
    const adopted = harness({ targetF: 119.7, plan: [guard], recent: COASTING });
    await adopted.run();
    assert.deepEqual(adopted.sends.map((s) => s.c), [52, 52]); assert.equal(adopted.reads(), 0);
    assert.deepEqual([adopted.pb.lastLead?.operative_basis, adopted.pb.lastLead?.stale_proof], ["report", null]);
    assert.equal(adopted.logs.length, 0, "no basis-flip log on a first cycle that leads the report");
  }
  // 7. a report BELOW the curve, end to end: the device-curve term leads in shaped mode — 52 °C whether the report
  //    reads 110 or 119.7; in flat mode (no device-curve term) the report leads as it always has
  {
    const low = harness({ targetF: 110, recent: [idle(10, 112), idle(5, 111.5), idle(0, 111)] });
    await low.run();
    assert.deepEqual(low.sends.map((s) => s.c), [52, 52]);
    assert.deepEqual([low.pb.lastLead?.operative_basis, low.pb.lastLead?.operative_f, low.pb.lastLead?.device_curve_f, low.pb.lastLead?.effective_f], ["report", 110, 119.6, 119.6]);
    assert.equal(low.reads(), 0, "a raise is never a stale-report question");
    assertI1(low);
    const flat = harness({ targetF: 110, shaped: false, recent: [idle(10, 112), idle(5, 111.5), idle(0, 111)] });
    await flat.run();
    assert.deepEqual(flat.sends.map((s) => s.c), [sendsFor(110), sendsFor(110)], "flat mode is untouched: the report leads");
  }
  // 8. the device on the bank's flat line (129/125) with the soak's 139.9 still reported: the operative term is the
  //    line's output (128.2 at 49 °F) → 57 °C, not 63; the bank block in force leads 128 flat beside it
  {
    const h = harness({ targetF: 139.9, plan: [bank], deviceCurve: BANK, recent: COASTING });
    await h.run();
    const lineF = Math.round(curveOutputF(BANK, 49) * 10) / 10;
    assert.equal(lineF, 128.2);
    assert.deepEqual(h.sends.map((s) => s.c), [57, 57]);
    assert.deepEqual([h.pb.lastLead?.operative_basis, h.pb.lastLead?.operative_f, h.pb.lastLead?.plan_f, h.pb.lastLead?.effective_f], ["stale→curve", 128.2, 128, 128.2]);
    assertI1(h);
  }
  // 9. the other terms still win the max over a proven-stale report: the soak in force (63 °C), a probe at 130
  //    (58 °C), the device on the as-found curve (its own output; the report is adopted there, nothing to prove)
  {
    const s = harness({ targetF: 139.9, plan: [soak], recent: COASTING });
    await s.run();
    assert.deepEqual(s.sends.map((s) => s.c), [63, 63]); assert.equal(s.pb.lastLead?.operative_basis, "stale→curve"); assert.equal(s.pb.lastLead?.effective_f, 140);
    const p = harness({ targetF: 139.9, plan: [floor], probeF: 130, recent: COASTING });
    await p.run();
    assert.deepEqual(p.sends.map((s) => s.c), [58, 58]); assert.equal(p.pb.lastLead?.effective_f, 130);
    const a = harness({ targetF: 139.9, plan: [floor], deviceCurve: AS_FOUND, recent: COASTING });
    await a.run();
    const asFoundF = Math.round(curveOutputF(AS_FOUND, 49) * 10) / 10;
    assert.equal(a.pb.lastLead?.operative_basis, "report", "139.9 vs the as-found midpoint 139: adopted");
    assert.deepEqual(a.sends.map((s) => s.c), [sendsFor(Math.max(139.9, asFoundF)), sendsFor(Math.max(139.9, asFoundF))]);
    // …and a report ABOVE even the as-found curve, proven stale, leads the as-found output — never below the device
    const above = harness({ targetF: 145, plan: [floor], deviceCurve: AS_FOUND, recent: [idle(10, 139.0), idle(5, 138.8), idle(0, 138.5)] });
    await above.run();
    assert.equal(above.pb.lastLead?.operative_basis, "stale→curve"); assert.equal(above.pb.lastLead?.operative_f, asFoundF);
    assert.deepEqual(above.sends.map((s) => s.c), [sendsFor(asFoundF), sendsFor(asFoundF)]);
    assertI1(above);
  }
  // 10. flat mode (SHAPED_CURVE off): the proof is about the device, not the flag — the frozen 139.9 over the 129/125
  //     line still gives way to the line's output; unproven stays byte-identical
  {
    const h = harness({ targetF: 139.9, shaped: false, deviceCurve: BANK, recent: COASTING });
    await h.run();
    assert.deepEqual(h.sends.map((s) => s.c), [57, 57]);
    assert.deepEqual([h.pb.lastLead?.operative_basis, h.pb.lastLead?.device_curve_f], ["stale→curve", null]);
    const u = harness({ targetF: 139.9, shaped: false, deviceCurve: BANK, recent: [] });
    await u.run();
    assert.deepEqual(u.sends.map((s) => s.c), [63, 63]);
  }
  // 11. no fresh report → no tracking, no proof attempted
  {
    const h = harness({ targetF: 139.9, recent: COASTING });
    (h.pb as any).store.getLatestSlx = async () => null;
    await h.run();
    assert.deepEqual(h.sends, []); assert.equal(h.pb.lastLead, null); assert.equal(h.reads(), 0);
  }
  console.log("phaseb-stale.test.ts (the operative term honours the stale-report proof): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
