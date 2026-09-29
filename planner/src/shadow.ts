/**
 * @purpose A-5 shadow planner (summer v1) — computes what the day plan WOULD command,
 * hour by hour for the next 24 h: tank target + HP1 setpoint + a human-readable reason
 * per block. SHADOW ONLY: results go to the shadow_plans table and the dashboard, never
 * to a device. Summer logic = DHW-ready floor + one optional afternoon bank in the day's
 * warmest hour (flat electricity rate → COP timing is the only timing lever, plan §6.2, #58).
 * Hours whose
 * forecast drops below WINTER_GUARD_F fall back to mimicking the HBX reset curve, so
 * plan-vs-actual stays meaningful into the season the winter solver isn't built for yet.
 */

// One-way dependency: storm.ts imports nothing from this module, so this cannot cycle.
import { unitConverter } from "./storm";

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
  /** Excursion flags (the reason text also names them): the I8 soak, the #58 bank, the #135 pre-boost. */
  sani?: boolean;
  bank?: boolean;
  boost?: boolean;
}

/** #135: a learned draw window's boost, sized from the measured sag (see dhw.ts measureWindowSags). */
export interface PreBoost {
  windowStart: number; // local hour the window opens
  boostF: number;      // the rise above dhwFloorF the trough needs (sag p75), before decay allowance
  sagP75F: number;
  n: number;           // draws it was measured from
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
  bankF: number; // #58: one block/day at the warmest hour raised to dhwFloorF + bankF (0 = off; env BANK_F)
  /** #135: per learned window, the sag-sized pre-boost (absent / empty = no pre-boost, the pre-#135 plan). */
  preBoosts?: PreBoost[];
}

/** #135: a pre-boost below this is noise (one sample of standby drift) and is not planned. */
export const MIN_PREBOOST_F = 3;
/**
 * #135: a window needs at least this many measured draws before its sag sizes a boost — at 6 the
 * nearest-rank p75 is the 5th value, so one contaminated observation (a telemetry hole, a winter
 * zone call read as a draw) cannot set the boost by itself (codex, #148).
 */
export const MIN_PREBOOST_DRAWS = 6;
/**
 * #135: the most a pre-boost may add above the floor. A shower is ~9 °F of this buffer (20 gal at
 * 105 °F over C_eff 917 Btu/°F); a measured sag beyond this is not a draw the plan should chase.
 */
export const MAX_PREBOOST_F = 12;
/**
 * #135: standby loss the boosted heat suffers per hour before the window opens (dhw.ts: 0.65 kW over
 * C_eff ≈ 110 gal ⇒ ~2.4 °F/h, measured). A boost placed h hours ahead is raised by this much per hour
 * so the tank still arrives at floor + sag when the draws start.
 */
export const STANDBY_F_PER_H = 2.4;

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
  // #58 afternoon bank, OFF by default (wired to env BANK_F). Measured 2026-08-06 over 14 d:
  // 28% of charge starts landed 00–06h at ~63 °F outdoor while afternoons peaked ~85 °F — one
  // deliberate warm-hour charge carries the evening draws + overnight coast instead. Only ever
  // ADDS heat above the DHW floor, so it can never make a shower colder.
  bankF: 0,
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
  sanitizeUrgent = false,
): ShadowBlock[] {
  const hours = forecast.slice(0, 24);
  const inWindow = (h: number) => opts.dhwWindows.some(([a, b]) => h >= a && h < b);

  type Draft = { f: ForecastHour; localH: number; target: number; reason: string; sani?: boolean; bank?: boolean; boost?: boolean };
  const draft: Draft[] = hours.map((f) => {
    const localH = f.ts.getHours(); // TZ env makes this local time
    // Off-window still holds the DHW-ready floor — draws are unpredictable and happen year-round,
    // so the buffer can never coast below what a hot-water tap needs (Math.max makes that structural).
    return inWindow(localH)
      ? { f, localH, target: opts.dhwFloorF, reason: "DHW window floor" }
      : { f, localH, target: Math.max(opts.idleF, opts.dhwFloorF), reason: "off-window DHW-ready floor (draws possible any hour)" };
  });

  const byDay = new Map<string, Draft[]>();
  for (const d of draft) {
    const day = `${d.f.ts.getFullYear()}-${d.f.ts.getMonth()}-${d.f.ts.getDate()}`;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(d);
  }
  if (sanitizeDue) {
    // DEADLINE BACKSTOP. `sanitizeUrgent` = the hygiene window has actually LAPSED (no qualifying
    // dwell anywhere in the interval), as opposed to merely approaching. Then price stops mattering:
    // put the soak in the EARLIEST plannable hour instead of the day's warmest.
    //
    // Why this exists: waiting for the cheapest hour has no deadline override, so lateness compounds
    // instead of self-correcting. On 2026-07-31 a 17.75 h telemetry outage meant no plan and no soak;
    // on recovery the soak still waited for the next day's warmest hour, and the gap between
    // pasteurizations reached 75.2 h — past HYGIENE_HARD_MAX_H (72 h). The day-skip below
    // (`ds.length < 6`) makes that worse by deferring a late-in-the-day soak a further ~24 h.
    // Costs a few cents on the rare occasion it fires; hygiene is not a thing to optimise for price.
    if (sanitizeUrgent && draft.length) {
      const first = draft[0];
      first.target = opts.sanitizeF;
      first.sani = true;
      first.reason = `OVERDUE sanitize to ${opts.sanitizeF}°F = 60°C (I8 window lapsed — earliest hour, not the warmest)`;
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

  // #58 afternoon bank: one block/day at the day's warmest hour raised to dhwFloorF + bankF
  // (never above strictCapF). Buys the day's charge at the best outdoor COP and carries the
  // evening draws + overnight coast, trimming the ~63°F small-hours refires. Soak days are
  // skipped — the 140°F sanitize already banks far more than bankF. Phase B leads the pump
  // setpoints off this block (max(operative, plan)), so the raise clears I1 like the soak does.
  if (opts.bankF > 0) {
    const bankTo = Math.min(opts.dhwFloorF + opts.bankF, opts.strictCapF);
    for (const [, ds] of byDay) {
      if (ds.length < 6) continue; // too little day left for a deliberate charge to pay back
      if (ds.some((d) => d.sani || d.target >= opts.sanitizeF)) continue; // soak day IS the bank
      const warmest = ds.reduce((a, b) => (b.f.outdoorF > a.f.outdoorF ? b : a));
      if (bankTo <= warmest.target) continue;
      warmest.target = bankTo;
      warmest.bank = true;
      warmest.reason = `afternoon bank to ${bankTo}°F (warmest hour, ${warmest.f.outdoorF.toFixed(0)}°F outdoor)`;
    }
  }

  // #135 pre-boost: the flat DHW floor does not hold a hard draw (measured 2026-08-07: 102–117 °F with
  // both pumps at full call; the 16.5 kW element paid for the shortfall at COP 1.0). For each learned
  // window present in the horizon, the boost is SIZED FROM THE DRAW — the window's measured sag p75
  // (dhw.ts measureWindowSags) — and PLACED in the warmest of the preceding non-window hours (up to
  // prechargeLookbackH; flat rate + net metering ⇒ ambient is the only cost lever), raised by the
  // standby loss it will suffer before the bell so the trough, not the pre-draw peak, stays at the
  // floor. If that decay allowance would push the warmest hour past strictCap, the hour right before
  // the window (least decay) is used instead. Raises only, band-clamped below like every block; Phase B
  // leads the pump setpoints off it as it does for the bank. A pre-boost can never make a shower colder.
  // (This replaces the dormant pre-charge branch that could not fire since idleF == dhwFloorF, #58.)
  // Scheduled AFTER the soak and the bank so a deliberate excursion already in the lead interval is
  // seen: a soak or bank anywhere in the lead hours IS the pre-boost (it banks more), and a draft that
  // carries sani/bank is never re-labelled (one excursion identity per block; codex, #148).
  const boostFor = new Map<number, PreBoost>();
  for (const b of opts.preBoosts ?? []) if (b.n >= MIN_PREBOOST_DRAWS && b.boostF >= MIN_PREBOOST_F) boostFor.set(b.windowStart, b);
  for (const [start] of opts.dhwWindows) {
    const pb = boostFor.get(start);
    if (!pb) continue;
    const idx = draft.findIndex((d) => d.localH === start);
    if (idx <= 0) continue;
    const lead = draft.slice(Math.max(0, idx - opts.prechargeLookbackH), idx)
      .filter((d) => !inWindow(d.localH));
    if (!lead.length) continue;
    if (lead.some((d) => d.sani || d.bank)) continue; // the soak / bank in the lead IS the pre-boost
    const boostF = Math.min(pb.boostF, MAX_PREBOOST_F);
    const place = (d: Draft) => {
      const hoursAhead = Math.max(0, ((draft[idx].f.ts.getTime() - d.f.ts.getTime()) / 3600_000) - 1); // the lead hour itself is spent charging
      const raw = opts.dhwFloorF + boostF + STANDBY_F_PER_H * hoursAhead;
      return { d, hoursAhead, raw, to: Math.min(raw, opts.strictCapF) };
    };
    const warmest = place(lead.reduce((a, b) => (b.f.outdoorF > a.f.outdoorF ? b : a)));
    const chosen = warmest.raw > opts.strictCapF ? place(lead[lead.length - 1]) : warmest;
    if (chosen.to <= chosen.d.target) continue; // a bank / soak already sits higher — it IS the pre-boost
    chosen.d.target = chosen.to;
    chosen.d.boost = true;
    chosen.d.reason = `pre-boost to ${Math.round(chosen.to)}°F for ${String(start).padStart(2, "0")}:00 window (sag p75 ${pb.sagP75F}°F over ${pb.n} draws${boostF < pb.boostF ? `, capped at +${MAX_PREBOOST_F}` : ""}${chosen.hoursAhead > 0 ? `, +${Math.round(STANDBY_F_PER_H * chosen.hoursAhead)}°F standby over ${chosen.hoursAhead} h` : ""}; ${chosen === warmest ? "warmest lead hour" : "hour before the bell"}, ${chosen.d.f.outdoorF.toFixed(0)}°F)`;
  }

  // I8 thermal hygiene: boost the day's warmest (cheapest) hour to sanitizeF. Executed by the proven
  // plan→autopilot→Phase B path — Phase B leads the pump setpoints off THIS block's current-hour target
  // (phaseb.ts), so the 140°F soak clears I1 instead of deadlocking. Gated on `sanitizeDue`: the caller
  // passes true for the conservative daily soak (auto-sanitize OFF) or when a pasteurization is actually
  // due (auto-sanitize ON, demand-aware), and false to skip a redundant soak. checkI8 only alarms; it
  // never actuates — so the setpoint coordination is never bypassed.

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
    // Banked hours get the same treatment (hpMaxF is the reg-2027 nameplate line, which predates
    // live Phase B): without it a 128°F bank would advertise a 131°F setpoint — an I1-violating hour.
    const hpCapF = d.sani ? opts.sanitizeCapF + opts.i1MarginF
      : (d.bank || d.boost) ? opts.strictCapF + opts.i1MarginF
      : opts.hpMaxF;
    const hp1 = clamp(target + opts.i1MarginF, opts.hpMinF, hpCapF);
    return {
      ts: d.f.ts.toISOString(),
      outdoor_f: d.f.outdoorF,
      tank_target_f: Math.round(target),
      hp1_setpoint_f: Math.round(hp1),
      reason,
      ...(d.sani ? { sani: true } : {}),
      ...(d.bank ? { bank: true } : {}),
      ...(d.boost ? { boost: true } : {}),
    };
  });
}

/**
 * Pure half of fetchForecast — exported so the units contract is testable without a fetch.
 *
 * #122 audit, 2026-09-26: this fetch ASKED for fahrenheit and never checked what it RECEIVED —
 * the response type did not even include `hourly_units`. That is byte-for-byte the #112 bug that
 * armed storm mode off km/h-read-as-mph for two months; #113 fixed it in storm.ts and left this
 * copy untouched. And this is the feed that matters more: storm.ts decides whether to bank a few
 * degrees, while THIS feed sets curveTargetF — the tank target — every hour of winter. A °C body
 * here would put the buffer on the wrong curve silently.
 *
 * Same contract as parseStormForecast: convert from the unit the response DECLARES, and treat an
 * unreadable unit as fatal so the caller's catch leaves the last good forecast in place rather
 * than mixing scales.
 */
export function parseForecastBody(body: unknown, nowMs: number): ForecastHour[] {
  const b = body as { hourly?: { time?: string[]; temperature_2m?: (number | null)[] }; hourly_units?: Record<string, unknown> };
  if (!b?.hourly?.time) throw new Error("open-meteo: no hourly block");
  const toF = unitConverter("temperature_2m", b.hourly_units?.temperature_2m);
  return b.hourly.time
    .map((t, i) => ({ ts: new Date(t), outdoorF: toF(Number(b.hourly!.temperature_2m?.[i] ?? NaN)) }))
    .filter((h) => h.ts.getTime() >= nowMs && Number.isFinite(h.outdoorF));
}

/** OpenMeteo hourly forecast, °F, local timezone (keyless, free). */
/** How old a cached forecast may be and still stand in for a failed fetch (two open-meteo refresh cycles). */
export const FORECAST_CACHE_MAX_AGE_MS = 6 * 3600_000;

export interface ForecastResult {
  hours: ForecastHour[];
  source: "live" | "cached";
  /** When the hours were fetched from open-meteo (for a cached result: the cache's fetch time). */
  fetchedAt: Date;
  /** The live fetch's failure, when the result is cached. */
  error?: string;
}

/**
 * Live forecast, else the last good one. A fetch failure (open-meteo returns HTTP 429 after a burst of
 * deploys, each instance fetching on boot) used to abort the whole hourly step: no plan, no demand-floor
 * refresh, a degraded feed for an hour — for a 48-hour forecast that changes little in an hour. Now the
 * cached forecast (≤ maxAgeMs old, past hours trimmed the same way the live parser trims them) stands in
 * and the plan records `forecast_source: "cached"`; only when there is no usable cache does the original
 * error propagate. A live success refreshes the cache without waiting for it (bounded, fire-and-forget):
 * a cache write failure or hang never fails or delays the step.
 */
export async function forecastWithFallback(
  fetchLive: () => Promise<ForecastHour[]>,
  cache: { load: () => Promise<{ fetchedAt: Date; hours: ForecastHour[] } | null>; save: (hours: ForecastHour[]) => Promise<void> },
  nowMs: number,
  maxAgeMs: number = FORECAST_CACHE_MAX_AGE_MS,
  saveTimeoutMs: number = 5_000,
): Promise<ForecastResult> {
  try {
    const hours = await fetchLive();
    // The cache write is off the critical path: fire-and-forget, and the store bounds the statement
    // SERVER-SIDE (SET LOCAL statement_timeout / lock_timeout) so a stuck write releases its pooled
    // connection instead of holding one of the planner's three (codex). The race here only bounds how
    // long the warning waits.
    void Promise.race([
      cache.save(hours),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("forecast cache save timed out")), saveTimeoutMs).unref?.()),
    ]).catch((e) => console.warn("forecast cache save failed:", (e as Error).message));
    return { hours, source: "live", fetchedAt: new Date(nowMs) };
  } catch (e) {
    const error = (e as Error).message;
    let cached: { fetchedAt: Date; hours: ForecastHour[] } | null = null;
    try { cached = await cache.load(); } catch (le) { console.warn("forecast cache load failed:", (le as Error).message); }
    if (!cached || nowMs - cached.fetchedAt.getTime() > maxAgeMs) throw e;
    const hours = cached.hours.filter((h) => h.ts.getTime() >= nowMs - 3600_000); // keep the current (partial) hour, like the live parser
    if (hours.length === 0) throw e;
    console.warn(`forecast fetch failed (${error}); using the cached forecast from ${cached.fetchedAt.toISOString()}`);
    return { hours, source: "cached", fetchedAt: cached.fetchedAt, error };
  }
}

export async function fetchForecast(lat: string, lon: string): Promise<ForecastHour[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m&temperature_unit=fahrenheit&forecast_days=2&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`open-meteo: HTTP ${res.status}`);
  return parseForecastBody(await res.json(), Date.now() - 3600_000); // keep the current (partial) hour
}
