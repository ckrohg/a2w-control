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

// PROVISIONAL pump max deliverable buffer temp — above this the buffer's 16.5 kW resistive element
// (COP 1) bridges the gap. Used for the element credit; pending the pumps' real spec from Winnie.
export const PUMP_MAX_BUFFER_F = 145;
// A plausible "just hardcode a colder temp" static setting a user might pick instead of smart autonomy
// (safe DHW margin, cooler than as-found but not as aggressive as the plan's 120°F idle floor).
export const FIXED_COOL_BUFFER_F = 130;

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
  spanKwh?: number | null;  // REAL metered pump electricity (SPAN Air-Water) for the day, if available
  // measured session aggregates from tempiq_cop_points (quality-filtered); null ⇒ modeled fallback
  measured: { elecKwh: number; thermalKwh: number; cop: number; sinkF: number; sessions: number } | null;
}

export interface RealizedDay {
  day: string;
  actualElecKwh: number;    // measured (what we spent, running smart/autopilot)
  cfElecKwh: number;        // as-found counterfactual (the hot regime)
  fixedElecKwh: number;     // "hardcoded a colder temp" counterfactual (static cool setting)
  savedUsd: number;         // smart (actual) vs as-found — the realized saving
  fixedSavedUsd: number;    // hardcoded-cool vs as-found — what a static cool setting alone would save
  smartPremiumUsd: number;  // savedUsd − fixedSavedUsd — what smart autonomy adds over hardcoding cool
  copUsd: number;           // the COP (cooler-water) portion of the smart saving
  standbyUsd: number;       // the standby (less-runtime) portion
  elementCreditUsd: number; // resistive-backup (COP 1) the hotter as-found setpoints would have forced
  avgOutdoorF: number;
  copNow: number;
  copOld: number;
  oldBufferF: number;
  standbyKwh: number;
  sessions: number;
  confidence: "measured" | "modeled"; // COP source: measured session vs model
  energyMetered: boolean;             // electricity source: real SPAN meter vs SPAN daily-avg baseline
}

export interface RealizedParams {
  rateUsdKwh: number;   // ELECTRIC_RATE_USD_KWH
  uaBtuHrF: number;     // buffer standby UA (measured ~25)
  ambientF: number;     // mechanical-room ambient (~70)
  dailyKwhFallback: number; // SPAN daily baseline, used only when a day has no measured sessions
}

/** Pure per-day counterfactual. Deterministic; unit-tested.
 *  Energy basis is the SPAN daily total (dailyKwhFallback × coverage) — consistent full-day, unlike
 *  the incomplete charge-session sums in tempiq_cop_points, which we use ONLY for the measured COP.
 *  Each alternative regime's cost is computed as a robust DELTA from actual: the delivered heat at
 *  that regime's (Carnot-scaled measured) COP, plus its standby change, with the 16.5 kW element
 *  (COP 1) covering any buffer band above the pump's max temp. */
export function computeDayRealized(d: DayInputs, p: RealizedParams): RealizedDay {
  const out = d.avgOutdoorF;
  const nowSinkF = d.measured?.sinkF ?? d.nowBufferF + 10; // leaving water ≈ buffer + approach
  const copNow = d.measured?.cop ?? modelCop(out, nowSinkF); // measured efficiency (energy-weighted)
  // Electricity basis: REAL metered pump energy (SPAN Air-Water) if we have it that day, else the
  // SPAN daily-average baseline scaled by coverage. energyMetered flags which.
  const energyMetered = d.spanKwh != null && d.spanKwh > 0;
  const eDaily = energyMetered ? (d.spanKwh as number) : p.dailyKwhFallback * d.coverage;

  // COP at any sink temp: Carnot-scaled from the measured COP at the real outdoor temp. Cooler water
  // ⇒ higher COP; hotter ⇒ lower. Clamped to a sane band (≥1 resistive floor; ≤6 validity clamp).
  const copAt = (sinkF: number) => clamp(copNow * (carnotFactor(sinkF, out) / carnotFactor(nowSinkF, out)), 1, 6);
  const stdKwh = (deltaF: number) => (p.uaBtuHrF * deltaF * 24 * d.coverage) / 3412; // standby for a ΔT band

  // Extra electricity of running regime (bufF, sinkF) INSTEAD of the actual (nowBuffer, nowSink).
  // Positive ⇒ that regime costs more than what we actually run. Split the standby band at the pump's
  // max temp so the element (COP 1) portion is costed correctly.
  const deltaElec = (bufF: number, sinkF: number) => {
    const copR = copAt(sinkF);
    const copTerm = eDaily * (copNow / copR - 1);                                  // delivered heat at regime COP
    const pumpDelta = stdKwh(Math.min(bufF, PUMP_MAX_BUFFER_F) - d.nowBufferF);    // pump-served standby change (signed)
    const elemStd = stdKwh(Math.max(0, bufF - Math.max(d.nowBufferF, PUMP_MAX_BUFFER_F))); // element-served (≥0)
    return { dElec: copTerm + pumpDelta / copR + elemStd, copTerm, elemStd, copR };
  };

  const oldBufferF = Math.max(asfoundBufferF(out), d.nowBufferF); // as-found ran hotter
  const oldSinkF = Math.max(ASFOUND_SINK_F, nowSinkF);
  const af = deltaElec(oldBufferF, oldSinkF);                       // as-found vs actual
  const fx = deltaElec(FIXED_COOL_BUFFER_F, FIXED_COOL_BUFFER_F + 10); // hardcoded-cool vs actual

  const savedUsd = af.dElec * p.rateUsdKwh;                 // as-found − actual (smart/autopilot saving)
  const fixedSavedUsd = (af.dElec - fx.dElec) * p.rateUsdKwh; // as-found − fixed (hardcoded-cool saving)
  const smartPremiumUsd = fx.dElec * p.rateUsdKwh;           // fixed − actual (smart beats fixed if >0)

  const elementCreditUsd = af.elemStd * (1 - 1 / af.copR) * p.rateUsdKwh; // element premium in as-found
  const copUsd = af.copTerm * p.rateUsdKwh;                               // COP portion of the saving
  const standbyUsd = savedUsd - copUsd - elementCreditUsd;                // standby portion (remainder)

  return {
    day: d.day,
    actualElecKwh: round1(eDaily),
    cfElecKwh: round1(eDaily + af.dElec),
    fixedElecKwh: round1(eDaily + fx.dElec),
    savedUsd: round2(savedUsd),
    fixedSavedUsd: round2(fixedSavedUsd),
    smartPremiumUsd: round2(smartPremiumUsd),
    copUsd: round2(copUsd),
    standbyUsd: round2(standbyUsd),
    elementCreditUsd: round2(elementCreditUsd),
    avgOutdoorF: round1(out),
    copNow: round2(copNow),
    copOld: round2(af.copR),
    oldBufferF: round1(oldBufferF),
    standbyKwh: round1(stdKwh(oldBufferF - d.nowBufferF)),
    sessions: d.measured?.sessions ?? 0,
    confidence: d.measured ? "measured" : "modeled",
    energyMetered,
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
