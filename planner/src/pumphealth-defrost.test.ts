/**
 * @purpose Assertions for pumphealth.ts defrost_overlong retuned to count ONLY while the pump's mapped HBX stage calls
 * (owner 2026-11-10, from the 2026-11-09 weekly review): all 5 shadow episodes Oct 31–Nov 2 were an idle pump still
 * reporting "defrost" after its call ended (~55 W, ΔT ≈ 0); the one real stuck defrost (pump1, Oct 18 02:07Z, 82 min)
 * was called throughout. Pins: called throughout + 13 min of defrost trips; an idle-hold defrost (not called) is ok; a
 * call that ends 5 min into the defrost is ok; missing or gappy stage data is unknown, never tripped; the reported
 * minutes are minutes of CALLED defrost. Synthetic 60-s readings, 25-s SPAN (NEGATIVE watts), 5-min HBX polls.
 * Run with: npx tsx planner/src/pumphealth-defrost.test.ts
 */
import assert from "node:assert/strict";
import { PH, evaluatePump, PumpHealthWatch, type PumpReading, type SpanSample, type TankReading, type Verdict } from "./pumphealth";

const T0 = Date.parse("2026-10-18T02:07:00Z") / 1000; // defrost starts (10-17 22:07 ET)

/** pump1: heating 40 min before T0, then `state` from T0 on; inlet/outlet per phase */
function pump(state: "defrost", idleHold: boolean, end = T0 + 90 * 60): { rd: PumpReading[]; sp: SpanSample[] } {
  const rd: PumpReading[] = [], sp: SpanSample[] = [];
  for (let ts = T0 - 40 * 60; ts <= end; ts += 60) {
    const on = ts < T0;
    // stuck defrost while called draws ~216 W and pulls heat out; the idle hold sits at standby ~55 W with ΔT 0
    rd.push({ ts, online: true, state: on ? "heating" : state, inlet_c: 40, outlet_c: on ? 44 : idleHold ? 40 : 39.5, ambient_c: -2 });
  }
  for (let ts = T0 - 40 * 60; ts <= end; ts += 25) sp.push({ ts, power_w: ts < T0 ? -4500 : idleHold ? -55 : -216 });
  return { rd, sp };
}
/** 5-min HBX polls from T0 − 60 min, stage 1 called when `called(ts)` */
const hbx = (called: (ts: number) => boolean, end = T0 + 90 * 60): TankReading[] => {
  const out: TankReading[] = [];
  for (let ts = T0 - 60 * 60 + 7; ts <= end; ts += 300) out.push({ ts, tank_f: 118, stages_called: [called(ts), false] });
  return out;
};
const defrost = (v: Verdict[]) => v.find((x) => x.kind === "defrost_overlong")!;
const judge = (rd: PumpReading[], sp: SpanSample[], tank: TankReading[] | null, now: number) =>
  defrost(evaluatePump("pump1", rd.filter((r) => r.ts <= now), sp.filter((s) => s.ts <= now), now,
    tank ? { stage: "1", tank: tank.filter((x) => x.ts <= now) } : null));

async function main(): Promise<void> {
  // ── 1. Oct 18 model: stage 1 called throughout, defrost 13 min → tripped ───────────────────────────────────────────
  {
    const { rd, sp } = pump("defrost", false);
    const tank = hbx(() => true);
    const v = judge(rd, sp, tank, T0 + 13 * 60);
    assert.equal(v.state, "tripped", v.reason);
    assert.equal(v.metrics.defrost_min, 13);
    assert.match(v.reason, /reports defrost continuously for 13 min while HBX stage 1 calls/);
    assert.equal(judge(rd, sp, tank, T0 + 11 * 60).state, "ok", "11 min of defrost is inside the 12-min threshold");
    // the 82-min spell: one episode, and it stays open while the stage calls
    const w = new PumpHealthWatch({ pump1: "Heat Pump 1" });
    let opens = 0;
    for (let now = T0 + 5 * 60; now <= T0 + 82 * 60; now += 300) opens += w.step([judge(rd, sp, tank, now)]).filter((e) => e.kind === "open").length;
    assert.equal(opens, 1);
    assert.equal(w.isOpen("defrost_overlong", "pump1"), true);
  }

  // ── 2. Idle hold (Oct 31–Nov 2): the call ended, the pump reports defrost for 30 min at ~55 W, ΔT 0 → ok ──────────────
  {
    const { rd, sp } = pump("defrost", true);
    const tank = hbx((ts) => ts < T0);
    const w = new PumpHealthWatch({ pump1: "Heat Pump 1" });
    for (let now = T0 + 5 * 60; now <= T0 + 30 * 60; now += 60) {
      const all = evaluatePump("pump1", rd.filter((r) => r.ts <= now), sp.filter((s) => s.ts <= now), now, { stage: "1", tank: tank.filter((x) => x.ts <= now) });
      assert.notEqual(defrost(all).state, "tripped", `idle hold never trips (${new Date(now * 1000).toISOString()})`);
      assert.ok(all.every((x) => x.state !== "tripped"), "no other check trips on an idle hold either");
      assert.deepEqual(w.step(all), []);
    }
    const v = judge(rd, sp, tank, T0 + 30 * 60);
    assert.equal(v.state, "ok", v.reason);
    assert.match(v.reason, /defrost reported while its HBX stage is not calling \(idle hold, not a stuck defrost\)/);
  }

  // ── 3. Called for the first 5 min of the defrost, then the call ends and the defrost continues → ok ───────────────────
  {
    const { rd, sp } = pump("defrost", false);
    const tank = hbx((ts) => ts < T0 + 5 * 60);
    for (let now = T0 + 12 * 60; now <= T0 + 60 * 60; now += 60) {
      const v = judge(rd, sp, tank, now);
      assert.equal(v.state, "ok", `${(now - T0) / 60} min: ${v.reason}`);
    }
    assert.match(judge(rd, sp, tank, T0 + 30 * 60).reason, /idle hold/);
  }

  // ── 4. Stage-call data missing or not covering the window → unknown, never tripped ─────────────────────────────────────
  {
    const { rd, sp } = pump("defrost", false);
    const now = T0 + 30 * 60;
    const none = judge(rd, sp, null, now);
    assert.equal(none.state, "unknown", "no mapped stage → unknown");
    assert.match(none.reason, /no HBX stage maps to this pump/);
    assert.equal(judge(rd, sp, [], now).state, "unknown", "empty HBX series → unknown");
    assert.equal(evaluatePump("pump1", rd.filter((r) => r.ts <= now), sp.filter((s) => s.ts <= now), now).find((x) => x.kind === "defrost_overlong")!.state,
      "unknown", "the parameter omitted → unknown");
    const stale = hbx(() => true).filter((x) => x.ts <= now - 10 * 60);
    assert.equal(judge(rd, sp, stale, now).state, "unknown", "HBX polls stop 10 min before now → unknown");
    const noFlags = hbx(() => true).map((x) => ({ ...x, stages_called: null }));
    assert.equal(judge(rd, sp, noFlags, now).state, "unknown", "polls without stages_called → unknown");
    // without HBX data a pump that is NOT in defrost is still judged ok (the stage data only matters for a long defrost)
    const { rd: h, sp: hs } = pump("defrost", false, T0 - 60);
    assert.equal(judge(h, hs, null, T0 - 60).state, "ok");
  }

  // ── 5. The minutes reported are minutes of CALLED defrost ──────────────────────────────────────────────────────────────
  {
    // defrost from T0 while idle; the stage starts calling 10 min in (poll at T0+10:07); at T0+25 the window is all called
    const { rd, sp } = pump("defrost", false);
    const tank = hbx((ts) => ts >= T0 + 10 * 60);
    const v = judge(rd, sp, tank, T0 + 25 * 60);
    assert.equal(v.state, "tripped", v.reason);
    assert.equal(v.metrics.defrost_min, 14, "counts from the first reading under a called poll (T0+11), not from T0");
    assert.ok((v.metrics.defrost_min as number) * 60 >= PH.DEFROST_OVERLONG_S);
  }
  console.log("pumphealth-defrost: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
