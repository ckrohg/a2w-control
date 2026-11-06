/**
 * @purpose Assertions for pumphealth.ts stage_never_called (#172): the tank more than 3 °F under the CURVE IN FORCE for
 * 2 h with HBX stage 2 never called opens one shadow episode; recovery or a stage-2 call closes it; a call anywhere in
 * the window, a deliberate stop (#212) or a lowering of the curve (setback) never opens it; stale, gappy or curve-less
 * data is "unknown" and moves nothing. The target is the curve, never a frozen SensorLinx report. #257 review: a window
 * without heat demand, or at/above the WWSD of the curve in force, is "not judged" — the HBX calls nothing then and a
 * coasting tank proves nothing — and only a verdict that judged ITS OWN data releases a re-adopted pump_* row for re-send.
 * Run with: npx tsx planner/src/pumphealth-stage2.test.ts
 */
import assert from "node:assert/strict";
import {
  PH, evaluateStageNeverCalled, PumpHealthWatch, parseLiveChecks, episodeKind, parseEpisodeKind, evaluatedChecks, pumpRetryAllowed,
  type TankReading, type CurveVersion, type StoppedPump, type Verdict, type CheckKind,
} from "./pumphealth";

const NOW = Date.parse("2026-11-01T12:00:00Z") / 1000; // 7:00 AM ET
// the curve at 32 °F outdoor: 130 + 32·(110 − 130)/60 = 119.3 °F
const CURVE = { dot: 0, wwsd: 60, dbt: 130, mbt: 110 };
const HOT = { dot: 0, wwsd: 60, dbt: 150, mbt: 130 }; // 139.3 °F at 32 °F — e.g. the soak before a lowering
const curves: CurveVersion[] = [{ ts: NOW - 10 * 3600, curve: CURVE }];

/** 5-min HBX polls covering the last 2 h 15 min, oldest first, at 32 °F outdoor under heat demand; stage 1 called, stage 2 not */
function series(tank: (k: number, n: number) => number, called: (k: number, n: number) => boolean[] = () => [true, false], n = 28, now = NOW,
  hd: (k: number, n: number) => boolean | null = () => true, outdoor: (k: number, n: number) => number = () => 32): TankReading[] {
  return Array.from({ length: n }, (_, k) => ({ ts: now - (n - 1 - k) * 300 - 7, tank_f: tank(k, n), outdoor_f: outdoor(k, n), stages_called: called(k, n), hd_active: hd(k, n) }));
}
const judge = (hbx: TankReading[], c: CurveVersion[] = curves, stopped: StoppedPump[] = [], now = NOW) =>
  evaluateStageNeverCalled("2", "pump2", hbx, c, stopped, now);

async function main(): Promise<void> {
  // ── 1. open: 2 h at 110 °F against a 119.3 °F curve, pump1 carrying stage 1 alone, stage 2 never called ───────────────
  const low = series(() => 110);
  {
    const v = judge(low);
    assert.equal(v.state, "tripped", v.reason);
    assert.equal(v.kind, "stage_never_called");
    assert.equal(v.metrics.target_f, 119.3, "the target is the curve's output at the poll's outdoor");
    assert.equal(v.metrics.below_f, 9.3);
    assert.equal(v.metrics.other_stage_called_pct, 100);
    assert.match(v.reason, /never called stage 2, while another stage was called 100 % .*one pump carried the recovery alone/);
    assert.match(v.reason, /not a deliberate stop .* not a setback .* not a data gap/, "the episode says in plain words what it is not");
    assert.match(v.reason, /heat demand was active and outdoor stayed below the curve's WWSD \(60 °F\) for all 2 h/, "…and that staging had reason to call");
    assert.equal(v.metrics.wwsd_f, 60, "the WWSD judged against is the curve in force's, not a constant");
    const w = new PumpHealthWatch({ pump2: "Heat Pump 2" });
    const e = w.step([v]);
    assert.equal(e.length, 1); assert.equal(e[0].kind, "open");
    assert.equal(e[0].title, "Heat Pump 2: tank below target for 2 h but never called");
    assert.match(e[0].body, /^Heat Pump 2 was never called: for 2 h the tank stayed 9\.3–9\.3 °F below the curve in force/);
    assert.deepEqual(w.step([judge(low)]), [], "still tripped → no second episode");
    assert.equal(w.status().pump2.stage_never_called.open, true, "/health.pump_health.checks shows it open");
  }
  // shadow plumbing: the kind round-trips like the other checks, and is shadow unless the owner promotes it
  assert.equal(episodeKind("stage_never_called", false), "shadow_pump_stage_never_called");
  assert.deepEqual(parseEpisodeKind("shadow_pump_stage_never_called"), { check: "stage_never_called", live: false });
  assert.equal(parseLiveChecks("").live.has("stage_never_called"), false, "shadow by default");
  assert.equal(parseLiveChecks("stage_never_called").error, null);

  // ── 2. below for less than 2 h, or within the 3 °F deadband → ok ─────────────────────────────────────────────────────
  {
    const late = judge(series((k, n) => (k < n - 22 ? 118 : 110))); // within 3 °F until 1 h 50 min ago
    assert.equal(late.state, "ok", late.reason);
    assert.match(late.reason, /within 3 °F of the curve in force .*below it for 110 min since/);
    const target = 130 + (32 * (110 - 130)) / 60;
    assert.equal(judge(series(() => target - PH.STAGE_IDLE_DEADBAND_F + 0.05)).state, "ok", "inside the 3 °F deadband is not 'below target'");
    assert.equal(judge(series(() => target - PH.STAGE_IDLE_DEADBAND_F - 0.05)).state, "tripped", "just past it is");
  }

  // ── 3. close: the tank recovers, or stage 2 is finally called ────────────────────────────────────────────────────────
  {
    const w = new PumpHealthWatch({ pump2: "Heat Pump 2" });
    assert.equal(w.step([judge(low)])[0].kind, "open");
    const recovered = judge(series((k, n) => (k === n - 1 ? 118 : 110)));
    assert.equal(recovered.state, "ok", recovered.reason);
    const c = w.step([recovered]);
    assert.equal(c.length, 1); assert.equal(c[0].kind, "close");
    assert.equal(c[0].title, "Heat Pump 2: tank below target for 2 h but never called cleared");

    const w2 = new PumpHealthWatch({ pump2: "Heat Pump 2" });
    w2.step([judge(low)]);
    const called = judge(series(() => 110, (k, n) => [true, k === n - 1]));
    assert.equal(called.state, "ok"); assert.match(called.reason, /^stage 2 was called at /);
    assert.equal(w2.step([called])[0].kind, "close", "a stage-2 call closes the episode");
  }

  // ── 4. stage 2 called at any point in the window → never opens ───────────────────────────────────────────────────────
  {
    const once = judge(series(() => 110, (k, n) => [true, k === n - 13])); // one poll, an hour ago
    assert.equal(once.state, "ok", once.reason);
    assert.match(once.reason, /stage 2 was called at \d+:\d\d (AM|PM)/);
    const w = new PumpHealthWatch();
    assert.deepEqual(w.step([once]), []);
    // the 2 h runs from the LAST call: a call 2 h 10 min ago is outside the window → trips
    assert.equal(judge(series(() => 110, (k) => [true, k === 1])).state, "tripped");
  }

  // ── 5. deliberate stop (#212): either pump switched off by a person → not judged; an open episode closes ─────────────
  {
    const stop: StoppedPump[] = [{ pumpId: "pump2", label: "Heat Pump 2", since: NOW - 3 * 3600 }];
    const v = judge(low, curves, stop);
    assert.equal(v.state, "ok", v.reason);
    assert.match(v.reason, /^not judged: Heat Pump 2 was switched off outside A2W at 4:00 AM\. That is a deliberate stop \(#212\)/);
    const w = new PumpHealthWatch({ pump2: "Heat Pump 2" });
    assert.deepEqual(w.step([v]), [], "never opens during a deliberate stop");
    w.step([judge(low)]);
    assert.equal(w.step([judge(low, curves, [{ pumpId: "pump1", label: "Heat Pump 1", since: NOW - 600 }])])[0].kind, "close",
      "pump1 switched off counts too: the missing capacity is the owner's choice");
  }

  // ── 6. stale or blind data → unknown, moves nothing ─────────────────────────────────────────────────────────────────
  {
    const w = new PumpHealthWatch({ pump2: "Heat Pump 2" });
    w.step([judge(low)]);
    const stale = judge(series(() => 110, undefined, 28, NOW - 20 * 60)); // SensorLinx stopped answering 20 min ago
    assert.equal(stale.state, "unknown"); assert.match(stale.reason, /newest HBX reading is 20 min old \(stale\)/);
    assert.deepEqual(w.step([stale]), [], "stale data never closes");
    assert.equal(w.isOpen("stage_never_called", "pump2"), true);

    const holey = low.filter((_, k) => k < 10 || k > 13); // a 25-min hole an hour ago
    const h = judge(holey);
    assert.equal(h.state, "unknown"); assert.match(h.reason, /gaps in the last 2 h \(blind\)/);
    const w2 = new PumpHealthWatch();
    assert.deepEqual(w2.step([h]), [], "a blind window never opens");

    assert.equal(judge([]).state, "unknown", "no readings");
    assert.equal(judge(low.map((x) => ({ ...x, outdoor_f: null }))).state, "unknown", "no outdoor → no curve output → blind");
    assert.equal(judge(low.map((x) => ({ ...x, stages_called: null }))).state, "unknown", "stage relays unknown → blind");
    const nocurve = judge(low, [{ ts: NOW - 3600, curve: CURVE }]);
    assert.equal(nocurve.state, "unknown", "the curve in force at the window's start is not known");
    assert.match(nocurve.reason, /curve in force is not known/);
  }

  // ── 7. the CURVE IN FORCE, not a frozen SensorLinx report; a lowering in the window is a setback ────────────────────
  {
    // lowered from the 139.3 °F soak curve 3 h ago: SensorLinx would still report ~139 °F, but the device is on 119.3.
    // A 121 °F tank is 18 °F below the old figure and only −1.7 °F off the curve in force → ok
    const afterSoak: CurveVersion[] = [{ ts: NOW - 10 * 3600, curve: HOT }, { ts: NOW - 3 * 3600, curve: CURVE }];
    const v = judge(series(() => 121), afterSoak);
    assert.equal(v.state, "ok", v.reason);
    assert.equal(v.metrics.target_f, 119.3);
    // the same lowering 40 min ago is INSIDE the window: a setback → not judged
    const setback: CurveVersion[] = [{ ts: NOW - 10 * 3600, curve: HOT }, { ts: NOW - 40 * 60, curve: CURVE }];
    const s = judge(series(() => 110), setback);
    assert.equal(s.state, "ok", s.reason);
    assert.match(s.reason, /^not judged: the curve in force was lowered at 6:20 AM \(139\.3 → 119\.3 °F at 32 °F outdoor\)\. That is a setback/);
    // a RAISE in the window is not a setback: the tank below the raised curve for 2 h with no stage 2 still trips
    const raise: CurveVersion[] = [{ ts: NOW - 10 * 3600, curve: CURVE }, { ts: NOW - 40 * 60, curve: HOT }];
    const r = judge(series(() => 110), raise);
    assert.equal(r.state, "tripped", r.reason);
    assert.equal(r.metrics.target_f, 139.3); assert.equal(r.metrics.min_below_f, 9.3); assert.equal(r.metrics.max_below_f, 29.3);
    // a re-write within 3 °F (e.g. a per-block set_target) is not a setback
    const nudge: CurveVersion[] = [{ ts: NOW - 10 * 3600, curve: CURVE }, { ts: NOW - 40 * 60, curve: { ...CURVE, dbt: 128, mbt: 108 } }];
    assert.equal(judge(series(() => 110), nudge).state, "tripped");
  }

  // ── 8. no other stage called either: still trips, and says so ───────────────────────────────────────────────────────
  {
    const v = judge(series(() => 110, () => [false, false]));
    assert.equal(v.state, "tripped"); assert.match(v.reason, /never called stage 2, nor any other stage/);
  }

  // ── 9. #257 finding 2: above the curve's WWSD the HBX calls nothing and the tank coasts → not judged, not tripped ───
  // 62 °F outdoor against a 60 °F WWSD: the curve clamps to its 110 °F minimum, the tank coasts 115 → 105 with nothing
  // called. Before the fix this was "tripped: half the capacity sat idle" — the "staging didn't call it (normal)" case
  // #172 asks to keep OUT of the record its promotion is judged on.
  {
    const coast = series((k, n) => 115 - (10 * k) / (n - 1), () => [false, false], 28, NOW, () => true, () => 62);
    const v = judge(coast);
    assert.equal(v.state, "ok", v.reason);
    assert.match(v.reason, /^not judged: 62 °F outdoor at \d+:\d\d (AM|PM) is at or above the warm-weather shutdown of the curve in force \(WWSD 60 °F\)/);
    assert.match(v.reason, /staging not calling it, which is normal, not missing capacity/);
    const w = new PumpHealthWatch({ pump2: "Heat Pump 2" });
    assert.deepEqual(w.step([v]), [], "a WWSD coast never opens an episode");
    // exactly at WWSD counts as shutdown too; one degree under it, the device is on its curve and a low tank is judged
    assert.equal(judge(series(() => 100, () => [false, false], 28, NOW, () => true, () => 60)).state, "ok");
    assert.match(judge(series(() => 100, () => [false, false], 28, NOW, () => true, () => 60)).reason, /warm-weather shutdown/);
    const under = judge(series(() => 100, () => [false, false], 28, NOW, () => true, () => 59));
    assert.equal(under.state, "tripped", under.reason);
    assert.equal(under.metrics.target_f, 110.3, "one degree under WWSD the curve is live (130 + 59·(110 − 130)/60)");
    // the WWSD is the curve in force's: with a 125 °F WWSD (what the planner writes) 62 °F outdoor is winter, and judged
    const planner: CurveVersion[] = [{ ts: NOW - 10 * 3600, curve: { dot: 26, wwsd: 125, dbt: 120, mbt: 118 } }];
    const p = judge(series(() => 105, () => [true, false], 28, NOW, () => true, () => 62), planner);
    assert.equal(p.state, "tripped", p.reason);
    assert.equal(p.metrics.wwsd_f, 125);
    // a single poll above WWSD in the window is enough: the HBX had an hour it could legitimately not call
    const brief = judge(series(() => 110, () => [true, false], 28, NOW, () => true, (k) => (k === 5 ? 61 : 32)));
    assert.equal(brief.state, "ok"); assert.match(brief.reason, /61 °F outdoor/);
    // an episode opened under demand in the cold closes when WWSD takes over — like a deliberate stop or a setback does
    const w2 = new PumpHealthWatch({ pump2: "Heat Pump 2" });
    assert.equal(w2.step([judge(low)])[0].kind, "open");
    const c = w2.step([judge(coast)]);
    assert.equal(c.length, 1); assert.equal(c[0].kind, "close"); assert.match(c[0].body, /^not judged: .*warm-weather shutdown/);
  }

  // ── 10. #257 finding 2: no heat demand → not judged (stale-target.ts: an idle device proves nothing); unknown → blind ──
  {
    const idle = judge(series(() => 110, () => [false, false], 28, NOW, () => false));
    assert.equal(idle.state, "ok", idle.reason);
    assert.match(idle.reason, /^not judged: no heat demand at \d+:\d\d (AM|PM) — the HBX calls no stage without demand, so an idle stage 2 proves nothing/);
    assert.deepEqual(new PumpHealthWatch().step([idle]), [], "a demand-less coast never opens an episode");
    // demand dropped for one poll an hour ago: the HBX had a legitimate reason not to call then → the window is not judged
    const dip = judge(series(() => 110, () => [true, false], 28, NOW, (k) => k !== 15));
    assert.equal(dip.state, "ok"); assert.match(dip.reason, /no heat demand at 5:59 AM/);
    // the demand flag missing is a data gap, not evidence either way: unknown moves nothing
    const w = new PumpHealthWatch({ pump2: "Heat Pump 2" });
    w.step([judge(low)]);
    const blank = judge(series(() => 110, () => [true, false], 28, NOW, (k) => (k === 20 ? null : true)));
    assert.equal(blank.state, "unknown"); assert.match(blank.reason, /heat-demand flag is missing .* \(blind\)/);
    assert.deepEqual(w.step([blank]), [], "a missing flag neither opens nor closes");
    assert.equal(w.isOpen("stage_never_called", "pump2"), true);
    // a stage-2 call still wins over everything: ok with the call's time, demand or not
    const calledNoDemand = judge(series(() => 110, (k, n) => [true, k === n - 2], 28, NOW, () => false));
    assert.match(calledNoDemand.reason, /^stage 2 was called at /);
    // and the real case — demand active, cold, tank falling, stage 2 never called — still trips (case 1 is this, re-stated)
    const real = judge(series((k, n) => 115 - (10 * k) / (n - 1), () => [true, false], 28, NOW, () => true, () => 20));
    assert.equal(real.state, "tripped", real.reason);
    assert.match(real.reason, /one pump carried the recovery alone and half the capacity sat idle/);
    assert.equal(real.metrics.outdoor_f, 20);
  }

  // ── 11. #257 finding 3: a re-adopted pump_* row is re-sent only once ITS check has judged its own data ──────────────
  // After a restart restoreAlertState re-adopts an open, unheard pump_idle_draw row. The first ticks see no fresh mirror
  // data (all mirror checks "unknown") but the HBX series is fine, so stage_never_called returns a verdict. One flag for
  // all of them let that verdict release the idle_draw row and alerts.retry re-paged it unevaluated.
  {
    const unk = (kind: CheckKind, pumpId = "pump1"): Verdict => ({ kind, pumpId, state: "unknown", reason: "newest mirror reading 400 s old", metrics: {} });
    const mirrorBlind: Verdict[] = [unk("running_no_lift"), unk("heating_no_draw"), unk("idle_draw"), unk("defrost_overlong"), unk("called_tank_flat"),
      unk("running_no_lift", "pump2"), unk("heating_no_draw", "pump2"), unk("idle_draw", "pump2"), unk("defrost_overlong", "pump2"), unk("called_tank_flat", "pump2")];
    const since = new Set<CheckKind>(); // index.ts's pumpEvaluatedSinceRestore: the union over the ticks since the restore
    for (const c of evaluatedChecks([...mirrorBlind, judge(low)])) since.add(c);
    assert.deepEqual([...since], ["stage_never_called"], "only the check whose data was judged counts");
    assert.equal(pumpRetryAllowed("pump_idle_draw", since), false, "the idle_draw row waits: no mirror check has looked yet");
    assert.equal(pumpRetryAllowed("pump_called_tank_flat", since), false);
    assert.equal(pumpRetryAllowed("pump_stage_never_called", since), true, "a promoted stage-2 row may go: its check judged");
    // the mirror comes back: idle_draw judges (ok — which closes the row instead of re-paging it) and is released
    const idleOk: Verdict = { kind: "idle_draw", pumpId: "pump1", state: "ok", reason: "draws 8 W", metrics: {} };
    for (const c of evaluatedChecks([idleOk, unk("running_no_lift"), unk("heating_no_draw"), unk("defrost_overlong"), unk("called_tank_flat")])) since.add(c);
    assert.equal(pumpRetryAllowed("pump_idle_draw", since), true);
    assert.equal(pumpRetryAllowed("pump_running_no_lift", since), false, "a sibling mirror check that is still unknown does not ride along");
    // the other way round: the HBX blind, the mirror fine → a stage-2 row is not released by mirror verdicts
    const hbxBlind = new Set<CheckKind>(evaluatedChecks([idleOk, judge(series(() => 110, undefined, 28, NOW - 20 * 60))]));
    assert.deepEqual([...hbxBlind], ["idle_draw"]);
    assert.equal(pumpRetryAllowed("pump_stage_never_called", hbxBlind), false);
    // a "not judged" (ok) stage-2 verdict IS a judgement: it closes the row rather than re-paging it, so it releases
    assert.equal(pumpRetryAllowed("pump_stage_never_called", evaluatedChecks([judge(series(() => 110, () => [false, false], 28, NOW, () => false))])), true);
    // nothing evaluated at all → nothing re-sent; a kind no check owns waits for any check
    assert.equal(pumpRetryAllowed("pump_idle_draw", evaluatedChecks(mirrorBlind)), false);
    assert.equal(pumpRetryAllowed("pump_retired_check", new Set()), false);
    assert.equal(pumpRetryAllowed("pump_retired_check", since), true);
  }

  console.log("pumphealth-stage2.test.ts: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
