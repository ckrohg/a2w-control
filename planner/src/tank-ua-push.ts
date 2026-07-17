/**
 * @purpose gtm#1328: aggregate the planner's DELIBERATE quiet-window tank decay fits into a
 * single standby UA (°F/hr per °F ΔT) and push it to TempIQ's POST /api/insights/tank-standby-ua.
 *
 * The planner fits UA under genuinely quiet conditions (HP off, no draw, no charge-rise —
 * decay.ts), which TempIQ's own opportunistic "slowest-segment" estimator can't reproduce: on
 * this always-on-circulator buffer the slowest declines are the most pump-heat-biased, so TempIQ
 * reads UA ~4× LOW (~0.006 vs the deliberate-coast ~0.028). TempIQ's hydronic COP standby resolver
 * prefers this pushed value (TempIQv2 PR #1689, behind A2W_TANK_UA_ENABLED).
 *
 * Fail-soft: a push failure NEVER touches the control loop (mirrors tempiq.ts). Flag-gated via the
 * same TEMPIQ_PUSH_ENABLED + TEMPIQ_SURFACE_TOKEN env as the readings pusher.
 */
import type { Store } from "./store";

// MUST match TempIQ's STANDBY_AMBIENT_F (server/services/thermal/hydronic-cop-calculator.ts).
// UA is defined against the SAME indoor mechanical-room ambient on both sides, else the pushed
// coefficient means something different than TempIQ's standby = UA·(T_tank − 65).
const AMBIENT_F = 65;
const UA_FLOOR = 0.001;
const UA_CEIL = 0.2;
const MIN_DELTA_T_F = 10;       // below this, slope/ΔT is too noisy to normalize
const LOOKBACK_HOURS = 30 * 24; // ~30 days of quiet windows (matches TempIQ's staleness horizon)

export interface DecayFitRow {
  windowStart: Date;
  windowEnd: Date;
  tStartF: number;
  tEndF: number;
  hours: number;
  slopeFPerH: number;
}

export interface TankUaAgg {
  ua: number;         // °F/hr per °F ΔT
  nWindows: number;   // how many quiet windows contributed
  windowEndMs: number; // newest quiet-window end — TempIQ gates freshness on THIS, not receipt time
}

/**
 * Pure: median UA across the valid quiet-window fits. Returns null when none qualify.
 * slopeFPerH is negative for a decline, so UA = |slope| / ΔT = -slopeFPerH / (avgTank − ambient).
 */
export function aggregateTankUa(fits: DecayFitRow[]): TankUaAgg | null {
  const uas: number[] = [];
  let newestWindowEndMs = 0;
  for (const f of fits) {
    const avgTank = (f.tStartF + f.tEndF) / 2;
    const deltaT = avgTank - AMBIENT_F;
    if (deltaT <= MIN_DELTA_T_F) continue;
    const ua = -f.slopeFPerH / deltaT;
    if (!Number.isFinite(ua) || ua < UA_FLOOR || ua > UA_CEIL) continue;
    uas.push(ua);
    const wEnd = f.windowEnd.getTime();
    if (wEnd > newestWindowEndMs) newestWindowEndMs = wEnd;
  }
  if (uas.length === 0) return null;
  uas.sort((a, b) => a - b);
  // True median: average the two middle values for an even count (else the upper-middle
  // biases the pushed UA slightly high). codex #37 P2.
  const mid = Math.floor(uas.length / 2);
  const median = uas.length % 2 === 0 ? (uas[mid - 1] + uas[mid]) / 2 : uas[mid];
  return {
    ua: Math.round(median * 100000) / 100000,
    nWindows: uas.length,
    windowEndMs: newestWindowEndMs,
  };
}

/** Read recent fits, aggregate, POST to TempIQ. Never throws; returns a short status string. */
export async function pushTankUa(store: Store, baseUrl: string, token: string): Promise<string> {
  try {
    const fits = await store.getRecentDecayFits(LOOKBACK_HOURS);
    const agg = aggregateTankUa(fits);
    if (!agg) return "skipped: no qualifying quiet-window decay fits";
    const res = await fetch(`${baseUrl}/api/insights/tank-standby-ua`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ua: agg.ua,
        nWindows: agg.nWindows,
        method: "a2w_decay",
        windowEndTs: agg.windowEndMs,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`tempiq POST tank-standby-ua: HTTP ${res.status}`);
    const msg = `pushed UA=${agg.ua} °F/hr/°F (nWin=${agg.nWindows})`;
    console.log(`[tempiq-ua-push] ${msg}`);
    return msg;
  } catch (e) {
    const msg = `error: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[tempiq-ua-push] ${msg}`);
    return msg;
  }
}
