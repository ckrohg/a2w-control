/**
 * @purpose gtm#1616 Part B input: MEASURE how fast the buffer climbs while the heat pumps charge it
 * and push it to TempIQ's POST /api/insights/tank-reheat-rate as 'tank_reheat_rate_a2w'. TempIQ's
 * identification plan prices a down-probe's recovery from this — with no measured rate every
 * down-probe fails closed (plant_recovery_unknown), by the owner's "no invented numbers" direction.
 *
 * A reheat RUN is a contiguous stretch of the 5-min SensorLinx series where the tank rises every
 * sample by at least RISE_STEP_F (a draw or standby never does that), with no gap wider than
 * MAX_GAP_MIN, lasting at least MIN_RUN_MIN and climbing at least MIN_NET_RISE_F. Its rate is the
 * net rise over its duration. Zone calls are NOT excluded: a charge that must also feed calling
 * zones is a slower charge, and slower is the honest figure for recovery.
 *
 * The pushed `fPerHr` is the 25th PERCENTILE of the runs' rates — the conservative figure. Recovery
 * is what the safety envelope waits for; a slow tank is the unsafe direction to be wrong about. The
 * median rides along for the record, with per-outdoor-band rates (the pumps derate in the cold).
 * Fail-soft: mirrors tank-ua-push.ts; flag-gated by the same TEMPIQ_PUSH_ENABLED + token.
 */
import type { Store } from "./store";

export const RISE_STEP_F = 0.3;      // per 5-min sample: a real charge, not sensor noise (~0.1) or standby
export const MAX_GAP_MIN = 12;
export const MIN_RUN_MIN = 20;       // ≥ 4 samples
export const MIN_NET_RISE_F = 4;     // enough climb for the rate to mean something
export const LOOKBACK_HOURS = 14 * 24;
export const RATE_FLOOR = 0.5;       // °F/hr — slower is not a charge
export const RATE_CEIL = 60;         // °F/hr — faster is not a 110-gal tank
const BANDS: Array<[number, number]> = [[-20, 0], [0, 15], [15, 30], [30, 45], [45, 60], [60, 120]];

export interface TankSample { ts: Date; tankF: number | null; outdoorF: number | null }
export interface ReheatRun { start: Date; end: Date; tStartF: number; tEndF: number; hours: number; fPerHr: number; outdoorF: number | null }

/** Pure: the rising runs in a series. */
export function findReheatRuns(series: TankSample[]): ReheatRun[] {
  const runs: ReheatRun[] = [];
  let run: Array<{ ts: Date; tankF: number; outdoorF: number | null }> = [];
  const flush = () => {
    if (run.length >= 2) {
      const first = run[0], last = run[run.length - 1];
      const hours = (last.ts.getTime() - first.ts.getTime()) / 3600_000;
      const rise = last.tankF - first.tankF;
      if (hours * 60 >= MIN_RUN_MIN && rise >= MIN_NET_RISE_F) {
        const outs = run.map((p) => p.outdoorF).filter((v): v is number => v != null);
        runs.push({
          start: first.ts, end: last.ts, tStartF: first.tankF, tEndF: last.tankF,
          hours: Math.round(hours * 100) / 100,
          fPerHr: Math.round((rise / hours) * 100) / 100,
          outdoorF: outs.length ? Math.round((outs.reduce((a, b) => a + b, 0) / outs.length) * 10) / 10 : null,
        });
      }
    }
    run = [];
  };
  for (const p of series) {
    if (p.tankF == null) { flush(); continue; }
    const prev = run[run.length - 1];
    if (prev) {
      const gapMin = (p.ts.getTime() - prev.ts.getTime()) / 60_000;
      const delta = p.tankF - prev.tankF;
      if (gapMin > MAX_GAP_MIN || delta < RISE_STEP_F) { flush(); }
    }
    run.push({ ts: p.ts, tankF: p.tankF, outdoorF: p.outdoorF });
  }
  flush();
  return runs;
}

export interface ReheatAgg {
  fPerHr: number;         // the 25th percentile — conservative
  medianFPerHr: number;
  nWindows: number;
  windowEndMs: number;
  byBand: Array<{ lowF: number; highF: number; fPerHr: number; n: number }>;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Pure: aggregate valid runs. null when none qualify. */
export function aggregateReheat(runs: ReheatRun[]): ReheatAgg | null {
  const valid = runs.filter((r) => Number.isFinite(r.fPerHr) && r.fPerHr >= RATE_FLOOR && r.fPerHr <= RATE_CEIL);
  if (valid.length === 0) return null;
  const rates = valid.map((r) => r.fPerHr).sort((a, b) => a - b);
  const byBand = BANDS.map(([lowF, highF]) => {
    const inBand = valid.filter((r) => r.outdoorF != null && r.outdoorF >= lowF && r.outdoorF < highF).map((r) => r.fPerHr).sort((a, b) => a - b);
    return inBand.length ? { lowF, highF, fPerHr: Math.round(quantile(inBand, 0.25) * 100) / 100, n: inBand.length } : null;
  }).filter((b): b is NonNullable<typeof b> => b != null);
  return {
    fPerHr: Math.round(quantile(rates, 0.25) * 100) / 100,
    medianFPerHr: Math.round(quantile(rates, 0.5) * 100) / 100,
    nWindows: valid.length,
    windowEndMs: Math.max(...valid.map((r) => r.end.getTime())),
    byBand,
  };
}

/** Read the recent series, find runs, aggregate, POST. Never throws; returns a short status string. */
export async function pushTankReheat(store: Pick<Store, "getRecentTankSeries">, baseUrl: string, token: string): Promise<string> {
  try {
    const series = await store.getRecentTankSeries(LOOKBACK_HOURS);
    const agg = aggregateReheat(findReheatRuns(series));
    if (!agg) return "skipped: no qualifying reheat runs";
    const res = await fetch(`${baseUrl}/api/insights/tank-reheat-rate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fPerHr: agg.fPerHr, medianFPerHr: agg.medianFPerHr, nWindows: agg.nWindows, method: "a2w_reheat_runs", windowEndTs: agg.windowEndMs, byBand: agg.byBand }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`tempiq POST tank-reheat-rate: HTTP ${res.status}`);
    const msg = `pushed reheat p25=${agg.fPerHr} °F/h (median ${agg.medianFPerHr}, n=${agg.nWindows}, bands ${agg.byBand.length})`;
    console.log(`[tempiq-reheat-push] ${msg}`);
    return msg;
  } catch (e) {
    const msg = `error: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[tempiq-reheat-push] ${msg}`);
    return msg;
  }
}
