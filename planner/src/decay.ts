/**
 * @purpose Tank decay-fit — the self-accumulating half of the C_eff puzzle (plan §6.7).
 * Scans recent readings for QUIET windows (no stage or backup calls, no draw signatures,
 * tank gently declining) and fits the standby-loss slope (°F/h). Each fit measures
 * UA_tank/C_eff (the time constant); the tank nameplate or one known-power element event
 * later pins C_eff, and UA_tank falls out — feeding the DP's standbyLoss(tank) term.
 * Windows are keyed by start time (idempotent re-scans upsert).
 */

import { Store } from "./store";

const MIN_WINDOW_H = 1.5;
const MAX_GAP_MIN = 12;      // series continuity (5-min cadence)
const DRAW_DROP_F = 1.2;     // a 5-min fall sharper than this = a draw, not standby
const CHARGE_RISE_F = 0.4;   // any real rise = heat input; quiet windows only decline
const MIN_NET_DECLINE_F = 0.8;

export interface DecayFit {
  windowStart: Date;
  windowEnd: Date;
  tStartF: number;
  tEndF: number;
  hours: number;
  slopeFPerH: number;
}

export function findQuietDecays(
  series: { ts: Date; tankF: number | null; anyCall: boolean }[],
): DecayFit[] {
  const fits: DecayFit[] = [];
  let run: { ts: Date; tankF: number }[] = [];

  const flush = () => {
    if (run.length >= 2) {
      const first = run[0], last = run[run.length - 1];
      const hours = (last.ts.getTime() - first.ts.getTime()) / 3600_000;
      const decline = first.tankF - last.tankF;
      if (hours >= MIN_WINDOW_H && decline >= MIN_NET_DECLINE_F) {
        fits.push({
          windowStart: first.ts, windowEnd: last.ts,
          tStartF: first.tankF, tEndF: last.tankF,
          hours: Math.round(hours * 100) / 100,
          slopeFPerH: Math.round((-decline / hours) * 1000) / 1000,
        });
      }
    }
    run = [];
  };

  for (const p of series) {
    if (p.tankF == null || p.anyCall) { flush(); continue; }
    const prev = run[run.length - 1];
    if (prev) {
      const gapMin = (p.ts.getTime() - prev.ts.getTime()) / 60_000;
      const delta = p.tankF - prev.tankF;
      if (gapMin > MAX_GAP_MIN || delta <= -DRAW_DROP_F || delta >= CHARGE_RISE_F) {
        flush();
      }
    }
    run.push({ ts: p.ts, tankF: p.tankF });
  }
  flush();
  return fits;
}

export async function decayScanOnce(store: Store): Promise<number> {
  const series = await store.getRecentSeries(26);
  const fits = findQuietDecays(series);
  for (const f of fits) await store.upsertDecayFit(f);
  if (fits.length) {
    console.log(
      `decay scan: ${fits.length} quiet window(s), slopes ` +
      fits.map((f) => `${f.slopeFPerH}°F/h over ${f.hours}h @${f.tStartF.toFixed(0)}°F`).join("; "),
    );
  }
  return fits.length;
}
