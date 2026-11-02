/**
 * @purpose Assertions for pumphealth.ts stage_never_called (#172): the tank more than 3 °F under the CURVE IN FORCE for
 * 2 h with HBX stage 2 never called opens one shadow episode; recovery or a stage-2 call closes it; a call anywhere in
 * the window, a deliberate stop (#212) or a lowering of the curve (setback) never opens it; stale, gappy or curve-less
 * data is "unknown" and moves nothing. The target is the curve, never a frozen SensorLinx report.
 * Run with: npx tsx planner/src/pumphealth-stage2.test.ts
 */
import assert from "node:assert/strict";
import {
  PH, evaluateStageNeverCalled, PumpHealthWatch, parseLiveChecks, episodeKind, parseEpisodeKind,
  type TankReading, type CurveVersion, type StoppedPump,
} from "./pumphealth";

const NOW = Date.parse("2026-11-01T12:00:00Z") / 1000; // 7:00 AM ET
// the curve at 32 °F outdoor: 130 + 32·(110 − 130)/60 = 119.3 °F
const CURVE = { dot: 0, wwsd: 60, dbt: 130, mbt: 110 };
const HOT = { dot: 0, wwsd: 60, dbt: 150, mbt: 130 }; // 139.3 °F at 32 °F — e.g. the soak before a lowering
const curves: CurveVersion[] = [{ ts: NOW - 10 * 3600, curve: CURVE }];

/** 5-min HBX polls covering the last 2 h 15 min, oldest first, at 32 °F outdoor; stage 1 called, stage 2 not */
function series(tank: (k: number, n: number) => number, called: (k: number, n: number) => boolean[] = () => [true, false], n = 28, now = NOW): TankReading[] {
  return Array.from({ length: n }, (_, k) => ({ ts: now - (n - 1 - k) * 300 - 7, tank_f: tank(k, n), outdoor_f: 32, stages_called: called(k, n) }));
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

  console.log("pumphealth-stage2.test.ts: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
