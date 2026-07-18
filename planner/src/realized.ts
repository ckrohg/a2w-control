/**
 * @purpose Realized-savings engine (owner ask 2026-07-18): replace the dashboard's static three-
 * constant guess ($2.76/wk from a fixed 85°F outdoor, 2.6 COP, 11.8 kWh/day) with a PER-DAY
 * counterfactual grounded in MEASURED data. For each day it asks: what would the AS-FOUND regime
 * (the original HBX default reset curve → old buffer target at the day's REAL outdoor temp, old
 * ~163°F setpoints) have cost to deliver the same heat we actually delivered, INCLUDING the extra
 * standby the hotter tank bleeds (which the pumps must re-make) — versus what we actually spent
 * (metered pump electricity + measured COP from tempiq_cop_points).
 *
 * The saving decomposes cleanly into two provably-non-negative terms:
 *   saved_kWh = eActual·(copNow/copOld − 1)   [COP: cooler water is more efficient]
 *             + extraStandby/copOld           [runtime: hotter as-found tank loses more heat]
 * copOld ≤ copNow (hotter sink → lower COP, Carnot-scaled from the MEASURED COP at the real
 * outdoor temp) and oldBuffer ≥ nowBuffer (the as-found curve runs hotter), so both terms ≥ 0.
 *
 * Data hygiene lives in the SQL that feeds this (quality_score, sane sink−outdoor gap, COP bounds).
 * Element credit (the 16.5 kW resistive backup the hotter as-found setpoints would have tripped) is
 * structured but left 0 until the pumps' max leaving-water temp is confirmed (open item w/ Winnie) —
 * flagged, not silently omitted. Computed hourly by the planner into realized_savings; the dashboard
 * only reads + charts it (planner models, dashboard reflects). See [[buffer-standby-loss-temp-dependent]].
 */
import type { Store } from "./store";

export const CUTOVER = "2026-07-16"; // first day of the cooler regime — savings accrue from here

// Frozen AS-FOUND configuration (curve-history.json meta.asfound — the regime before any change).
export const ASFOUND_CFG = { dot: 5, dbt: 165, wwsd: 125, mbt: 145 };
export const ASFOUND_SINK_F = 163; // avg of the frozen hp1/hp2 setpoints (167 / 159.8)

// Reconstruct the as-found buffer target from the frozen reset curve at a real outdoor temp.
// (Mirror of shadow.ts curveTargetF, inlined so this module is self-contained + unit-testable.)
export function asfoundBufferF(outdoorF: number): number {
  const { dot, wwsd, dbt, mbt } = ASFOUND_CFG;
  const t = dbt + ((outdoorF - dot) * (mbt - dbt)) / (wwsd - dot);
  return Math.max(Math.min(t, Math.max(dbt, mbt)), Math.min(dbt, mbt));
}

// Carnot-style efficiency factor ∝ COP for a given leaving-water (sink) temp at an outdoor temp.
// Used only as a RATIO (copOld = copNow × carnot(oldSink)/carnot(nowSink)), so absolute scale cancels.
export function carnotFactor(sinkF: number, outdoorF: number): number {
  const denom = sinkF - outdoorF;
  return denom > 1 ? (sinkF + 459.67) / denom : (sinkF + 459.67); // guard tiny/negative lift
}

// Fallback COP model (Carnot fraction) for days with no measured COP session — same shape as the
// /curve hero model. Only used when tempiq_cop_points is empty for a day; measured COP always wins.
export function modelCop(outdoorF: number, sinkF: number): number {
  const frac = outdoorF >= 45 ? 0.5 : outdoorF >= 0 ? 0.3 + (outdoorF / 45) * 0.2 : 0.22;
  const Tc = sinkF + 10 + 459.67, Te = outdoorF - 12 + 459.67;
  return Math.max(0.4, Math.min(5, frac * (Tc / Math.max(Tc - Te, 1))));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export interface DayInputs {
  day: string;              // YYYY-MM-DD (Eastern)
  avgOutdoorF: number;      // real, from slx_readings
  nowBufferF: number;       // current buffer target that day (real, from slx_readings tank_target_f)
  coverage: number;         // 0..1 share of the day the system actually reported
  // measured session aggregates from tempiq_cop_points (quality-filtered); null ⇒ modeled fallback
  measured: { elecKwh: number; thermalKwh: number; cop: number; sinkF: number; sessions: number } | null;
}

export interface RealizedDay {
  day: string;
  actualElecKwh: number;
  cfElecKwh: number;
  savedUsd: number;
  copUsd: number;           // the COP (cooler-water) portion of the saving
  standbyUsd: number;       // the standby (less-runtime) portion
  elementCreditUsd: number; // reduced resistive-backup use (0 until pump max-temp confirmed)
  avgOutdoorF: number;
  copNow: number;
  copOld: number;
  oldBufferF: number;
  standbyKwh: number;
  sessions: number;
  confidence: "measured" | "modeled";
}

export interface RealizedParams {
  rateUsdKwh: number;   // ELECTRIC_RATE_USD_KWH
  uaBtuHrF: number;     // buffer standby UA (measured ~25)
  ambientF: number;     // mechanical-room ambient (~70)
  dailyKwhFallback: number; // SPAN daily baseline, used only when a day has no measured sessions
}

/** Pure per-day counterfactual. Deterministic; unit-tested. */
export function computeDayRealized(d: DayInputs, p: RealizedParams): RealizedDay {
  const oldBufferF = Math.max(asfoundBufferF(d.avgOutdoorF), d.nowBufferF); // as-found ran hotter
  const nowSinkF = d.measured?.sinkF ?? d.nowBufferF + 10;                  // leaving water ≈ buffer + approach
  const oldSinkF = Math.max(ASFOUND_SINK_F, nowSinkF);

  const copNow = d.measured?.cop ?? modelCop(d.avgOutdoorF, nowSinkF);
  // Old regime ran hotter water → lower COP. Carnot-scaled from the measured COP, floored at 1
  // (below COP 1 the resistive element is the rational choice — captured by element credit later)
  // and capped at copNow (the counterfactual can never be MORE efficient than what we run now).
  const copOld = clamp(copNow * (carnotFactor(oldSinkF, d.avgOutdoorF) / carnotFactor(nowSinkF, d.avgOutdoorF)), 1, copNow);

  const eActual = d.measured?.elecKwh ?? p.dailyKwhFallback * d.coverage;
  const qDelivered = eActual * copNow; // self-consistent heat delivered (E × COP)
  const standbyKwh = (p.uaBtuHrF * Math.max(0, oldBufferF - d.nowBufferF) * 24 * d.coverage) / 3412;

  const eCf = (qDelivered + standbyKwh) / copOld;
  const copKwh = eActual * (copNow / copOld - 1); // COP portion
  const standbyElecKwh = standbyKwh / copOld;     // standby portion (in electricity)

  const elementCreditUsd = 0; // TODO: credit resistive backup the hotter as-found setpoints tripped,
                              // once the pumps' max leaving-water temp is confirmed (Winnie).
  const savedUsd = (eCf - eActual) * p.rateUsdKwh + elementCreditUsd;

  return {
    day: d.day,
    actualElecKwh: round1(eActual),
    cfElecKwh: round1(eCf),
    savedUsd: round2(savedUsd),
    copUsd: round2(copKwh * p.rateUsdKwh),
    standbyUsd: round2(standbyElecKwh * p.rateUsdKwh),
    elementCreditUsd: round2(elementCreditUsd),
    avgOutdoorF: round1(d.avgOutdoorF),
    copNow: round2(copNow),
    copOld: round2(copOld),
    oldBufferF: round1(oldBufferF),
    standbyKwh: round1(standbyKwh),
    sessions: d.measured?.sessions ?? 0,
    confidence: d.measured ? "measured" : "modeled",
  };
}

/** Orchestrator: pull per-day measured inputs, run the engine, upsert the ledger. Called hourly. */
export class RealizedSavings {
  public lastRunAt: string | null = null;
  public lastDays = 0;

  constructor(private readonly store: Store, private readonly params: RealizedParams) {}

  async computeAndStore(lookbackDays = 45): Promise<void> {
    const inputs = await this.store.getRealizedDayInputs(CUTOVER, lookbackDays);
    for (const d of inputs) {
      await this.store.upsertRealizedDay(computeDayRealized(d, this.params));
    }
    this.lastRunAt = new Date().toISOString();
    this.lastDays = inputs.length;
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
