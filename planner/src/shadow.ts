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

/** §6.9 winter-solver shadow: the demand engine's proposed tank floor for this plan. */
export interface DemandFloor {
  tankTargetF: number;
  bindingZone: string;
  awtF: number;
}

export interface ShadowOpts {
  dhwWindows: [number, number][]; // local-hour ranges [start, endExclusive]
  dhwFloorF: number;
  idleF: number;
  prechargeLookbackH: number;
  i1MarginF: number;
  hpMinF: number; // unattended winter floor, 45 °C
  hpMaxF: number; // reg-2027 cap, 55 °C
  winterGuardF: number;
  sanitizeF: number; // I8: daily thermal-hygiene excursion target (140 °F = 60 °C pasteurization)
  strictCapF: number; // I4: everyday hard ceiling until Phase B actively manages HP setpoints
  sanitizeCapF: number; // I8: the daily sanitize excursion may exceed strictCapF up to here (I1 still guards)
}

export const DEFAULT_OPTS: ShadowOpts = {
  dhwWindows: [[6, 9], [17, 22]],
  dhwFloorF: 120, // minimum DHW-ready buffer temp — below this an unexpected draw is lukewarm
  // Off-window target. The buffer feeds DHW and draws are unpredictable / year-round, so we never
  // coast below DHW-ready — a cold shower isn't worth the trivial standby saving of a 110°F idle.
  // Enforced ≥ dhwFloorF at the use site; raise this only to bank EXTRA capacity, never below it.
  idleF: 120,
  prechargeLookbackH: 3,
  i1MarginF: 5, // A-4-measured 2026-07-14: tank sensor terminated at +3.1°F; 5 keeps a cushion
  hpMinF: 113,
  hpMaxF: 131,
  winterGuardF: 50,
  // 140 °F = 60 °C: Legionella die in ~32 min vs ~5–6 h at 131 °F/55 °C — the daily soak is a REAL
  // pasteurization of the DHW coil's potable slug. Exceeds the everyday strictCap (135), so it uses
  // sanitizeCapF below; I1 still requires the pump setpoints to cover it (setpoint ≥ target + margin).
  sanitizeF: 140,
  strictCapF: 135,
  sanitizeCapF: 145, // hard ceiling for the 140 °F soak (bypasses curve+3); < the 154 °F the hardware ran as-found
};

/**
 * I4 envelope (plan §5.1, revised 2026-07-14): outdoor-indexed, not seasonal.
 * Lower line = binding-zone minimum: 95 °F tank at ≥55 °F outdoor rising linearly to
 * 135 °F at 5 °F outdoor. Upper line = as-found HBX curve + 3 °F (never hotter than the
 * regime the hardware already tolerated), strict-capped until Phase B holds HP setpoints
 * above commanded targets. Pure function of outdoor temp — intelligence stays in the plan.
 */
export function bandFor(
  outdoorF: number,
  hbxConfig: Record<string, any> | null,
  capF: number,
  sanitize = false,
): { lo: number; hi: number } {
  const t = Math.min(Math.max(outdoorF, 5), 55);
  const lo = 95 + ((55 - t) / 50) * 40; // 55°F→95, 5°F→135
  // The daily sanitize is a deliberate hygiene excursion ABOVE the everyday regime, so its ceiling is
  // capF (sanitizeCapF) directly — NOT the as-found curve+3 comfort limit (which, at the warmest hour
  // where the sanitize is scheduled, is at its lowest and would clamp 140 back down). Still bounded
  // well under the 154°F the hardware ran as-found, and I1 always requires setpoints to cover it.
  if (sanitize) return { lo, hi: Math.max(capF, lo) };
  const curve = hbxConfig ? curveTargetF(hbxConfig, outdoorF) : null;
  const hi = Math.min(curve != null ? curve + 3 : capF, capF);
  return { lo, hi: Math.max(hi, lo) };
}

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
  demandFloor?: DemandFloor | null,
  sanitizeDue = true,
): ShadowBlock[] {
  const hours = forecast.slice(0, 24);
  const inWindow = (h: number) => opts.dhwWindows.some(([a, b]) => h >= a && h < b);

  type Draft = { f: ForecastHour; localH: number; target: number; reason: string; sani?: boolean };
  const draft: Draft[] = hours.map((f) => {
    const localH = f.ts.getHours(); // TZ env makes this local time
    // Off-window still holds the DHW-ready floor — draws are unpredictable and happen year-round,
    // so the buffer can never coast below what a hot-water tap needs (Math.max makes that structural).
    return inWindow(localH)
      ? { f, localH, target: opts.dhwFloorF, reason: "DHW window floor" }
      : { f, localH, target: Math.max(opts.idleF, opts.dhwFloorF), reason: "off-window DHW-ready floor (draws possible any hour)" };
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

  // I8 thermal hygiene: boost the day's warmest (cheapest) hour to sanitizeF. Executed by the proven
  // plan→autopilot→Phase B path — Phase B leads the pump setpoints off THIS block's current-hour target
  // (phaseb.ts), so the 140°F soak clears I1 instead of deadlocking. Gated on `sanitizeDue`: the caller
  // passes true for the conservative daily soak (auto-sanitize OFF) or when a pasteurization is actually
  // due (auto-sanitize ON, demand-aware), and false to skip a redundant soak. checkI8 only alarms; it
  // never actuates — so the setpoint coordination is never bypassed.
  if (sanitizeDue) {
    const byDay = new Map<string, Draft[]>();
    for (const d of draft) {
      const day = `${d.f.ts.getFullYear()}-${d.f.ts.getMonth()}-${d.f.ts.getDate()}`;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(d);
    }
    for (const [, ds] of byDay) {
      if (ds.length < 6) continue; // partial day at the horizon edge — next plan covers it
      if (ds.some((d) => d.target >= opts.sanitizeF)) continue;
      const warmest = ds.reduce((a, b) => (b.f.outdoorF > a.f.outdoorF ? b : a));
      warmest.target = opts.sanitizeF;
      warmest.sani = true;
      warmest.reason = `daily sanitize to ${opts.sanitizeF}°F = 60°C (I8 pasteurization, warmest hour)`;
    }
  }

  return draft.map((d) => {
    let target = d.target;
    let reason = d.reason;
    if (d.f.outdoorF < opts.winterGuardF) {
      if (demandFloor) {
        target = Math.max(target, demandFloor.tankTargetF);
        reason = `binding zone: ${demandFloor.bindingZone} needs ${Math.round(demandFloor.awtF)}°F (winter solver shadow)`;
      } else if (hbxConfig) {
        const curve = curveTargetF(hbxConfig, d.f.outdoorF);
        if (curve != null && curve > target) {
          target = curve;
          reason = "winter guard: mimic HBX curve (winter solver not built yet)";
        }
      }
    }
    // The daily sanitize excursion may exceed the everyday strictCap (up to sanitizeCapF); every
    // other hour stays clamped to strictCap. I1 (below, and in the writer) still requires the pump
    // setpoints to cover whatever target this yields — the higher ceiling never bypasses that.
    const cap = d.sani ? opts.sanitizeCapF : opts.strictCapF;
    const band = bandFor(d.f.outdoorF, hbxConfig, cap, d.sani);
    target = clamp(target, band.lo, band.hi);
    // Advisory HP line must cover the target (setpoints lead it up — Phase B does this live), so the
    // sanitize hour is allowed a higher HP cap; otherwise the plan would draw setpoint < target.
    const hpCapF = d.sani ? opts.sanitizeCapF + opts.i1MarginF : opts.hpMaxF;
    const hp1 = clamp(target + opts.i1MarginF, opts.hpMinF, hpCapF);
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
