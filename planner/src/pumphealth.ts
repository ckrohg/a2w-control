/**
 * @purpose Owner ask 2026-10-19: a heat pump that RUNS (or draws power) WITHOUT PRODUCING HEAT and shows no fault code,
 * plus per-pump daily health so a slow decline shows. Every existing alarm keys on a fault code (fault_called, self-heal)
 * or on a pump NOT running while called (stage_unserved, all_idle). Nothing looked at whether a running pump makes heat.
 *
 * Five window checks per poll, from the mirror's `readings` (bridge-derived state + temps, ~60 s) and `span_readings`
 * (SPAN local, ~25 s, consumption NEGATIVE — magnitude used throughout), plus the HBX tank for called_tank_flat:
 *   running_no_lift  — heating steadily 15 min (≥ 5 min into the run, ≥ 5 min after defrost) at ≥ 1 kW, mean ΔT < 1.5 °C
 *   heating_no_draw  — reports heating ≥ 7 min, SPAN 5-min mean < 1 kW
 *   idle_draw        — reports idle/off ≥ 10 min, SPAN 9-min mean > 1 kW (stuck contactor, internal heater)
 *   defrost_overlong — reports defrost continuously > 12 min (register 2016 max defrost time: default 8, range 5–20; weekly review 2026-10-26): stagewatch
 *                      SUSPENDS its clock in defrost, so a stuck "defrost" while called was invisible (Oct 18, 83 min)
 *   called_tank_flat — stage called + its pump engaged (heating/defrost) ≥ 90 % of 45 min, tank net rise + standby loss
 *                      ≤ 2 °F AND the unit's mean ΔT over it < 1.5 °C, for 30 min (a flat tank ALONE is house load — measured)
 * Thresholds are MEASURED: knowledge/reference/pump-health-baseline-20261019.md. A window whose data is stale or gappy is
 * "unknown" and moves nothing — the stagewatch rule: a blind spell never opens or closes an episode.
 * The daily rollup (rollupDay) and trend (trend) feed /health.pump_health and the daily digest. Pure — no I/O.
 */
import { C, esc, shell, footer } from "./alertemail";

export const PH = {
  NO_LIFT_WINDOW_S: 15 * 60,
  STEADY_AFTER_START_S: 5 * 60, // also after defrost: the whole lead-in must be heating
  NO_LIFT_DT_C: 1.5,            // measured 15-min steady minimum 3.4 °C (pump1) / 3.9 °C (pump2), at −2 °C outdoor
  NO_LIFT_MIN_DRAW_W: 1000,     // below this it is heating_no_draw's case, not no-lift
  NO_DRAW_LEAD_S: 2 * 60,       // first 2 min of a run draw ramps up (p1 177 W)
  NO_DRAW_WINDOW_S: 5 * 60,
  NO_DRAW_W: 1000,              // measured steady 5-min mean minimum 2 851 W
  IDLE_DRAW_WINDOW_S: 10 * 60,
  IDLE_DRAW_SKIP_S: 60,         // the first minute after a stop still shows run-down draw
  IDLE_DRAW_W: 1000,            // measured idle 4-min mean maximum 672 W; >1 kW idle samples last ≤ 0.8 min
  DEFROST_OVERLONG_S: 12 * 60,  // measured normal 2–9.4 min (19 spells); stuck spells 17.6, 30, 82 min. Was 20 (missed pump2 Oct 19)
  TANK_FLAT_WINDOW_S: 45 * 60,
  TANK_FLAT_ENGAGED_SHARE: 0.9,  // heating or defrost
  TANK_FLAT_PERSIST_S: 30 * 60, // every 45-min window ending in the last 30 min must be flat (doc §5)
  TANK_FLAT_STEP_S: 10 * 60,
  TANK_FLAT_RISE_F: 2.0,        // net of standby loss; ~5 % of one pump's no-load ~40 °F/45 min (doc §5)
  TANK_FLAT_ENGAGED_DT_C: 1.5,  // AND the unit's mean ΔT over heating+defrost below this: healthy min 2.1 °C, stuck defrost ≤ 1.1 (doc §5)
  FRESH_S: 180,                 // newest mirror reading must be this fresh (Pi clock corrected)
  MAX_READING_GAP_S: 150,       // readings arrive ~60 s; a skipped push is tolerated, two are not
  MAX_SPAN_GAP_S: 120,          // span samples ~25 s
  MAX_SLX_GAP_S: 450,           // HBX poll 5 min (+ jitter) — stagewatch MAX_STEP_MS
  /** how far back index.ts must read for every window above */
  LOOKBACK_S: 80 * 60,          // called_tank_flat: 45-min window + 30-min persistence + margin
} as const;

export const TREND = { CUR_DAYS: 7, BASE_DAYS: 14, MIN_RUN_H: 2, DRIFT_PCT: 20, SHORT_CYCLE_STARTS_60: 6, BIN_C: 5 } as const;

export type CheckKind = "running_no_lift" | "heating_no_draw" | "idle_draw" | "defrost_overlong" | "called_tank_flat";
export const CHECK_KINDS: readonly CheckKind[] = ["running_no_lift", "heating_no_draw", "idle_draw", "defrost_overlong", "called_tank_flat"];

export interface PumpReading { ts: number; online: boolean; state: string | null; inlet_c: number | null; outlet_c: number | null; ambient_c: number | null }
/** raw SPAN power_w — consumption is NEGATIVE on this panel; every use takes the magnitude */
export interface SpanSample { ts: number; power_w: number | null }
export interface TankReading { ts: number; tank_f: number | null; stages_called: boolean[] | null }

export type VerdictState = "ok" | "tripped" | "unknown";
export interface Verdict {
  kind: CheckKind;
  pumpId: string;
  state: VerdictState;
  /** why ok / unknown, or what tripped */
  reason: string;
  metrics: Record<string, number | null>;
}

const r1 = (x: number | null) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Rows inside [from, to] when they cover it with no gap > maxGap (edges included); null when they do not. */
export function covered<T extends { ts: number }>(rows: T[], from: number, to: number, maxGap: number): T[] | null {
  const w = rows.filter((r) => r.ts >= from && r.ts <= to);
  if (!w.length || w[0].ts - from > maxGap || to - w[w.length - 1].ts > maxGap) return null;
  for (let i = 1; i < w.length; i++) if (w[i].ts - w[i - 1].ts > maxGap) return null;
  return w;
}

const drawMean = (span: SpanSample[], from: number, to: number): { w: number | null; n: number } | null => {
  const w = covered(span.filter((s) => s.power_w != null && Number.isFinite(s.power_w)), from, to, PH.MAX_SPAN_GAP_S);
  if (!w) return null;
  return { w: mean(w.map((s) => Math.abs(s.power_w as number))), n: w.length };
};

const heating = (r: PumpReading) => r.online && r.state === "heating";
const defrosting = (r: PumpReading) => r.online && r.state === "defrost";
const idleish = (r: PumpReading) => r.online && (r.state === "idle" || r.state === "off");

/**
 * The four per-pump window checks at `nowPi` (Pi clock — the readings' own clock; index.ts corrects the planner's now
 * by the measured Pi clock offset). `readings` / `span` ascending, at least PH.LOOKBACK_S deep.
 */
export function evaluatePump(pumpId: string, readings: PumpReading[], span: SpanSample[], nowPi: number): Verdict[] {
  const v = (kind: CheckKind, state: VerdictState, reason: string, metrics: Record<string, number | null> = {}): Verdict => ({ kind, pumpId, state, reason, metrics });
  const newest = readings.length ? readings[readings.length - 1].ts : null;
  const kinds: CheckKind[] = ["running_no_lift", "heating_no_draw", "idle_draw", "defrost_overlong"];
  if (newest == null || nowPi - newest > PH.FRESH_S) {
    const why = newest == null ? "no mirror readings" : `newest mirror reading ${Math.round(nowPi - newest)} s old`;
    return kinds.map((k) => v(k, "unknown", why));
  }
  const out: Verdict[] = [];

  // running_no_lift — the whole lead-in + window heating, so the window is ≥ 5 min into the run and after any defrost
  {
    const from = nowPi - PH.NO_LIFT_WINDOW_S - PH.STEADY_AFTER_START_S;
    const lead = covered(readings, from, nowPi, PH.MAX_READING_GAP_S);
    if (!lead) out.push(v("running_no_lift", "unknown", "readings do not cover the window"));
    else if (!lead.every(heating)) out.push(v("running_no_lift", "ok", "not heating steadily for 20 min"));
    else {
      const win = lead.filter((r) => r.ts >= nowPi - PH.NO_LIFT_WINDOW_S && r.inlet_c != null && r.outlet_c != null);
      const dT = mean(win.map((r) => (r.outlet_c as number) - (r.inlet_c as number)));
      const d = drawMean(span, nowPi - PH.NO_LIFT_WINDOW_S, nowPi);
      const rise = win.length >= 2 ? (win[win.length - 1].outlet_c as number) - (win[0].outlet_c as number) : null;
      const m = { mean_dt_c: r1(dT), outlet_rise_c: r1(rise), draw_w: d ? Math.round(d.w ?? 0) : null, samples: win.length };
      if (win.length < 8 || dT == null) out.push(v("running_no_lift", "unknown", "too few temperature readings", m));
      else if (!d) out.push(v("running_no_lift", "unknown", "SPAN samples do not cover the window", m));
      else if ((d.w ?? 0) < PH.NO_LIFT_MIN_DRAW_W) out.push(v("running_no_lift", "ok", "not drawing compressor power (heating_no_draw's case)", m));
      else if (dT < PH.NO_LIFT_DT_C) out.push(v("running_no_lift", "tripped", `mean ΔT ${r1(dT)} °C over 15 min of steady heating at ${Math.round(d.w ?? 0)} W (floor ${PH.NO_LIFT_DT_C} °C)`, m));
      else out.push(v("running_no_lift", "ok", `mean ΔT ${r1(dT)} °C`, m));
    }
  }

  // heating_no_draw
  {
    const lead = covered(readings, nowPi - PH.NO_DRAW_WINDOW_S - PH.NO_DRAW_LEAD_S, nowPi, PH.MAX_READING_GAP_S);
    if (!lead) out.push(v("heating_no_draw", "unknown", "readings do not cover the window"));
    else if (!lead.every(heating)) out.push(v("heating_no_draw", "ok", "not reporting heating for 7 min"));
    else {
      const d = drawMean(span, nowPi - PH.NO_DRAW_WINDOW_S, nowPi);
      if (!d) out.push(v("heating_no_draw", "unknown", "SPAN samples do not cover the window"));
      else if ((d.w ?? 0) < PH.NO_DRAW_W) out.push(v("heating_no_draw", "tripped", `reports heating but the circuit draws ${Math.round(d.w ?? 0)} W (5-min mean; a running unit draws ≥ 2.8 kW)`, { draw_w: Math.round(d.w ?? 0), samples: d.n }));
      else out.push(v("heating_no_draw", "ok", `draws ${Math.round(d.w ?? 0)} W`, { draw_w: Math.round(d.w ?? 0) }));
    }
  }

  // idle_draw
  {
    const lead = covered(readings, nowPi - PH.IDLE_DRAW_WINDOW_S, nowPi, PH.MAX_READING_GAP_S);
    if (!lead) out.push(v("idle_draw", "unknown", "readings do not cover the window"));
    else if (lead.some((r) => !r.online)) out.push(v("idle_draw", "unknown", "pump offline in the window"));
    else if (!lead.every(idleish)) out.push(v("idle_draw", "ok", "not idle for 10 min"));
    else {
      const d = drawMean(span, nowPi - PH.IDLE_DRAW_WINDOW_S + PH.IDLE_DRAW_SKIP_S, nowPi);
      if (!d) out.push(v("idle_draw", "unknown", "SPAN samples do not cover the window"));
      else if ((d.w ?? 0) > PH.IDLE_DRAW_W) out.push(v("idle_draw", "tripped", `reports ${lead[lead.length - 1].state} for 10 min but the circuit draws ${Math.round(d.w ?? 0)} W (9-min mean; idle is ~8 W, max seen 672 W)`, { draw_w: Math.round(d.w ?? 0), samples: d.n }));
      else out.push(v("idle_draw", "ok", `draws ${Math.round(d.w ?? 0)} W`, { draw_w: Math.round(d.w ?? 0) }));
    }
  }

  // defrost_overlong
  {
    const lead = covered(readings, nowPi - PH.DEFROST_OVERLONG_S, nowPi, PH.MAX_READING_GAP_S);
    if (!lead) out.push(v("defrost_overlong", "unknown", "readings do not cover the window"));
    else if (!lead.every(defrosting)) out.push(v("defrost_overlong", "ok", "no defrost longer than 12 min"));
    else {
      // how long it has been in defrost, as far back as the readings stay contiguous
      let start = lead[0].ts;
      const before = readings.filter((r) => r.ts < lead[0].ts);
      for (let i = before.length - 1, next = lead[0].ts; i >= 0 && defrosting(before[i]) && next - before[i].ts <= PH.MAX_READING_GAP_S; next = before[i].ts, i--) start = before[i].ts;
      const min = Math.round((nowPi - start) / 60);
      const last = lead[lead.length - 1];
      out.push(v("defrost_overlong", "tripped", `reports defrost continuously for ${min} min (normal 2–9 min; the unit's max defrost time is 8 min by default)`,
        { defrost_min: min, outlet_c: last.outlet_c, inlet_c: last.inlet_c }));
    }
  }
  return out;
}

/**
 * called_tank_flat for one stage → pump, at `nowPi`. Tank readings are converted to the Pi clock by index.ts. Measured on
 * the 2026-10-20 restore (doc §5): a flat or falling tank is ROUTINE for a healthy single pump at ≤ 45 °F outdoor (house
 * load ≥ its output), so the tank only corroborates — the trip also needs the unit's own lift over the window (heating +
 * defrost samples) under 1.5 °C, held for 30 min. In 97 days that leaves exactly pump1's 83-min stuck defrost.
 */
export function evaluateTankFlat(stage: string, pumpId: string, readings: PumpReading[], span: SpanSample[], tank: TankReading[], nowPi: number, tankUa: number,
  persistS: number = PH.TANK_FLAT_PERSIST_S): Verdict {
  const v = (state: VerdictState, reason: string, metrics: Record<string, number | null> = {}): Verdict => ({ kind: "called_tank_flat", pumpId, state, reason, metrics });
  const newest = readings.length ? readings[readings.length - 1].ts : null;
  if (newest == null || nowPi - newest > PH.FRESH_S) return v("unknown", "mirror readings stale");
  const idx = Number(stage) - 1;
  const slx = tank.filter((x) => x.tank_f != null && x.stages_called != null);
  /** one 45-min window ending at `end` */
  const judge = (end: number): Verdict => {
    const from = end - PH.TANK_FLAT_WINDOW_S;
    const t = covered(slx, from, end, PH.MAX_SLX_GAP_S);
    if (!t || t.length < 8) return v("unknown", "HBX readings do not cover 45 min");
    if (!t.every((x) => x.stages_called![idx] === true)) return v("ok", `stage ${stage} not called for 45 min`);
    const pr = covered(readings, from, end, PH.MAX_READING_GAP_S);
    if (!pr) return v("unknown", "pump readings do not cover 45 min");
    if (pr.some((r) => !r.online)) return v("unknown", "pump offline in the window");
    // engaged = heating OR defrost: a healthy unit below 0 °C defrosts every ~50 min (doc §3), so a heating-only share
    // would never judge a cold-weather call — and a stuck "defrost" while called is exactly a pump not delivering
    const share = pr.filter((r) => heating(r) || defrosting(r)).length / pr.length;
    if (share < PH.TANK_FLAT_ENGAGED_SHARE) return v("ok", `pump engaged only ${Math.round(share * 100)} % of the window`);
    const t0 = ((t[0].tank_f as number) + (t[1].tank_f as number)) / 2;
    const t1 = ((t[t.length - 1].tank_f as number) + (t[t.length - 2].tank_f as number)) / 2;
    const rise = t1 - t0;
    const credit = Math.max(0, tankUa * (t0 - 65) * ((t[t.length - 1].ts - t[0].ts) / 3600));
    const hot = pr.filter((r) => heating(r) && r.inlet_c != null && r.outlet_c != null);
    const dT = mean(hot.map((r) => (r.outlet_c as number) - (r.inlet_c as number)));
    const d = drawMean(span, from, end);
    // the lift over everything the unit was engaged in — a defrost pulls heat OUT of the water (negative ΔT)
    const eng = pr.filter((r) => (heating(r) || defrosting(r)) && r.inlet_c != null && r.outlet_c != null);
    const engagedDt = mean(eng.map((r) => (r.outlet_c as number) - (r.inlet_c as number)));
    const other = t[t.length - 1].stages_called!.some((c, i) => c && i !== idx);
    const m = { tank_rise_f: r1(rise), standby_credit_f: r1(credit), net_f: r1(rise + credit), tank_f: r1(t1), engaged_pct: Math.round(share * 100),
      defrost_pct: Math.round((pr.filter(defrosting).length / pr.length) * 100), pump_mean_dt_c: r1(dT), engaged_dt_c: r1(engagedDt), pump_draw_w: d?.w != null ? Math.round(d.w) : null,
      other_stage_called: other ? 1 : 0 };
    if (rise + credit <= PH.TANK_FLAT_RISE_F && (engagedDt == null || engagedDt >= PH.TANK_FLAT_ENGAGED_DT_C)) {
      // measured: a HEALTHY single pump at ≤ 45 °F outdoor routinely holds the tank flat or loses ground (net p50 +2 °F,
      // p25 −2.9 °F) while lifting 2.1–4.3 °C — that is house load ≥ one pump's output, not a pump failure
      return v("ok", `tank flat (net ${r1(rise + credit)} °F) but the pump lifts ${r1(engagedDt) ?? "?"} °C — house load ≥ its output`, m);
    }
    if (rise + credit <= PH.TANK_FLAT_RISE_F) {
      return v("tripped", `stage ${stage} called with its pump engaged ${Math.round(share * 100)} % (defrost ${m.defrost_pct} %), but the tank moved ${r1(rise)} °F ` +
        `in 45 min (standby loss ${r1(credit)} °F) and the pump lifts only ${r1(engagedDt)} °C over it — ${m.pump_draw_w ?? "?"} W${other ? "; the other stage is called too (heavy load?)" : ""}`, m);
    }
    return v("ok", `tank rose ${r1(rise)} °F net ${r1(rise + credit)} °F`, m);
  };
  const latest = judge(nowPi);
  if (latest.state !== "tripped") return latest;
  // persistence (measured): the one healthy-pump trip in 97 d was a 15-min load event (Oct 17, tank −15 °F at ΔT 4.2 °C,
  // 4.4 kW). Every 45-min window ending in the last persistS must be flat too.
  for (let back = PH.TANK_FLAT_STEP_S; back <= persistS; back += PH.TANK_FLAT_STEP_S) {
    const w = judge(nowPi - back);
    if (w.state === "unknown") return v("unknown", `flat now, but the window ${back / 60} min ago is unknown (${w.reason})`, latest.metrics);
    if (w.state === "ok") return v("ok", `flat for < ${persistS / 60} min (a load surge can do that)`, latest.metrics);
  }
  return v("tripped", `${latest.reason}; flat for ≥ ${persistS / 60} min`, latest.metrics);
}

// ── episodes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface HealthEvent { kind: "open" | "close"; check: CheckKind; pumpId: string; title: string; body: string }

/** Edge-triggered episodes over the verdicts: tripped opens once, ok closes, unknown moves nothing (stagewatch's rule). */
export class PumpHealthWatch {
  private open = new Set<string>();
  private last = new Map<string, Verdict>();
  constructor(private names: Record<string, string> = {}) {}
  /** pump id → display name (the hub's), used in titles */
  setNames(n: Record<string, string>): void { this.names = n; }
  private key = (c: CheckKind, p: string) => `${c}\u0000${p}`;
  /** Re-adopt episodes still open in the DB, so they close (not re-open) when the condition clears. */
  restore(open: { check: CheckKind; pumpId: string }[]): void { for (const o of open) this.open.add(this.key(o.check, o.pumpId)); }
  isOpen(c: CheckKind, p: string): boolean { return this.open.has(this.key(c, p)); }

  step(verdicts: Verdict[]): HealthEvent[] {
    const out: HealthEvent[] = [];
    for (const x of verdicts) {
      const k = this.key(x.kind, x.pumpId);
      this.last.set(k, x);
      const label = this.names[x.pumpId] ?? x.pumpId;
      if (x.state === "tripped") {
        if (!this.open.has(k)) {
          this.open.add(k);
          out.push({ kind: "open", check: x.kind, pumpId: x.pumpId, title: `${label}: ${TITLES[x.kind]}`, body: `${label} ${x.reason}. No fault code is active — this is what the pump-health check exists to catch.` });
        }
      } else if (x.state === "ok") {
        if (this.open.has(k)) {
          this.open.delete(k);
          out.push({ kind: "close", check: x.kind, pumpId: x.pumpId, title: `${label}: ${TITLES[x.kind]} cleared`, body: x.reason });
        }
      }
    }
    return out;
  }

  status(): Record<string, Record<string, { state: VerdictState; open: boolean; reason: string; metrics: Record<string, number | null> }>> {
    const out: ReturnType<PumpHealthWatch["status"]> = {};
    for (const [k, x] of this.last) {
      const [c, p] = k.split("\u0000");
      (out[p] ??= {})[c] = { state: x.state, open: this.open.has(k), reason: x.reason, metrics: x.metrics };
    }
    return out;
  }
}

const TITLES: Record<CheckKind, string> = {
  running_no_lift: "running but not lifting water temperature",
  heating_no_draw: "reports heating but draws no power",
  idle_draw: "idle but drawing power",
  defrost_overlong: "stuck in defrost",
  called_tank_flat: "called and heating but the tank is flat",
};

/** PUMP_HEALTH_LIVE env: comma-separated check kinds the owner has promoted to paging. Unknown names are reported. */
export function parseLiveChecks(raw: string | undefined): { live: Set<CheckKind>; error: string | null } {
  const live = new Set<CheckKind>();
  const bad: string[] = [];
  for (const s of (raw ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    if ((CHECK_KINDS as readonly string[]).includes(s)) live.add(s as CheckKind); else bad.push(s);
  }
  return { live, error: bad.length ? `PUMP_HEALTH_LIVE ignored unknown check(s): ${bad.join(", ")}` : null };
}
/** alert_episodes kind: shadow checks are `shadow_pump_<check>` (logged, never paged); a promoted one `pump_<check>`. */
export const episodeKind = (c: CheckKind, live: boolean) => `${live ? "" : "shadow_"}pump_${c}`;
export function parseEpisodeKind(kind: string): { check: CheckKind; live: boolean } | null {
  const m = /^(shadow_)?pump_(.+)$/.exec(kind);
  return m && (CHECK_KINDS as readonly string[]).includes(m[2]) ? { check: m[2] as CheckKind, live: !m[1] } : null;
}

// ── daily rollup ──────────────────────────────────────────────────────────────────────────────────────────────────────
export interface BinAcc { deg_h: number; kwh: number; run_h: number }
export interface DayMetrics {
  kwh: number;               // SPAN-metered, whole day (|W| integrated over gaps ≤ 120 s)
  kwh_heating: number;       // of which while the pump reported heating
  span_coverage: number;     // fraction of the day the SPAN integration covers
  reading_coverage: number;  // same for the mirror readings
  run_h: number;
  starts: number;
  max_starts_60min: number;
  defrosts: number;
  defrost_min: number;
  longest_defrost_min: number;
  mean_dt_c: number | null;  // while heating
  mean_ambient_c: number | null;
  /** lift index Σ(ΔT·h)/Σ kWh while heating — a RELATIVE heat-per-kWh index (no flow meter) */
  lift_index: number | null;
  bins: Record<string, BinAcc>; // by 5 °C outdoor bin (floor), e.g. "-5", "0", "5"
}

const binOf = (c: number) => String(Math.floor(c / TREND.BIN_C) * TREND.BIN_C);

/** One pump's day [fromS, toS) from mirror readings + its SPAN circuit (both ascending, Pi clock). */
export function rollupDay(readings: PumpReading[], span: SpanSample[], fromS: number, toS: number): DayMetrics {
  const rd = readings.filter((r) => r.ts >= fromS && r.ts < toS);
  const sp = span.filter((s) => s.ts >= fromS && s.ts < toS && s.power_w != null && Number.isFinite(s.power_w));
  const bins: Record<string, BinAcc> = {};
  let runS = 0, readS = 0, starts = 0, defrosts = 0, defrostS = 0, longestS = 0, curDefrost = 0, dtSum = 0, dtN = 0, ambSum = 0, ambN = 0;
  const startTs: number[] = [];
  for (let i = 0; i < rd.length; i++) {
    const r = rd[i], next = rd[i + 1];
    const dt = next && next.ts - r.ts <= PH.MAX_READING_GAP_S ? next.ts - r.ts : 0;
    readS += dt;
    if (r.ambient_c != null) { ambSum += r.ambient_c; ambN++; }
    const prev = rd[i - 1];
    const contiguous = !!prev && r.ts - prev.ts <= PH.MAX_READING_GAP_S;
    if (heating(r)) {
      runS += dt;
      if (contiguous && !heating(prev) && !defrosting(prev)) { starts++; startTs.push(r.ts); }
      if (r.inlet_c != null && r.outlet_c != null) {
        const d = r.outlet_c - r.inlet_c;
        dtSum += d; dtN++;
        if (r.ambient_c != null) {
          const b = (bins[binOf(r.ambient_c)] ??= { deg_h: 0, kwh: 0, run_h: 0 });
          b.deg_h += (d * dt) / 3600; b.run_h += dt / 3600;
        }
      }
    }
    if (defrosting(r)) {
      if (!contiguous || !defrosting(prev)) { defrosts++; curDefrost = 0; }
      defrostS += dt; curDefrost += dt; longestS = Math.max(longestS, curDefrost);
    }
  }
  // SPAN energy, attributed to the state of the newest reading at or before each sample (within the reading gap)
  let kwh = 0, kwhHeat = 0, spanS = 0, j = 0;
  for (let i = 0; i + 1 < sp.length; i++) {
    const dt = sp[i + 1].ts - sp[i].ts;
    if (dt > PH.MAX_SPAN_GAP_S) continue;
    const e = (Math.abs(sp[i].power_w as number) * dt) / 3.6e6;
    kwh += e; spanS += dt;
    while (j + 1 < rd.length && rd[j + 1].ts <= sp[i].ts) j++;
    const r = rd[j];
    if (r && r.ts <= sp[i].ts && sp[i].ts - r.ts <= PH.MAX_READING_GAP_S && heating(r)) {
      kwhHeat += e;
      if (r.ambient_c != null && r.inlet_c != null && r.outlet_c != null) (bins[binOf(r.ambient_c)] ??= { deg_h: 0, kwh: 0, run_h: 0 }).kwh += e;
    }
  }
  let max60 = 0;
  for (let a = 0, b = 0; b < startTs.length; b++) { while (startTs[b] - startTs[a] > 3600) a++; max60 = Math.max(max60, b - a + 1); }
  const degH = Object.values(bins).reduce((s, b) => s + b.deg_h, 0);
  const binKwh = Object.values(bins).reduce((s, b) => s + b.kwh, 0);
  const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
  for (const b of Object.values(bins)) { b.deg_h = round(b.deg_h); b.kwh = round(b.kwh); b.run_h = round(b.run_h); }
  return {
    kwh: round(kwh), kwh_heating: round(kwhHeat), span_coverage: round(spanS / (toS - fromS)), reading_coverage: round(readS / (toS - fromS)),
    run_h: round(runS / 3600), starts, max_starts_60min: max60, defrosts, defrost_min: round(defrostS / 60, 1), longest_defrost_min: round(longestS / 60, 1),
    mean_dt_c: dtN ? round(dtSum / dtN, 2) : null, mean_ambient_c: ambN ? round(ambSum / ambN, 1) : null,
    lift_index: binKwh > 0.2 ? round(degH / binKwh) : null, bins,
  };
}

// ── trend ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface DayRow { day: string; pumpId: string; m: DayMetrics }
export interface BinDrift { bin: string; pct: number; cur_run_h: number; base_run_h: number }
export interface PumpTrend { lift_drift: BinDrift | null; flags: string[] }
export interface TrendOut { pumps: Record<string, PumpTrend>; twin: (BinDrift & { pumps: [string, string] }) | null; twin_flag: boolean; through_day: string | null }

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
function pool(rows: DayRow[], pumpId: string, from: string, toIncl: string): Record<string, BinAcc> {
  const out: Record<string, BinAcc> = {};
  for (const r of rows) {
    if (r.pumpId !== pumpId || r.day < from || r.day > toIncl) continue;
    for (const [b, x] of Object.entries(r.m.bins ?? {})) {
      const o = (out[b] ??= { deg_h: 0, kwh: 0, run_h: 0 });
      o.deg_h += x.deg_h; o.kwh += x.kwh; o.run_h += x.run_h;
    }
  }
  return out;
}
const idx = (b: BinAcc | undefined) => (b && b.kwh > 0 && b.run_h >= TREND.MIN_RUN_H ? b.deg_h / b.kwh : null);

/**
 * Per pump: the trailing 7-day pooled lift index vs that pump's own 14 days before it, same 5 °C outdoor bin, ≥ 2 run-h on
 * each side — the bin with the largest |drift| is reported; ≤ −20 % flags (measured noise max 12.7 %). Twin: the p1/p2
 * index ratio vs its own baseline ratio (the twins are NOT equal — pump1 sits ~16 % below pump2), ≥ 20 % either way.
 * short_cycling: > 6 starts in any 60 min on the newest day (measured max 4).
 */
export function trend(rows: DayRow[], pumpIds: string[], throughDay: string): TrendOut {
  const curFrom = addDays(throughDay, -(TREND.CUR_DAYS - 1));
  const baseTo = addDays(curFrom, -1), baseFrom = addDays(curFrom, -TREND.BASE_DAYS);
  const pumps: Record<string, PumpTrend> = {};
  const cur: Record<string, Record<string, BinAcc>> = {}, base: Record<string, Record<string, BinAcc>> = {};
  for (const p of pumpIds) {
    cur[p] = pool(rows, p, curFrom, throughDay); base[p] = pool(rows, p, baseFrom, baseTo);
    let worst: BinDrift | null = null;
    for (const b of Object.keys(cur[p])) {
      const c = idx(cur[p][b]), bl = idx(base[p][b]);
      if (c == null || bl == null || bl <= 0) continue;
      const pct = Math.round((c / bl - 1) * 1000) / 10;
      if (!worst || Math.abs(pct) > Math.abs(worst.pct)) worst = { bin: b, pct, cur_run_h: Math.round(cur[p][b].run_h * 10) / 10, base_run_h: Math.round(base[p][b].run_h * 10) / 10 };
    }
    const flags: string[] = [];
    if (worst && worst.pct <= -TREND.DRIFT_PCT) flags.push("lift_drift");
    const newest = rows.find((r) => r.pumpId === p && r.day === throughDay);
    if (newest && newest.m.max_starts_60min > TREND.SHORT_CYCLE_STARTS_60) flags.push("short_cycling");
    pumps[p] = { lift_drift: worst, flags };
  }
  let twin: TrendOut["twin"] = null;
  if (pumpIds.length === 2) {
    const [a, b] = pumpIds;
    for (const bin of Object.keys(cur[a] ?? {})) {
      const ca = idx(cur[a][bin]), cb = idx(cur[b]?.[bin]), ba = idx(base[a]?.[bin]), bb = idx(base[b]?.[bin]);
      if (ca == null || cb == null || ba == null || bb == null || cb <= 0 || bb <= 0 || ba <= 0) continue;
      const pct = Math.round(((ca / cb) / (ba / bb) - 1) * 1000) / 10;
      if (!twin || Math.abs(pct) > Math.abs(twin.pct)) {
        twin = { bin, pct, cur_run_h: Math.round(Math.min(cur[a][bin].run_h, cur[b][bin].run_h) * 10) / 10,
          base_run_h: Math.round(Math.min(base[a][bin].run_h, base[b][bin].run_h) * 10) / 10, pumps: [a, b] };
      }
    }
  }
  return { pumps, twin, twin_flag: !!twin && Math.abs(twin.pct) >= TREND.DRIFT_PCT, through_day: throughDay };
}

// ── days + digest ─────────────────────────────────────────────────────────────────────────────────────────────────────
const ET = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
/** The America/New_York calendar day of an epoch-seconds instant, "YYYY-MM-DD". */
export const etDay = (s: number) => ET.format(s * 1000).slice(0, 10);
/** Local hour (0–23) in America/New_York. */
export const etHour = (s: number) => Number(ET.format(s * 1000).slice(-2));
/** Epoch seconds of local midnight starting `day` in America/New_York (EDT 04:00Z or EST 05:00Z). */
export function etDayStart(day: string): number {
  for (const h of [4, 5]) {
    const t = Date.parse(`${day}T0${h}:00:00Z`);
    if (ET.format(t) === `${day}, 00`) return t / 1000;
  }
  return Date.parse(`${day}T05:00:00Z`) / 1000;
}

export interface EpisodeLine { kind: string; pumpId: string | null; title: string; started_at: string; cleared_at: string | null }
/** The daily digest email: yesterday per pump, drift flags, shadow episodes of the last 24 h, current check states. */
export function digest(day: string, rows: DayRow[], t: TrendOut, episodes: EpisodeLine[], status: ReturnType<PumpHealthWatch["status"]>,
  names: Record<string, string>, live: Set<CheckKind>): { title: string; body: string; html: string } {
  const lines: string[] = [];
  const flagged = Object.values(t.pumps).some((p) => p.flags.length) || t.twin_flag;
  const opened = episodes.length;
  lines.push(`Pump health for ${day} (America/New_York). Checks are SHADOW unless listed as live: ${live.size ? [...live].join(", ") : "none live"}.`, "");
  for (const r of rows.filter((x) => x.day === day)) {
    const m = r.m;
    const tr = t.pumps[r.pumpId];
    lines.push(`${names[r.pumpId] ?? r.pumpId}: ${m.kwh.toFixed(1)} kWh (${m.kwh_heating.toFixed(1)} heating), ${m.run_h.toFixed(1)} h run, ${m.starts} starts (max ${m.max_starts_60min}/h), ` +
      `${m.defrosts} defrosts / ${m.defrost_min} min (longest ${m.longest_defrost_min}), mean ΔT ${m.mean_dt_c ?? "—"} °C, outdoor ${m.mean_ambient_c ?? "—"} °C, ` +
      `lift index ${m.lift_index ?? "—"} ΔT·h/kWh. Coverage: readings ${Math.round(m.reading_coverage * 100)} %, SPAN ${Math.round(m.span_coverage * 100)} %.`);
    if (tr?.lift_drift) lines.push(`   7-day vs own 14-day baseline at ${tr.lift_drift.bin} °C: ${tr.lift_drift.pct > 0 ? "+" : ""}${tr.lift_drift.pct} % (${tr.lift_drift.cur_run_h} h vs ${tr.lift_drift.base_run_h} h)${tr.flags.includes("lift_drift") ? "  ⚠ DRIFT" : ""}`);
    else lines.push(`   7-day vs 14-day baseline: not enough run-hours in a shared outdoor bin yet (≥ ${TREND.MIN_RUN_H} h each side).`);
    if (tr?.flags.includes("short_cycling")) lines.push(`   ⚠ SHORT CYCLING: ${m.max_starts_60min} starts in one hour (measured normal ≤ 4).`);
  }
  if (t.twin) lines.push("", `Twin (p1/p2 lift ratio vs its baseline) at ${t.twin.bin} °C: ${t.twin.pct > 0 ? "+" : ""}${t.twin.pct} %${t.twin_flag ? "  ⚠ DRIFT" : ""}`);
  else lines.push("", "Twin comparison: the pumps have not shared an outdoor bin with enough run-hours yet.");
  lines.push("", opened ? `Pump-health episodes opened in the last 24 h (${opened}):` : "No pump-health episodes in the last 24 h.");
  for (const e of episodes) lines.push(`  • ${e.started_at.slice(0, 16).replace("T", " ")}Z ${e.title}${e.cleared_at ? ` (cleared ${e.cleared_at.slice(11, 16)}Z)` : " — STILL OPEN"}${e.kind.startsWith("shadow_") ? " [shadow]" : ""}`);
  const openNow = Object.entries(status).flatMap(([p, cs]) => Object.entries(cs).filter(([, x]) => x.open).map(([c]) => `${names[p] ?? p} ${c}`));
  if (openNow.length) lines.push("", `Open right now: ${openNow.join(", ")}.`);
  lines.push("", "Thresholds and the data behind them: knowledge/reference/pump-health-baseline-20261019.md. Promote a check with PUMP_HEALTH_LIVE.");
  const title = `A2W pump health ${day}: ${flagged ? "drift flagged" : opened ? `${opened} shadow episode(s)` : "normal"}`;
  return { title, body: lines.join("\n"), html: digestHtml(day, rows.filter((x) => x.day === day), t, episodes, openNow, names, flagged) };
}

/**
 * The digest as a skimmable email (owner 2026-10-20: the text version was "really hard to skim"): a verdict banner,
 * one plain-English sentence, then the pumps side by side with the numbers that matter. Technical notes go last.
 */
function digestHtml(day: string, rows: DayRow[], t: TrendOut, episodes: EpisodeLine[], openNow: string[],
                    names: Record<string, string>, flagged: boolean): string {
  const nm = (id: string) => names[id] ?? id;
  const when = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const issues: string[] = [];
  for (const r of rows) {
    const tr = t.pumps[r.pumpId];
    if (tr?.flags.includes("lift_drift") && tr.lift_drift) issues.push(`${nm(r.pumpId)} is getting ${Math.abs(tr.lift_drift.pct)} % ${tr.lift_drift.pct < 0 ? "less" : "more"} heat per kWh than its own two-week baseline.`);
    if (tr?.flags.includes("short_cycling")) issues.push(`${nm(r.pumpId)} started ${r.m.max_starts_60min} times in one hour (normal is 4 or fewer).`);
  }
  if (t.twin_flag && t.twin) issues.push(`The two pumps' efficiency has moved ${Math.abs(t.twin.pct)} % apart relative to each other.`);
  if (openNow.length) issues.push(`Still open: ${openNow.join(", ")}.`);
  const b = flagged ? { label: "NEEDS A LOOK · efficiency drift", ...C.attention }
    : episodes.length ? { label: `FYI · ${episodes.length} test-mode episode${episodes.length === 1 ? "" : "s"}`, ...C.info }
    : { label: "✅ ALL NORMAL", ...C.resolved };
  const share = rows.length === 2 && rows[0].m.run_h + rows[1].m.run_h > 0
    ? (() => { const [a, c] = rows[0].m.run_h >= rows[1].m.run_h ? [rows[0], rows[1]] : [rows[1], rows[0]];
               return a.m.run_h > c.m.run_h * 1.25 ? ` ${nm(a.pumpId)} did more of the work (${a.m.run_h.toFixed(1)} h vs ${c.m.run_h.toFixed(1)} h).` : ""; })()
    : "";
  const sentence = issues.length ? issues.join(" ") : `Both pumps ran normally.${share}`;

  const n = (v: number | null | undefined, d = 1) => (v == null ? "—" : v.toFixed(d));
  const trend = (id: string) => {
    const d = t.pumps[id]?.lift_drift;
    if (!d) return "—";
    const warn = t.pumps[id]?.flags.includes("lift_drift");
    return `${d.pct > 0 ? "+" : ""}${d.pct} %${warn ? " ⚠" : ""}`;
  };
  const metrics: [string, (r: DayRow) => string][] = [
    ["Electricity", (r) => `${n(r.m.kwh)} kWh`],
    ["Run time", (r) => `${n(r.m.run_h)} h`],
    ["Starts", (r) => `${r.m.starts}`],
    ["Most starts in 1 h", (r) => `${r.m.max_starts_60min}`],
    ["Defrosts", (r) => r.m.defrosts ? `${r.m.defrosts} · ${Math.round(r.m.defrost_min)} min` : "none"],
    ["Avg outdoor", (r) => r.m.mean_ambient_c == null ? "—" : `${Math.round(r.m.mean_ambient_c * 9 / 5 + 32)} °F`],
    ["Efficiency trend", (r) => trend(r.pumpId)],
  ];
  const th = (x: string, al = "right") => `<th style="text-align:${al};font-size:12px;color:${C.ink2};font-weight:600;padding:6px 0 6px 10px;border-bottom:2px solid ${C.rule}">${esc(x)}</th>`;
  const td = (x: string, al = "right", bold = false) => `<td style="text-align:${al};font-size:14px;padding:7px 0 7px 10px;border-bottom:1px solid ${C.rule};${bold ? "font-weight:600;" : ""}color:${al === "left" ? C.ink2 : C.ink}">${esc(x)}</td>`;
  const table = rows.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 16px">` +
      `<tr>${th("", "left")}${rows.map((r) => th(nm(r.pumpId).replace(/^Heat Pump\s*/i, "HP "))).join("")}</tr>` +
      metrics.map(([label, f]) => `<tr>${td(label, "left")}${rows.map((r) => td(f(r), "right", true)).join("")}</tr>`).join("") +
      `</table>`
    : "";
  const eps = episodes.length
    ? `<div style="font-size:12px;font-weight:700;letter-spacing:.04em;color:${C.muted};margin:0 0 4px">EPISODES (LAST 24 H)</div><ul style="margin:0 0 14px;padding-left:18px;font-size:13px;line-height:1.45;color:${C.ink2}">` +
      episodes.map((e) => `<li>${esc(e.title)}${e.cleared_at ? " · cleared" : " · <b>still open</b>"}${e.kind.startsWith("shadow_") ? " · test mode" : ""}</li>`).join("") + `</ul>`
    : "";
  const tech = `<p style="margin:0;font-size:12px;line-height:1.45;color:${C.muted}">Efficiency trend: heat delivered per kWh over the last ` +
    `7 days vs the pump's own 2-week baseline, at the same outdoor temperature (— = not enough run time yet). Normal starts: 4 or fewer per hour. Checks run in test mode until promoted with PUMP_HEALTH_LIVE; thresholds in ` +
    `knowledge/reference/pump-health-baseline-20261019.md.</p>`;
  return shell(
    `<div style="display:inline-block;background:${b.bg};color:${b.fg};font-size:12px;font-weight:700;letter-spacing:.04em;padding:5px 9px;border-radius:4px;margin:4px 0 10px">${esc(b.label)}</div>` +
    `<h1 style="font-size:21px;line-height:1.25;margin:0 0 8px;font-weight:700">Heat pump health · ${esc(when)}</h1>` +
    `<p style="font-size:16px;line-height:1.45;margin:0 0 16px">${esc(sentence)}</p>` +
    (flagged ? `<div style="border-left:4px solid #c98a00;background:${C.tile};padding:10px 12px;margin:0 0 16px;border-radius:0 6px 6px 0">` +
      `<div style="font-size:12px;font-weight:700;letter-spacing:.04em;color:${C.ink2};margin-bottom:3px">WHAT TO DO</div>` +
      `<div style="font-size:16px;line-height:1.4">Nothing today. If it is still flagged after a week, ask the installer to check the outdoor coil, ` +
      `the water flow and the refrigerant charge.</div></div>` : "") +
    table + eps + tech +
    footer("A2W planner", new Date(), flagged ? "You got this because a pump's efficiency has drifted from its own baseline." : "Daily pump report."));
}
