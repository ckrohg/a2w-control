/**
 * @purpose A-5 shadow planner (summer v1) — computes what the day plan WOULD command,
 * hour by hour for the next 24 h: tank target + HP1 setpoint + a human-readable reason
 * per block. SHADOW ONLY: results go to the shadow_plans table and the dashboard, never
 * to a device. Summer logic = DHW floor windows + pre-charge in the warmest lead hour
 * (flat electricity rate → COP timing is the only timing lever, plan §6.2). Hours whose
 * forecast drops below WINTER_GUARD_F fall back to mimicking the HBX reset curve, so
 * plan-vs-actual stays meaningful into the season the winter solver isn't built for yet.
 */

export interface ForecastHour {
  ts: Date;
  outdoorF: number;
}

export interface ShadowBlock {
  ts: string; // ISO hour start
  outdoor_f: number;
  tank_target_f: number;
  hp1_setpoint_f: number;
  reason: string;
}

export interface ShadowOpts {
  dhwWindows: [number, number][]; // local-hour ranges [start, endExclusive]
  dhwFloorF: number;
  idleF: number;
  prechargeLookbackH: number;
  i1MarginF: number;
  hpMinF: number; // unattended winter floor, 45 °C
  hpMaxF: number; // reg-2027 cap, 55 °C
  bandMinF: number; // I4 band
  bandMaxF: number;
  winterGuardF: number;
}

export const DEFAULT_OPTS: ShadowOpts = {
  dhwWindows: [[6, 9], [17, 22]],
  dhwFloorF: 120,
  idleF: 110,
  prechargeLookbackH: 3,
  i1MarginF: 8,
  hpMinF: 113,
  hpMaxF: 131,
  bandMinF: 95,
  bandMaxF: 130,
  winterGuardF: 50,
};

/** Target the ECO-0600's own linear reset curve would compute at this outdoor temp. */
export function curveTargetF(cfg: Record<string, any>, outdoorF: number): number | null {
  const { dot, wwsd, dbt, mbt } = cfg;
  if ([dot, wwsd, dbt, mbt].some((v) => typeof v !== "number") || wwsd === dot) return null;
  const t = dbt + ((outdoorF - dot) * (mbt - dbt)) / (wwsd - dot);
  return Math.max(Math.min(t, Math.max(dbt, mbt)), Math.min(dbt, mbt));
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export function computeShadowPlan(
  forecast: ForecastHour[],
  hbxConfig: Record<string, any> | null,
  opts: ShadowOpts = DEFAULT_OPTS,
): ShadowBlock[] {
  const hours = forecast.slice(0, 24);
  const inWindow = (h: number) => opts.dhwWindows.some(([a, b]) => h >= a && h < b);

  type Draft = { f: ForecastHour; localH: number; target: number; reason: string };
  const draft: Draft[] = hours.map((f) => {
    const localH = f.ts.getHours(); // TZ env makes this local time
    return inWindow(localH)
      ? { f, localH, target: opts.dhwFloorF, reason: "DHW window floor" }
      : { f, localH, target: opts.idleF, reason: "idle (no draws expected)" };
  });

  // Pre-charge: for each window start present in the horizon, pick the warmest of the
  // preceding non-window hours (up to lookback) and charge there instead of at the bell.
  for (const [start] of opts.dhwWindows) {
    const idx = draft.findIndex((d) => d.localH === start);
    if (idx <= 0) continue;
    const lead = draft.slice(Math.max(0, idx - opts.prechargeLookbackH), idx)
      .filter((d) => !inWindow(d.localH));
    if (!lead.length) continue;
    const warmest = lead.reduce((a, b) => (b.f.outdoorF > a.f.outdoorF ? b : a));
    warmest.target = opts.dhwFloorF;
    warmest.reason = `pre-charge for ${String(start).padStart(2, "0")}:00 window (warmest lead hour, ${warmest.f.outdoorF.toFixed(0)}°F)`;
  }

  return draft.map((d) => {
    let target = d.target;
    let reason = d.reason;
    if (d.f.outdoorF < opts.winterGuardF && hbxConfig) {
      const curve = curveTargetF(hbxConfig, d.f.outdoorF);
      if (curve != null && curve > target) {
        target = curve;
        reason = "winter guard: mimic HBX curve (winter solver not built yet)";
      }
    }
    target = clamp(target, opts.bandMinF, opts.bandMaxF);
    const hp1 = clamp(target + opts.i1MarginF, opts.hpMinF, opts.hpMaxF);
    return {
      ts: d.f.ts.toISOString(),
      outdoor_f: d.f.outdoorF,
      tank_target_f: Math.round(target),
      hp1_setpoint_f: Math.round(hp1),
      reason,
    };
  });
}

/** OpenMeteo hourly forecast, °F, local timezone (keyless, free). */
export async function fetchForecast(lat: string, lon: string): Promise<ForecastHour[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m&temperature_unit=fahrenheit&forecast_days=2&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`open-meteo: HTTP ${res.status}`);
  const body = (await res.json()) as { hourly?: { time: string[]; temperature_2m: number[] } };
  if (!body.hourly) throw new Error("open-meteo: no hourly block");
  const now = Date.now() - 3600_000; // keep the current (partial) hour
  return body.hourly.time
    .map((t, i) => ({ ts: new Date(t), outdoorF: body.hourly!.temperature_2m[i] }))
    .filter((h) => h.ts.getTime() >= now && Number.isFinite(h.outdoorF));
}
