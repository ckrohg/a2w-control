/**
 * @purpose node:assert checks for scripts/element-calibration.ts on synthetic data: a 3.0 kWh burst into a 917 BTU/°F
 * tank losing 2 °F/h must give C_eff back within 2 % (with and without a 4-min sensor lag), and a single-pump segment
 * built from a known 30 L/min PG50 flow must give that flow back. No database, no network.
 *
 * Run from the repo root:  node --import ./hub/node_modules/tsx/dist/loader.mjs scripts/element-calibration.test.ts
 *            or planner/:  npx tsx ../scripts/element-calibration.test.ts
 */
import assert from "node:assert/strict";
import {
  BTU_PER_KWH, PG50_KJ_PER_L_K, WATER_KJ_PER_L_K, PG50_FACTOR, RATED_FLOW_L_MIN,
  trapezoidKwh, findBurst, fitLine, projectLine, deltaT, cEffBtuPerF,
  findSinglePumpSegments, segmentFlow, cleanest, quantile, type PowerSample, type TankSample, type PumpSample,
} from "./element-calibration";

const within = (got: number, want: number, relTol: number, what: string) =>
  assert.ok(Math.abs(got - want) <= relTol * Math.abs(want), `${what}: got ${got}, want ${want} ±${(relTol * 100).toFixed(1)} %`);

// ---- constants -------------------------------------------------------------------------------------------------
within(PG50_KJ_PER_L_K, 3.7202, 1e-6, "PG50 volumetric heat capacity");
assert.equal(PG50_FACTOR, 0.89);
within(RATED_FLOW_L_MIN, 35.33, 1e-3, "rated flow");

// ---- the synthetic night -----------------------------------------------------------------------------------------
// 917 BTU/°F tank (110 gal) at 120 °F, losing 2 °F/h, hit with 15 kW for 12 min (3.0 kWh) one hour in.
const C_TRUE = 917, STANDBY_F_PER_H = 2, P_W = 15_000, T_ON = 3600, T_OFF = 3600 + 720, T0 = 1_700_000_000;
const E_TRUE_KWH = (P_W * (T_OFF - T_ON)) / 3600 / 1000; // 3.0
const DT_TRUE = (E_TRUE_KWH * BTU_PER_KWH) / C_TRUE; // 11.16 °F
const deliveredKwh = (t: number) => (P_W * Math.min(Math.max(t - T_ON, 0), T_OFF - T_ON)) / 3600 / 1000;
const trueTank = (t: number) => 120 - (STANDBY_F_PER_H * t) / 3600 + (deliveredKwh(t) * BTU_PER_KWH) / C_TRUE;

const power: PowerSample[] = [];
for (let t = 0; t <= 2.5 * 3600; t += 30) power.push({ ts: T0 + t, power_w: t >= T_ON && t < T_OFF ? P_W : 45 });
// a null sample and a small pre-burst blip the threshold must ignore
power[10].power_w = null;
power[20].power_w = 800;

const burst = findBurst(power);
assert.ok(burst, "burst found");
assert.equal(burst.runsFound, 1, "an 800 W blip is not a burst");
assert.equal(burst.start, T0 + T_ON);
assert.equal(burst.end, T0 + T_OFF - 30);
assert.deepEqual(burst.bracketed, [true, true]);
within(burst.kwh, E_TRUE_KWH, 0.005, "burst kWh (bracketed trapezoid)");
assert.equal(burst.peakW, P_W);
assert.equal(burst.maxGapS, 30);

// SPAN reports consumption as negative W on this panel: the sign must not matter
{
  const neg = findBurst(power.map((p) => ({ ...p, power_w: p.power_w == null ? null : -p.power_w })));
  assert.ok(neg);
  assert.equal(neg.start, burst.start);
  assert.equal(neg.end, burst.end);
  within(neg.kwh, burst.kwh, 1e-12, "negative-signed series integrates to the same kWh");
  assert.equal(neg.peakW, P_W);
}

// trapezoid on its own: a ramp 0→1000 W over an hour is 0.5 kWh
within(trapezoidKwh([{ ts: 0, power_w: 0 }, { ts: 3600, power_w: 1000 }]), 0.5, 1e-9, "trapezoid");

// instantaneous sensor
const tank: TankSample[] = [];
for (let t = 0; t <= 2.5 * 3600; t += 300) tank.push({ ts: T0 + t, tank_f: trueTank(t) });
{
  const d = deltaT(tank, burst);
  assert.equal(d.nPre, 13, "60 min of 5-min samples before the burst (inclusive)");
  assert.ok(d.nPost >= 8, `post window has ${d.nPost} samples`);
  assert.ok(d.pre && d.post);
  within(d.pre.slopePerHr, -STANDBY_F_PER_H, 1e-6, "pre slope is the standby loss");
  within(d.post.slopePerHr, -STANDBY_F_PER_H, 1e-6, "post slope is the standby loss");
  assert.ok(d.rawF != null && d.rawF < DT_TRUE, `raw ΔT ${d.rawF} must read LOW (standby during the burst)`);
  within(d.correctedF as number, DT_TRUE, 1e-6, "corrected ΔT, no lag");
  within(cEffBtuPerF(burst.kwh, d.correctedF as number), C_TRUE, 0.02, "C_eff, no lag");
}

// a first-order sensor lag (τ = 4 min) smears the step; the 20-min post skip must still recover C_eff within 2 %
{
  const TAU = 240;
  const lagged: TankSample[] = [];
  let y = trueTank(0);
  for (let t = 0, prev = 0; t <= 2.5 * 3600; t += 10) {
    y += ((trueTank(t) - y) * (t - prev)) / TAU; prev = t;
    if (t % 300 === 0) lagged.push({ ts: T0 + t, tank_f: y });
  }
  const d = deltaT(lagged, burst);
  within(d.correctedF as number, DT_TRUE, 0.02, "corrected ΔT, 4-min sensor lag");
  within(cEffBtuPerF(burst.kwh, d.correctedF as number), C_TRUE, 0.02, "C_eff, 4-min sensor lag");
}

// no burst in a quiet window
assert.equal(findBurst(power.filter((p) => p.ts < T0 + T_ON)), null);
assert.throws(() => cEffBtuPerF(3, 0));

// fitLine / projectLine
{
  const f = fitLine([{ ts: 0, v: 10 }, { ts: 1800, v: 11 }, { ts: 3600, v: 12 }]);
  assert.ok(f);
  within(f.slopePerHr, 2, 1e-9, "slope");
  within(projectLine(f, 7200), 14, 1e-9, "projection");
  assert.equal(fitLine([{ ts: 0, v: 1 }]), null);
}

// ---- a known flow ------------------------------------------------------------------------------------------------
// pump1 alone, 30 min, ΔT 5 K, true loop flow 30 L/min of PG50 → Q = 0.5 L/s × 3.72 × 5 = 9.3 kW
const UA = 0.017, AMB = 65, FLOW_TRUE = 30, DT_C = 5;
const qKw = (FLOW_TRUE / 60) * PG50_KJ_PER_L_K * DT_C;
const S0 = T0 + 10 * 86400, SEG_S = 1800;
const tankStart = 110;
// tank rises linearly; standby taken at the segment's mean tank so the line is exact
const slopeGuess = (qKw * BTU_PER_KWH) / C_TRUE - UA * (tankStart + 8 - AMB);
const tankMean = tankStart + (slopeGuess * SEG_S) / 3600 / 2;
const slope = (qKw * BTU_PER_KWH) / C_TRUE - UA * (tankMean - AMB);

const p1: PumpSample[] = [], p2: PumpSample[] = [], tank2: TankSample[] = [];
for (let t = -1200; t <= SEG_S + 1200; t += 60) {
  const on = t >= 0 && t <= SEG_S;
  p1.push({ ts: S0 + t, state: on ? "heating" : "idle", inlet_c: 40, outlet_c: on ? 40 + DT_C : 40, power_w: on ? 4000 : 50 });
  p2.push({ ts: S0 + t, state: "idle", inlet_c: 38, outlet_c: 38, power_w: 50 });
}
for (let t = -1200; t <= SEG_S + 1200; t += 300) {
  tank2.push({ ts: S0 + t, tank_f: t < 0 ? tankStart : t > SEG_S ? tankStart + (slope * SEG_S) / 3600 : tankStart + (slope * t) / 3600 });
}
{
  const { segments, rejected } = findSinglePumpSegments(p1, p2, tank2, []);
  assert.equal(segments.length, 1, `one segment, rejects ${JSON.stringify(rejected)}`);
  const s = segments[0];
  assert.equal(s.minutes, 30);
  within(s.meanDtC, DT_C, 1e-9, "segment ΔT");
  within(s.tank.slopePerHr, slope, 1e-6, "tank slope");
  const f = segmentFlow(s, C_TRUE, UA, AMB);
  within(f.qKw, qKw, 0.005, "heat into the tank");
  within(f.flowPg50LMin, FLOW_TRUE, 0.01, "PG50 flow");
  within(f.flowWaterLMin, FLOW_TRUE * PG50_FACTOR, 0.01, "water-basis flow is 0.89 × PG50 flow");
  assert.ok(f.flowWaterLMin < f.flowPg50LMin, "glycol carries less heat per litre, so the same Q needs more flow");

  // the other pump busy → rejected
  const busy = p2.map((x) => ({ ...x, power_w: 3000 }));
  assert.deepEqual(findSinglePumpSegments(p1, busy, tank2, []).rejected.otherBusy, 1);
  // a draw just after the segment (inside the 5-min margin) → rejected
  assert.equal(findSinglePumpSegments(p1, p2, tank2, [S0 + SEG_S + 200]).rejected.draw, 1);
  // too short → rejected
  const short = p1.filter((x) => x.ts < S0 + 600 || x.ts > S0 + SEG_S);
  assert.equal(findSinglePumpSegments(short, p2, tank2, []).rejected.shortRun, 1);
  // no tank samples → rejected
  assert.equal(findSinglePumpSegments(p1, p2, [], []).rejected.fewTank, 1);
  // a defrost sample (outlet below inlet) splits the run
  const split = p1.map((x) => (x.ts === S0 + 900 ? { ...x, outlet_c: 35 } : x));
  assert.equal(findSinglePumpSegments(split, p2, tank2, []).rejected.shortRun, 2, "two 14-min halves, both too short");

  // cleanest: a noisier tank fit ranks after a straight one
  const noisy = { ...s, tank: { ...s.tank, rms: 1 } };
  assert.equal(cleanest([noisy, s])[0], s);
}

// quantile
within(quantile([3, 1, 2, 4], 0.5), 2.5, 1e-9, "median");
within(quantile([3, 1, 2, 4], 0.25), 1.75, 1e-9, "q1");
assert.ok(Number.isNaN(quantile([], 0.5)));

console.log(`element-calibration.test: all assertions passed (E ${burst.kwh.toFixed(3)} kWh, ΔT_true ${DT_TRUE.toFixed(2)} °F, flow ${FLOW_TRUE} L/min PG50 / ${(FLOW_TRUE * PG50_FACTOR).toFixed(1)} water; water c=${WATER_KJ_PER_L_K})`);
