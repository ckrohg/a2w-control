/**
 * @purpose Pure math for the element-calibration night (Sun Nov 22 → Mon Nov 23 2026, ET): the 16.5 kW "Buffer Tank"
 * resistance element is run alone into the buffer with both heat pumps' SPAN circuits off, so the heat delivered is
 * exactly the metered electricity (COP = 1) and the tank's response gives its effective heat capacity C_eff. That C_eff
 * is then applied to recent single-pump deep charges to recover each heat pump's loop flow. No I/O here — the CLI in
 * scripts/element-night-local-check.ts reads the LOCAL restore and feeds these functions; scripts/element-calibration.test.ts
 * checks them on synthetic data.
 *
 * C_eff method.
 *   E   = trapezoid integral of the element's SPAN power_w over the burst (the contiguous run of samples above 1000 W).
 *         The one below-threshold sample bracketing each edge is included when it is within EDGE_BRACKET_S, so the
 *         switch-on / switch-off ramps are counted as half-trapezoids instead of being dropped: with ~30 s samples
 *         the switch happens somewhere inside that interval and the half-trapezoid is the unbiased estimate.
 *   ΔT  = "two-baseline extrapolation to the burst midpoint" (the Dickinson method of bomb calorimetry). The tank
 *         loses heat to the room the whole time, so the rise the element produced is NOT the end-minus-start reading.
 *         Fit a line to tank_f over the PRE window (default the 60 min ending at burst start) and another over the POST
 *         window (default 20–60 min after burst end), and evaluate both at the burst midpoint. Each line carries its
 *         own standby slope, so the standby lost during the burst is attributed back, and the gap between the two lines
 *         at the midpoint is the step the element produced. The first 20 min after the burst are skipped because the
 *         element heats the water around it and the single HBX tank sensor needs time to see the mixed level; the
 *         "settled" post-burst level is what the back-projection reads. Both the raw ΔT (first sample after the burst
 *         minus the last before it) and the corrected ΔT are returned so the correction's size is visible.
 *   C_eff = E × 3412.14 / ΔT_corrected [BTU/°F]; gallons-equivalent = C_eff / 8.34.
 *
 * Flow method.
 *   A single-pump deep-charge segment is a contiguous run of one pump's readings with power_w > SEGMENT.minPowerW and
 *   outlet above inlet, the other pump never above SEGMENT.otherIdleW, no detected draw within SEGMENT.drawMarginS,
 *   at least SEGMENT.minMinutes long and with ≥ SEGMENT.minTankSamples tank readings. Heat into the tank over the segment
 *   Q = C_eff × (tank slope + UA × (tank − 65 °F)) in BTU/hr, where UA is the planner's °F/hr-per-°F standby constant
 *   (winterdp.ts: uaBtuPerHrF = tankUa × C_EFF_BTU_PER_F, drain = ua × max(0, S − 65)). Flow = Q / (ρc × mean(outlet −
 *   inlet)). The loop is 50/50 propylene glycol: ρc = PG50_KJ_PER_L_K = 0.89 × 4.18 kJ/(L·K). The water-basis number is
 *   returned too, because it is the one everyone will reach for first and the two differ by 12 %.
 *   "Cleanest" ranks segments by the RMS residual of the tank line fit (°F), ties by longer duration.
 */

// ---- constants ------------------------------------------------------------------------------------------------
export const BTU_PER_KWH = 3412.14;
export const LB_PER_GAL = 8.34; // BTU/°F per gallon of water
export const WATER_KJ_PER_L_K = 4.18;
export const PG50_FACTOR = 0.89; // 50/50 propylene glycol volumetric heat capacity relative to water
export const PG50_KJ_PER_L_K = WATER_KJ_PER_L_K * PG50_FACTOR;
export const RATED_FLOW_L_MIN = 2.12 * 1000 / 60; // manufacturer: 2.12 m³/h per pump = 35.3 L/min
export const TANK_AMBIENT_F = 65; // the ambient DEFAULT_TANK_UA is defined against (winterdp.ts AMBIENT_F)
export const BURST_THRESHOLD_W = 1000;
export const EDGE_BRACKET_S = 120;
export const PRE_WINDOW_MIN: [number, number] = [60, 0]; // minutes before burst start: [from, to]
export const POST_WINDOW_MIN: [number, number] = [20, 60]; // minutes after burst end: [from, to]
export const SEGMENT = {
  minPowerW: 1500,
  otherIdleW: 1500,
  maxGapS: 180,
  minMinutes: 20,
  minTankSamples: 3,
  drawMarginS: 300,
};

// ---- primitives -----------------------------------------------------------------------------------------------
export interface PowerSample { ts: number; power_w: number | null } // ts epoch seconds
export interface TankSample { ts: number; tank_f: number } // ts epoch seconds

/** Consumption magnitude: SPAN reports consumption as NEGATIVE power_w on this panel (pumphealth.ts), so every use takes |W|. */
const mag = (w: number | null | undefined): number | null => (w == null || !Number.isFinite(w) ? null : Math.abs(w));

/** kWh under a power_w series (|W|, epoch seconds) by the trapezoid rule; null samples are skipped. */
export function trapezoidKwh(samples: PowerSample[]): number {
  let wh = 0, prev: { ts: number; p: number } | null = null;
  for (const s of samples) {
    const p = mag(s.power_w);
    if (p == null) continue;
    if (prev) wh += ((prev.p + p) / 2) * ((s.ts - prev.ts) / 3600);
    prev = { ts: s.ts, p };
  }
  return wh / 1000;
}

export interface Burst {
  start: number; // first sample above threshold
  end: number; // last sample above threshold
  samples: PowerSample[]; // the integrated run, brackets included
  kwh: number;
  peakW: number;
  meanW: number;
  maxGapS: number;
  nAbove: number;
  bracketed: [boolean, boolean];
  runsFound: number; // how many separate above-threshold runs the window held
}

/** The highest-energy contiguous run of samples with |power_w| above `thresholdW`, with its bracketing samples folded into the integral. */
export function findBurst(samples: PowerSample[], thresholdW = BURST_THRESHOLD_W): Burst | null {
  const runs: [number, number][] = [];
  const above = (k: number) => (mag(samples[k].power_w) ?? -1) > thresholdW;
  let i = 0;
  while (i < samples.length) {
    if (above(i)) {
      let j = i;
      while (j + 1 < samples.length && above(j + 1)) j++;
      runs.push([i, j]);
      i = j + 1;
    } else i++;
  }
  if (!runs.length) return null;
  let best: Burst | null = null;
  for (const [a, b] of runs) {
    const pre = a > 0 && samples[a].ts - samples[a - 1].ts <= EDGE_BRACKET_S;
    const post = b + 1 < samples.length && samples[b + 1].ts - samples[b].ts <= EDGE_BRACKET_S;
    const run = samples.slice(pre ? a - 1 : a, post ? b + 2 : b + 1);
    const hot = samples.slice(a, b + 1);
    const kwh = trapezoidKwh(run);
    let maxGap = 0;
    for (let k = 1; k < hot.length; k++) maxGap = Math.max(maxGap, hot[k].ts - hot[k - 1].ts);
    const ws = hot.map((s) => mag(s.power_w) as number);
    const cand: Burst = {
      start: samples[a].ts, end: samples[b].ts, samples: run, kwh,
      peakW: Math.max(...ws), meanW: ws.reduce((x, y) => x + y, 0) / ws.length,
      maxGapS: maxGap, nAbove: hot.length, bracketed: [pre, post], runsFound: runs.length,
    };
    if (!best || cand.kwh > best.kwh) best = cand;
  }
  return best;
}

export interface LineFit { n: number; t0: number; intercept: number; slopePerHr: number; rms: number }

/** Least-squares line v = intercept + slopePerHr × (t − t0)/3600 over (ts seconds, value) points; null below 2 points. */
export function fitLine(pts: { ts: number; v: number }[]): LineFit | null {
  const xs = pts.filter((p) => Number.isFinite(p.v));
  if (xs.length < 2) return null;
  const t0 = xs[0].ts;
  const x = xs.map((p) => (p.ts - t0) / 3600), y = xs.map((p) => p.v);
  const n = xs.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (x[i] - mx) ** 2; sxy += (x[i] - mx) * (y[i] - my); }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (y[i] - (intercept + slope * x[i])) ** 2;
  return { n, t0, intercept, slopePerHr: slope, rms: Math.sqrt(ss / n) };
}

export const projectLine = (f: LineFit, ts: number): number => f.intercept + f.slopePerHr * ((ts - f.t0) / 3600);

const inWindow = (tank: TankSample[], from: number, to: number) => tank.filter((t) => t.ts >= from && t.ts <= to && Number.isFinite(t.tank_f));

export interface DeltaT {
  mid: number;
  pre: LineFit | null;
  post: LineFit | null;
  preAtMid: number | null;
  postAtMid: number | null;
  rawF: number | null; // first sample after the burst − last sample before it
  rawStartF: number | null;
  rawEndF: number | null;
  peakF: number | null; // highest tank_f within POST_WINDOW_MIN[1] after the end
  correctedF: number | null;
  nPre: number;
  nPost: number;
  preWindow: [number, number];
  postWindow: [number, number];
}

/** The standby-corrected tank rise for a burst, by two-baseline extrapolation to the burst midpoint (see header). */
export function deltaT(tank: TankSample[], burst: { start: number; end: number }, pre = PRE_WINDOW_MIN, post = POST_WINDOW_MIN): DeltaT {
  const mid = (burst.start + burst.end) / 2;
  const preWindow: [number, number] = [burst.start - pre[0] * 60, burst.start - pre[1] * 60];
  const postWindow: [number, number] = [burst.end + post[0] * 60, burst.end + post[1] * 60];
  const preS = inWindow(tank, preWindow[0], preWindow[1]);
  const postS = inWindow(tank, postWindow[0], postWindow[1]);
  const preFit = fitLine(preS.map((t) => ({ ts: t.ts, v: t.tank_f })));
  const postFit = fitLine(postS.map((t) => ({ ts: t.ts, v: t.tank_f })));
  const before = tank.filter((t) => t.ts <= burst.start && Number.isFinite(t.tank_f)).at(-1) ?? null;
  const after = tank.find((t) => t.ts >= burst.end && Number.isFinite(t.tank_f)) ?? null;
  const tail = inWindow(tank, burst.end, postWindow[1]);
  const preAtMid = preFit ? projectLine(preFit, mid) : null;
  const postAtMid = postFit ? projectLine(postFit, mid) : null;
  return {
    mid, pre: preFit, post: postFit, preAtMid, postAtMid,
    rawF: before && after ? after.tank_f - before.tank_f : null,
    rawStartF: before?.tank_f ?? null, rawEndF: after?.tank_f ?? null,
    peakF: tail.length ? Math.max(...tail.map((t) => t.tank_f)) : null,
    correctedF: preAtMid != null && postAtMid != null ? postAtMid - preAtMid : null,
    nPre: preS.length, nPost: postS.length, preWindow, postWindow,
  };
}

/** C_eff in BTU/°F from the element's kWh and the corrected tank rise. */
export function cEffBtuPerF(kwh: number, deltaTF: number): number {
  if (!(deltaTF > 0)) throw new Error(`ΔT must be positive, got ${deltaTF}`);
  return (kwh * BTU_PER_KWH) / deltaTF;
}

// ---- flow -----------------------------------------------------------------------------------------------------
export interface PumpSample {
  ts: number; // epoch seconds
  state?: string | null;
  inlet_c: number | null;
  outlet_c: number | null;
  power_w: number | null;
}

export interface Segment {
  start: number;
  end: number;
  minutes: number;
  nSamples: number;
  meanDtC: number; // outlet − inlet
  sdDtC: number;
  meanPowerW: number;
  nOther: number; // other-pump samples seen in the window (0 = no evidence the other pump was idle)
  tank: LineFit; // tank_f over the segment
  tankMeanF: number;
  tankStartF: number;
  tankEndF: number;
}

const isHeating = (s: PumpSample, minPowerW: number) =>
  (mag(s.power_w) ?? -1) > minPowerW && s.inlet_c != null && s.outlet_c != null && s.outlet_c > s.inlet_c;

function lowerBound<T extends { ts: number }>(a: T[], t: number): number {
  let l = 0, h = a.length;
  while (l < h) { const m = (l + h) >> 1; if (a[m].ts < t) l = m + 1; else h = m; }
  return l;
}
const between = <T extends { ts: number }>(a: T[], from: number, to: number) => a.slice(lowerBound(a, from), lowerBound(a, to + 1e-6));

export interface SegmentRejects { shortRun: number; otherBusy: number; draw: number; fewTank: number }

/**
 * Single-pump deep-charge segments of `self` (see header). `other`, `tank` and `drawTs` must be sorted by ts.
 * Returns the accepted segments and a tally of why candidates were rejected, so the CLI can print it.
 */
export function findSinglePumpSegments(
  self: PumpSample[], other: PumpSample[], tank: TankSample[], drawTs: number[], opts = SEGMENT,
): { segments: Segment[]; rejected: SegmentRejects } {
  const rejected: SegmentRejects = { shortRun: 0, otherBusy: 0, draw: 0, fewTank: 0 };
  const segments: Segment[] = [];
  let i = 0;
  while (i < self.length) {
    if (!isHeating(self[i], opts.minPowerW)) { i++; continue; }
    let j = i;
    while (j + 1 < self.length && isHeating(self[j + 1], opts.minPowerW) && self[j + 1].ts - self[j].ts <= opts.maxGapS) j++;
    const run = self.slice(i, j + 1);
    i = j + 1;
    const start = run[0].ts, end = run[run.length - 1].ts;
    const minutes = (end - start) / 60;
    if (minutes < opts.minMinutes) { rejected.shortRun++; continue; }
    const oth = between(other, start, end);
    if (oth.some((s) => (mag(s.power_w) ?? -1) > opts.otherIdleW)) { rejected.otherBusy++; continue; }
    if (drawTs.some((d) => d >= start - opts.drawMarginS && d <= end + opts.drawMarginS)) { rejected.draw++; continue; }
    const tk = between(tank, start, end).filter((t) => Number.isFinite(t.tank_f));
    const fit = tk.length >= opts.minTankSamples ? fitLine(tk.map((t) => ({ ts: t.ts, v: t.tank_f }))) : null;
    if (!fit) { rejected.fewTank++; continue; }
    const dts = run.map((s) => (s.outlet_c as number) - (s.inlet_c as number));
    const meanDt = dts.reduce((a, b) => a + b, 0) / dts.length;
    const sd = Math.sqrt(dts.reduce((a, d) => a + (d - meanDt) ** 2, 0) / dts.length);
    segments.push({
      start, end, minutes, nSamples: run.length, meanDtC: meanDt, sdDtC: sd,
      meanPowerW: run.reduce((a, s) => a + (mag(s.power_w) as number), 0) / run.length,
      nOther: oth.length, tank: fit,
      tankMeanF: tk.reduce((a, t) => a + t.tank_f, 0) / tk.length,
      tankStartF: tk[0].tank_f, tankEndF: tk[tk.length - 1].tank_f,
    });
  }
  return { segments, rejected };
}

export interface FlowResult {
  qBtuHr: number;
  qKw: number;
  standbyFPerHr: number;
  tankSlopeFPerHr: number;
  flowWaterLMin: number;
  flowPg50LMin: number;
}

/** Loop flow for one segment from the tank's heat balance (see header). `uaPerHrF` is °F/hr per °F above `ambientF`. */
export function segmentFlow(seg: Segment, cEff: number, uaPerHrF: number, ambientF = TANK_AMBIENT_F): FlowResult {
  const standby = uaPerHrF * Math.max(0, seg.tankMeanF - ambientF);
  const qBtuHr = cEff * (seg.tank.slopePerHr + standby);
  const qKw = qBtuHr / BTU_PER_KWH;
  const lps = (c: number) => qKw / (c * seg.meanDtC); // kW / (kJ/(L·K) × K) = L/s
  return {
    qBtuHr, qKw, standbyFPerHr: standby, tankSlopeFPerHr: seg.tank.slopePerHr,
    flowWaterLMin: lps(WATER_KJ_PER_L_K) * 60,
    flowPg50LMin: lps(PG50_KJ_PER_L_K) * 60,
  };
}

/** Lower RMS residual of the tank fit first (the tank rose like a line), longer segments on ties. */
export function cleanest(segs: Segment[]): Segment[] {
  return [...segs].sort((a, b) => a.tank.rms - b.tank.rms || b.minutes - a.minutes);
}

/** Linear-interpolated quantile, p in [0, 1]. */
export function quantile(xs: number[], p: number): number {
  const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const k = (s.length - 1) * p, lo = Math.floor(k), hi = Math.ceil(k);
  return s[lo] + (s[hi] - s[lo]) * (k - lo);
}
