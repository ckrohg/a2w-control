// @purpose Pure view model for the pump-health card: the planner's /health.pump_health (planner/src/pumphealth.ts) →
// one row per pump with its "running but not doing its job" check states and yesterday's SPAN-metered rollup + drift.
// Defensive about every field: an older planner without pump_health, a partial object, or a planner that could not
// evaluate (gate set) all render as an honest "not evaluated", never as "normal".

export type CheckState = "ok" | "tripped" | "unknown";
export interface CheckView { check: string; label: string; state: CheckState; open: boolean; reason: string }
export interface DayView {
  kwh: number | null; run_h: number | null; starts: number | null; defrosts: number | null; defrost_min: number | null;
  mean_dt_c: number | null; lift_index: number | null; drift_pct: number | null; drift_bin: string | null; flags: string[];
}
export interface PumpView { id: string; checks: CheckView[]; tripped: CheckView[]; unknown: number; day: DayView | null }
export interface PumpHealthView {
  available: boolean;     // the planner reported a pump_health block
  gate: string | null;    // why nothing was evaluated (null = evaluated)
  liveChecks: string[];   // promoted to paging; everything else is shadow
  evaluatedAt: string | null;
  throughDay: string | null;
  pumps: PumpView[];
  twin: { pct: number; bin: string; flag: boolean } | null;
  error: string | null;
}

export const CHECK_LABELS: Record<string, string> = {
  running_no_lift: "running, no lift",
  heating_no_draw: "heating, no power",
  idle_draw: "idle, drawing power",
  defrost_overlong: "stuck in defrost",
  called_tank_flat: "called, tank flat",
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function pumpHealthView(raw: unknown): PumpHealthView {
  const ph = obj(raw);
  const empty: PumpHealthView = { available: false, gate: null, liveChecks: [], evaluatedAt: null, throughDay: null, pumps: [], twin: null, error: null };
  if (!ph) return empty;
  const checks = obj(ph.checks) ?? {};
  const daily = obj(ph.daily) ?? {};
  const trend = obj(daily.trend);
  const trendPumps = obj(trend?.pumps) ?? {};
  const days = Array.isArray(daily.days) ? (daily.days as unknown[]).map(obj).filter(Boolean) as Record<string, unknown>[] : [];
  const ids = [...new Set([...Object.keys(checks), ...days.map((d) => str(d.pump)).filter((x): x is string => !!x)])].sort();
  const pumps: PumpView[] = ids.map((id) => {
    const cs = obj(checks[id]) ?? {};
    const list: CheckView[] = Object.keys(CHECK_LABELS).filter((k) => obj(cs[k])).map((k) => {
      const c = obj(cs[k])!;
      const state = c.state === "tripped" || c.state === "ok" ? c.state : "unknown";
      return { check: k, label: CHECK_LABELS[k], state, open: c.open === true, reason: str(c.reason) ?? "" };
    });
    const d = days.find((x) => x.pump === id);
    const tp = obj(trendPumps[id]);
    const drift = obj(tp?.lift_drift);
    return {
      id, checks: list,
      tripped: list.filter((c) => c.state === "tripped" || c.open),
      unknown: list.filter((c) => c.state === "unknown").length,
      day: d ? {
        kwh: num(d.kwh), run_h: num(d.run_h), starts: num(d.starts), defrosts: num(d.defrosts), defrost_min: num(d.defrost_min),
        mean_dt_c: num(d.mean_dt_c), lift_index: num(d.lift_index), drift_pct: num(drift?.pct), drift_bin: str(drift?.bin),
        flags: Array.isArray(tp?.flags) ? (tp!.flags as unknown[]).filter((x): x is string => typeof x === "string") : [],
      } : null,
    };
  });
  const tw = obj(trend?.twin);
  return {
    available: true,
    gate: str(ph.gate),
    liveChecks: Array.isArray(ph.live_checks) ? (ph.live_checks as unknown[]).filter((x): x is string => typeof x === "string") : [],
    evaluatedAt: str(ph.evaluated_at),
    throughDay: str(daily.through_day),
    pumps,
    twin: tw && num(tw.pct) != null ? { pct: num(tw.pct)!, bin: str(tw.bin) ?? "?", flag: trend?.twin_flag === true } : null,
    error: str(ph.error) ?? str(daily.error),
  };
}

/** The pump's chip: what a glance should say. */
export function pumpChip(p: PumpView, gate: string | null): { cls: string; text: string } {
  if (p.tripped.length) return { cls: "warn", text: `${p.tripped.length} flag${p.tripped.length > 1 ? "s" : ""}` };
  if (p.day?.flags.length) return { cls: "warn", text: p.day.flags.join(", ").replace(/_/g, " ") };
  if (gate || (p.checks.length && p.unknown === p.checks.length)) return { cls: "offline", text: "not evaluated" };
  return { cls: "ok", text: "normal" };
}
