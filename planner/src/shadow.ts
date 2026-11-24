/**
 * @purpose A-5 shadow planner (summer v1) — computes what the day plan WOULD command,
 * hour by hour for the next 24 h: tank target + HP1 setpoint + a human-readable reason
 * per block. SHADOW ONLY: results go to the shadow_plans table and the dashboard, never
 * to a device. Summer logic = DHW-ready floor + one optional afternoon bank in the day's
 * warmest hour (flat electricity rate → COP timing is the only timing lever, plan §6.2, #58),
 * chosen ONCE per local day — the plan history is the memory (priorExcursionsFromPlans), so the
 * hourly recompute cannot re-bank the current hour on a falling afternoon. Hours whose
 * forecast drops below WINTER_GUARD_F fall back to mimicking the HBX reset curve, so
 * plan-vs-actual stays meaningful into the season the winter solver isn't built for yet — except the
 * #135 pre-boost, which keeps its own target through the guard (2026-11 winter mornings lost the boost
 * to the winter guard; raiseBoostsToGuard covers the flat-write path).
 */

// One-way dependency: storm.ts imports nothing from this module, so this cannot cycle.
import { unitConverter } from "./storm";
import { localDayKey } from "./dhw"; // dhw.ts imports nothing

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
  /** Excursion flags (the reason text also names them): the I8 soak, the #58 bank, the #135 pre-boost, the §6.11 storm raise. */
  sani?: boolean;
  bank?: boolean;
  boost?: boolean;
  /** a2w#156: set by index.ts storm shaping — authorises the block to run up to STORM_CAP_F in the auto-pilot. */
  storm?: boolean;
  /**
   * 2026-11 winter mornings lost the boost to the winter guard: on a pre-boost block the as-found curve mimic no longer
   * replaces the boost (the boost keeps its own target, flag and reason). This records what the guard WOULD have
   * written — the neighbouring mimic hours' target — only on a boost block it would have raised. Read by
   * raiseBoostsToGuard (index.ts, no shaped curve): when every block is written flat, a 130 °F boost between
   * 135 °F mimic hours would be a dip, so the boost hour is held at least at this value.
   */
  guard_f?: number;
}

/** #135: a learned draw window's boost, sized from the measured sag (see dhw.ts measureWindowSags). */
export interface PreBoost {
  windowStart: number; // local hour the PEAK draw window opens (dhw.ts peakWindows, not the padded floor window)
  windowEnd: number;   // local hour, exclusive
  boostF: number;      // the rise above dhwFloorF the trough needs (sag p90 since 2026-10-30; p75 before), before decay allowance
  sagP75F: number;
  /** the 90th-percentile sag the boost was sized from (absent on pre-2026-10-30 plans — the reason then names p75) */
  sagP90F?: number;
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
  /**
   * Rolling-horizon fix (2026-10-20): the bank / soak blocks the plan HISTORY already placed at hours that have
   * started (priorExcursionsFromPlans). The bank is chosen once per local day: a past bank or soak on a day means
   * its deliberate charge is spent; a bank on the current hour stays where it is. Absent / empty = no memory —
   * the pre-fix plan, which re-banked the current hour every recompute on a falling afternoon.
   * #285: the same memory keeps a pre-boost the history placed on the CURRENT hour at the target the auto-pilot
   * already commanded, so a replan late in the hour does not rewrite it.
   */
  priorExcursions?: PriorExcursion[];
  /**
   * 2026-11-24 (a soak gets a full hour): true when the plan history behind priorExcursions was READ (even if empty).
   * Only then does the soak use the memory — a soak in progress is kept to the end of its hour, a new soak never
   * lands on the hour in progress, the overdue soak spans two blocks. Anything but `true` = the soak exactly as before
   * (an unreadable history must never drop a running soak in the middle of its hour).
   */
  priorExcursionsKnown?: boolean;
  /**
   * index.ts sanitizeDueNow().measured: the last dwell was actually read (auto-sanitize on, no error). Anything but
   * `true` = `sanitizeDue` is the unconditional daily soak, so (with priorExcursionsKnown) a day whose history already
   * holds a soak gets no new one.
   */
  sanitizeDueMeasured?: boolean;
}

/** A bank / soak / pre-boost block the plan history placed at an hour that has started (ts ≤ now). */
export interface PriorExcursion {
  ts: string; // ISO hour start, as stored in the plan block
  bank?: boolean;
  sani?: boolean;
  /** #285: a pre-boost the history placed, with the target it was commanded at (what a replan keeps in force). */
  boost?: boolean;
  tank_target_f?: number;
}

/** Local-day key (the TZ env makes the Date getters local) — the unit the bank and the soak are planned per. */
const dayKeyOf = localDayKey;

/**
 * The excursions the plan history has already placed at hours that have started — what computeShadowPlan's bank
 * (and, #285, its pre-boost) remembers across the hourly recompute. The NEWEST plan covering an hour decides that
 * hour (a bank an older plan placed and a newer plan moved never happened: the newer plan was the one in force);
 * blocks whose hour has not started yet are ignored (the recompute may still move them). Plans are taken oldest →
 * newest (by `computedAt` when present, else in the given order, which store.recentPlans already guarantees). A
 * pre-boost carries its stored tank_target_f: that is the number the auto-pilot commanded for the hour, and what a
 * replan keeps.
 */
export function priorExcursionsFromPlans(plans: { computedAt?: Date; plan: unknown }[], nowMs: number): PriorExcursion[] {
  const ordered = [...plans].sort((a, b) => (a.computedAt?.getTime() ?? 0) - (b.computedAt?.getTime() ?? 0));
  const byHour = new Map<number, PriorExcursion>();
  for (const p of ordered) {
    if (!Array.isArray(p.plan)) continue;
    for (const b of p.plan as { ts?: unknown; bank?: unknown; sani?: unknown; boost?: unknown; tank_target_f?: unknown }[]) {
      const ts = typeof b?.ts === "string" ? b.ts : null;
      const t = ts == null ? NaN : new Date(ts).getTime();
      if (ts == null || !Number.isFinite(t) || t > nowMs) continue;
      const target = Number(b.tank_target_f);
      byHour.set(t, { ts, bank: b.bank === true, sani: b.sani === true, boost: b.boost === true, ...(Number.isFinite(target) ? { tank_target_f: target } : {}) });
    }
  }
  return [...byHour.values()].filter((e) => e.bank || e.sani || e.boost);
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
 * 105 °F over C_eff 917 Btu/°F); back-to-back morning showers measured 13–18 °F (Oct 2026). Raised 12 → 16 on
 * 2026-10-30 (owner: showers ran lukewarm at the 120 °F floor; the mixing valve is set to ~120 °F, so any draw from a
 * 120 °F tank delivers below it). strictCapF (135) still bounds the commanded target: 120 + 16 = 136 → 135.
 */
export const MAX_PREBOOST_F = 16;

/**
 * DHW-ready floor (°F) — the number that sets the tank target in almost every hour (deep dive 2026-10-19 §2),
 * and an assumption: 120 = delivery + an assumed 5–8 °F coil approach, never measured (#138.2). Owner decision
 * 2026-10-29: step it to 116 for a week and watch the morning-draw troughs (/health.dhw). Env DHW_FLOOR_F,
 * clamped to [DHW_FLOOR_MIN_F, DHW_FLOOR_MAX_F]; unset, empty or unparseable = 120 (behaviour unchanged).
 * idleF follows it: the off-window target was set equal to the floor, so moving only dhwFloorF would leave
 * the idle plan at 120. The I8 soak (sanitizeF) is independent and unchanged.
 */
export const DHW_FLOOR_DEFAULT_F = 120;
export const DHW_FLOOR_MIN_F = 112;
export const DHW_FLOOR_MAX_F = 125;
export function parseDhwFloorF(raw: string | undefined): number {
  const v = Number(raw);
  if (raw == null || raw.trim() === "" || !Number.isFinite(v)) return DHW_FLOOR_DEFAULT_F;
  return Math.min(DHW_FLOOR_MAX_F, Math.max(DHW_FLOOR_MIN_F, v));
}
export const DHW_FLOOR_F = parseDhwFloorF(process.env.DHW_FLOOR_F);

export const DEFAULT_OPTS: ShadowOpts = {
  dhwWindows: [[6, 9], [17, 22]],
  dhwFloorF: DHW_FLOOR_F, // minimum DHW-ready buffer temp — below this an unexpected draw is lukewarm (env DHW_FLOOR_F)
  // Off-window target. The buffer feeds DHW and draws are unpredictable / year-round, so we never
  // coast below DHW-ready — a cold shower isn't worth the trivial standby saving of a 110°F idle.
  // Enforced ≥ dhwFloorF at the use site; raise this only to bank EXTRA capacity, never below it.
  idleF: DHW_FLOOR_F, // follows the floor (env DHW_FLOOR_F) — see DHW_FLOOR_F above
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
    const day = dayKeyOf(d.f.ts);
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
    //
    // A SOAK GETS A FULL HOUR (2026-11-24; only with a readable plan history, opts.priorExcursionsKnown). draft[0] is
    // the hour in progress: a soak placed on it at :42 was written at ~:47 and replaced by the next block at ~:07 —
    // ~15 min at 140 °F, never the 30-min dwell (11 of 47 soaks over 8 weeks; the overdue path repeated it hourly).
    // So with the memory: a soak the history placed on the hour in progress is KEPT at its commanded target while
    // the soak is still due (once the dwell qualifies or the rest period begins it may end before its hour does);
    // a NEW soak never takes the hour in progress (the warmest of the day's other blocks); the overdue soak spans
    // the hour in progress AND the next; and when the dwell is not measured (auto-sanitize off: due is always true)
    // a day whose history already holds a soak gets no new one. Without the memory: exactly the pre-2026-11-24 plan.
    const memory = opts.priorExcursionsKnown === true;
    const priorSoaks = memory ? (opts.priorExcursions ?? []).filter((p) => p.sani) : [];
    if (sanitizeUrgent && draft.length) {
      for (const d of memory ? draft.slice(0, 2) : draft.slice(0, 1)) {
        d.target = opts.sanitizeF;
        d.sani = true;
        d.reason = `OVERDUE sanitize to ${opts.sanitizeF}°F = 60°C (I8 window lapsed — earliest hour, not the warmest)`;
      }
    }
    const keptSoak = draft.length ? priorSoaks.find((p) => new Date(p.ts).getTime() === draft[0].f.ts.getTime()) : undefined;
    if (keptSoak) {
      const first = draft[0];
      first.target = Math.min(opts.sanitizeCapF, Math.max(opts.sanitizeF, keptSoak.tank_target_f ?? opts.sanitizeF));
      first.sani = true;
      first.reason = `${sanitizeUrgent ? "OVERDUE" : "daily"} sanitize to ${Math.round(first.target)}°F = 60°C (I8 pasteurization in progress; kept from the previous plan so the soak gets its full hour)`;
    }
    for (const [day, ds] of byDay) {
      if (ds.length < 6) continue; // partial day at the horizon edge — next plan covers it
      if (ds.some((d) => d.target >= opts.sanitizeF)) continue;
      if (memory && opts.sanitizeDueMeasured !== true && priorSoaks.some((p) => dayKeyOf(new Date(p.ts)) === day)) continue; // not measured: the day had its soak
      const candidates = memory ? ds.filter((d) => d !== draft[0]) : ds;
      const warmest = candidates.reduce((a, b) => (b.f.outdoorF > a.f.outdoorF ? b : a));
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
    const prior = opts.priorExcursions ?? [];
    for (const [day, ds] of byDay) {
      // Rolling-horizon fix (root-caused 2026-08-08, measured again 2026-10-19: 101 of the 145 bank writes since
      // Sep 1 were the SECOND write in their hour). The forecast starts at the current hour, so on a falling
      // afternoon "the warmest remaining hour" is always NOW and every hourly recompute re-banked the current hour:
      // the auto-pilot wrote the floor at :04 from the old plan and the bank at :19 from the new one, every hour
      // until <6 h of day remained. The plan HISTORY is the memory — the bank is chosen ONCE per local day:
      //  - a bank the history placed at a PAST hour of this day, or a soak at any started hour ("soak day IS the
      //    bank" must still hold after the soak hour has left the horizon), means the day's charge is spent;
      //  - a bank it placed on the CURRENT hour is kept there (the auto-pilot has already commanded it), not
      //    re-derived — even with <6 h of day left, so the hour the bank was written in cannot drop it.
      const priorToday = prior.filter((p) => dayKeyOf(new Date(p.ts)) === day);
      const dayStartMs = ds[0].f.ts.getTime();
      if (priorToday.some((p) => p.sani || (p.bank && new Date(p.ts).getTime() < dayStartMs))) continue; // spent
      const pinned = ds.find((d) => priorToday.some((p) => p.bank && new Date(p.ts).getTime() === d.f.ts.getTime()));
      if (pinned) {
        if (!pinned.sani && bankTo > pinned.target) {
          pinned.target = bankTo;
          pinned.bank = true;
          pinned.reason = `afternoon bank to ${bankTo}°F (warmest hour, ${pinned.f.outdoorF.toFixed(0)}°F outdoor; kept from the previous plan)`;
        }
        continue;
      }
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
  // window present in the horizon, the boost is SIZED FROM THE DRAW — the window's measured sag p90
  // (dhw.ts measureWindowSags) — and PLACED in the hour right before the window opens, so the tank is
  // at boost height when the draws start. Raises only, band-clamped below like every block; Phase B
  // leads the pump setpoints off it as it does for the bank. A pre-boost can never make a shower colder.
  // (This replaces the dormant pre-charge branch that could not fire since idleF == dhwFloorF, #58.)
  //
  // #285 (2026-11-10): until now the boost went to the WARMEST lead hour with a 2.4 °F/h standby allowance,
  // falling back to the hour before the bell only when that allowance breached the everyday cap. Sized at
  // 15 °F the allowance always breached it, so the boost sat at 05:00 and the tank was at 130 °F by 06:00
  // (Oct 30 – Nov 1). When the rolling p90 fell to 10 °F the allowance fit (120 + 10 + 4.8 = 134.8) and
  // the boost moved to 03:00 — the warmest overnight hour — where it charged the tank to 135–138 °F and
  // then the 120 °F floor blocks at 04:00 and 05:00 let it coast to 122–128 °F by the showers (Nov 2–4,
  // 6, 7). Every hourly replan then re-placed it on whichever lead hour was current (04:00, then 05:00),
  // so the auto-pilot wrote floor / boost / floor / boost each morning. The allowance modelled standby
  // loss against a target the floor blocks did not hold. Now: the boost is always the hour before the
  // bell (no block between it and the window can lower the target), sized floor + sag, and a boost the
  // plan history already placed on the CURRENT hour is kept at its commanded target (priorExcursions, the
  // bank's memory) so a replan late in the hour reads "already commanded" instead of rewriting it.
  //
  // Scheduled AFTER the soak and the bank so a deliberate excursion already in the lead interval is
  // seen: a soak or bank anywhere in the lead hours IS the pre-boost (it banks more), and a draft that
  // carries sani/bank is never re-labelled (one excursion identity per block; codex, #148).
  // Keyed to the PEAK draw windows the boosts were measured over (dhw.ts peakWindows), not the padded
  // floor windows: on this house those cover nearly the whole day, so "before the window" would mean
  // "before midnight". A lead hour must not itself lie inside a peak (that is where the draws are), so
  // the boost takes the latest lead hour outside every peak (the hour before the bell unless that hour
  // belongs to another peak). Every learned peak excludes lead hours (a draw is predictable there whether
  // or not its sag earned a boost); only the peaks with enough measured draws and sag RECEIVE a boost
  // (codex, #148).
  const allPeaks = opts.preBoosts ?? [];
  const inPeak = (h: number) => allPeaks.some((b) => h >= b.windowStart && h < b.windowEnd);
  const peaks = allPeaks.filter((b) => b.n >= MIN_PREBOOST_DRAWS && b.boostF >= MIN_PREBOOST_F);
  const priorBoosts = (opts.priorExcursions ?? []).filter((p) => p.boost);
  // 2026-11 winter mornings lost the boost to the winter guard — and once (Nov 13) to a window shift: the 04:21 replan
  // found the 04:00 boost the auto-pilot had written at 04:06, but the learned peaks had moved to [5,10) → [3,10), so
  // 04:00 was no longer a lead hour of any window and the per-window lookup below never saw it; the block went back to
  // the 120 °F floor with the showers an hour away. A boost the history placed on an hour that has STARTED is kept at
  // its commanded target whatever the windows now say — inside a peak, outside every lead — and whichever window still
  // leads from it refines the reason below. Pinned FIRST so no window can place a second boost on the same hour.
  const pinned = new Set<Draft>();
  for (const p of priorBoosts) {
    const t = new Date(p.ts).getTime();
    const kept = draft.find((d) => !d.sani && !d.bank && d.f.ts.getTime() === t);
    if (!kept || pinned.has(kept)) continue;
    kept.target = Math.min(Math.max(kept.target, p.tank_target_f ?? kept.target), opts.strictCapF);
    kept.boost = true;
    kept.reason = `pre-boost to ${Math.round(kept.target)}°F (kept from the previous plan after the learned windows moved, ${kept.f.outdoorF.toFixed(0)}°F)`;
    pinned.add(kept);
  }
  for (const pb of peaks) {
    const start = pb.windowStart;
    const idx = draft.findIndex((d) => d.localH === start);
    if (idx <= 0) continue;
    const lead = draft.slice(Math.max(0, idx - opts.prechargeLookbackH), idx)
      .filter((d) => !inPeak(d.localH));
    if (!lead.length) continue;
    const window = `${String(start).padStart(2, "0")}:00 window`;
    const sag = `sag ${pb.sagP90F != null ? `p90 ${pb.sagP90F}` : `p75 ${pb.sagP75F}`}°F over ${pb.n} draws`;
    // #285: a boost the history placed on a lead hour that has STARTED (only the current hour can be) is kept there at
    // the target the auto-pilot commanded — never re-derived, never moved (pinned above, at that target). The reason
    // still reads as a pre-boost (curveDecision, the poster, the identification driver all match on it), names this
    // window and says it was kept.
    const kept = lead.find((d) => pinned.has(d));
    if (kept) {
      kept.reason = `pre-boost to ${Math.round(kept.target)}°F for ${window} (${sag}; kept from the previous plan, ${kept.f.outdoorF.toFixed(0)}°F)`;
      continue;
    }
    if (lead.some((d) => d.sani || d.bank)) continue; // the soak / bank in the lead IS the pre-boost
    const boostF = Math.min(pb.boostF, MAX_PREBOOST_F);
    const to = Math.min(opts.dhwFloorF + boostF, opts.strictCapF);
    const chosen = lead[lead.length - 1]; // the hour before the bell: nothing after it can let the charge coast away
    if (to <= chosen.target) continue; // a bank / soak already sits higher — it IS the pre-boost
    chosen.target = to;
    chosen.boost = true;
    chosen.reason = `pre-boost to ${Math.round(to)}°F for ${window} (${sag}${boostF < pb.boostF ? `, capped at +${MAX_PREBOOST_F}` : ""}; hour before the bell, ${chosen.f.outdoorF.toFixed(0)}°F)`;
  }

  // I8 thermal hygiene: boost the day's warmest (cheapest) hour to sanitizeF — with a readable plan history, the
  // warmest hour AFTER the one in progress, and a soak already in progress keeps its hour. Executed by the proven
  // plan→autopilot→Phase B path — Phase B leads the pump setpoints off THIS block's current-hour target
  // (phaseb.ts), so the 140°F soak clears I1 instead of deadlocking. Gated on `sanitizeDue`: the caller
  // passes true for the conservative daily soak (auto-sanitize OFF) or when a pasteurization is actually
  // due (auto-sanitize ON, demand-aware), and false to skip a redundant soak. checkI8 only alarms; it
  // never actuates — so the setpoint coordination is never bypassed.

  return draft.map((d) => {
    let target = d.target;
    let reason = d.reason;
    let guardF: number | null = null;
    if (d.f.outdoorF < opts.winterGuardF) {
      // The winter floor only takes the block's REASON when it actually raises the target: a soak, bank
      // or pre-boost that already sits higher keeps its identity, so the poster and the auto-pilot
      // still see the excursion they are meant to see (#135 codex; previously the reason was rewritten
      // unconditionally and a winter soak read as "binding zone").
      // When the floor wins, a bank did not happen: the block is demand-driven, so it drops that flag
      // (one identity per block — the poster must file it as autopilot, not bank, and a DP raise
      // afterwards appends to the floor's reason). The soak is never subsumed — and, since 2026-11-19,
      // neither is the pre-boost.
      //
      // 2026-11 winter mornings lost the boost to the winter guard (Nov 8–16, every night at 32–40 °F): the as-found
      // curve (~135 °F) outran the 129–131 °F boost, the block became "winter guard: mimic HBX curve" with boost =
      // false, and the auto-pilot — a non-excursion hour in shaped-curve mode — wrote the ~120 °F shaped curve
      // instead. The tank never boosted before the showers, and with no boost in the plan the identification
      // experiment moved into the lead hours. Owner decision 2026-11-19: the boost stays at its own target. A boost
      // block keeps its flag and its pre-boost reason in both branches; the demand floor may still raise its TARGET
      // (never lower it, the sani pattern), the curve mimic only records what it would have written (guard_f, for
      // the flat-write path — raiseBoostsToGuard).
      if (demandFloor) {
        if (demandFloor.tankTargetF > target) {
          target = demandFloor.tankTargetF;
          const floorReason = `binding zone: ${demandFloor.bindingZone} needs ${Math.round(demandFloor.awtF)}°F (winter solver shadow)`;
          // a2w#155: the soak is never subsumed — when the floor outruns the 140 °F soak the block is STILL the
          // soak (its `sani` flag and its sanitizeCapF ceiling stay), so its reason must keep saying so: the
          // poster files it as the soak and the identification driver keeps its distance (planConflictAhead
          // matches /sanitize/). Before this the reason was rewritten to the floor's and the identity was lost.
          // The pre-boost follows the same rule: its target becomes the floor's, its identity stays.
          reason = d.sani || d.boost
            ? `${d.reason} — raised to the demand floor ${Math.round(target)}°F (${floorReason})`
            : floorReason;
          d.bank = false;
        }
      } else if (hbxConfig) {
        const curve = curveTargetF(hbxConfig, d.f.outdoorF);
        if (curve != null && curve > target) {
          if (d.boost) {
            guardF = curve; // the boost stays at its own target; what the guard would have written rides along
          } else {
            target = curve;
            // a2w#168 (the #155 class, one branch over): when the as-found curve outruns the 140 °F soak the block is
            // STILL the soak — its `sani` flag and sanitizeCapF ceiling stay, so the reason must keep saying so, or the
            // poster files the hour as autopilot and the identification driver (planConflictAhead matches /sanitize/)
            // stops keeping its distance. Measured twice on 2026-10-17: "set 145°F — winter guard: mimic HBX curve".
            reason = d.sani
              ? `${d.reason} — raised to the as-found curve ${Math.round(target)}°F (winter guard)`
              : "winter guard: mimic HBX curve";
            d.bank = false;
          }
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
    // guard_f is the mimic target the neighbouring hours get: the curve through the same band clamp and rounding.
    const guard = guardF != null ? Math.round(clamp(guardF, band.lo, band.hi)) : null;
    return {
      ts: d.f.ts.toISOString(),
      outdoor_f: d.f.outdoorF,
      tank_target_f: Math.round(target),
      hp1_setpoint_f: Math.round(hp1),
      reason,
      ...(d.sani ? { sani: true } : {}),
      ...(d.bank ? { bank: true } : {}),
      ...(d.boost ? { boost: true } : {}),
      ...(guard != null && guard > Math.round(target) ? { guard_f: guard } : {}),
    };
  });
}

/**
 * Degraded-mode safety for the pre-boost (2026-11 winter mornings lost the boost to the winter guard). Since the
 * guard no longer raises a boost block to the as-found curve, a plan with NO shaped curve stamped (demand feed
 * degraded, SHAPED_CURVE off — index.ts) is written flat block by block, and a 130 °F boost between 135 °F mimic
 * hours would be a dip right before the showers. Pure: returns a new plan in which every boost block carrying a
 * guard_f below which it sits is raised to that value, with the advisory HP line re-led the way the DP / storm
 * passes do (target + i1MarginF, clamped to [hpMinF, strictCapF + i1MarginF]); every other block is the same object.
 * With a shaped curve stamped the mimic hours run the curve (~120 °F) and the boost is the excursion above it, so
 * the caller must NOT apply this there — it would turn the boost into the guard it was rescued from.
 */
export function raiseBoostsToGuard(
  plan: ShadowBlock[],
  opts: Pick<ShadowOpts, "i1MarginF" | "hpMinF" | "strictCapF"> = DEFAULT_OPTS,
): ShadowBlock[] {
  return plan.map((b) => {
    if (b.boost !== true || typeof b.guard_f !== "number" || !(b.guard_f > b.tank_target_f)) return b;
    const raised = Math.round(b.guard_f);
    return {
      ...b,
      tank_target_f: raised,
      hp1_setpoint_f: Math.round(clamp(raised + opts.i1MarginF, opts.hpMinF, opts.strictCapF + opts.i1MarginF)),
      reason: `${b.reason}; held at the winter guard's ${raised}°F (no shaped curve: every block is written flat)`,
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
    `${process.env.OPEN_METEO_URL || "https://api.open-meteo.com"}/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m&temperature_unit=fahrenheit&forecast_days=2&timezone=auto`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`open-meteo: HTTP ${res.status}`);
  return parseForecastBody(await res.json(), Date.now() - 3600_000); // keep the current (partial) hour
}
