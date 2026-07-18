// @purpose Savings page v0.2 — rewritten for the owner after "really confusing" feedback.
// Leads with a dollars headline (rough, clearly labeled), then plain-English cards. The
// engineering numbers (°F·h, gap averages) survive in a small footnote line. $ math:
// measured pump kWh × (avg overshoot °F × ~1%/°F COP sensitivity) × rate — the 1%/°F is a
// typical figure for these water temps and is exactly what the A-4 test calibrates.
// Rate: ELECTRIC_RATE_USD_KWH env (default 0.30) until TempIQ#1470 supplies the real tariff.
import { sql } from "@vercel/postgres";
import { fmtDateTime } from "@/lib/tz";
import { I1Banner } from "../i1-banner";
import { StormBanner } from "../storm-banner";
import history from "@/lib/curve-history.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const RATE = Number(process.env.ELECTRIC_RATE_USD_KWH ?? "0.30");
const COP_SENS_PER_F = 0.01; // ~1%/°F — rough; A-4 measures the real slope
// Daily pump energy: the Modbus power regs (2063/2088) are NOT yet calibrated (pump2 maxes
// at 27 raw while SPAN shows ~6.8 kW; pump1 reads 0) — a known commissioning item. Until
// they're calibrated against SPAN, use the SPAN-measured July average as the baseline.
const DAILY_KWH = Number(process.env.DAILY_KWH_BASELINE ?? "11.8"); // SPAN, July 2026 avg

const fmt = (v: number | null | undefined, d = 1) =>
  v == null || !isFinite(v as number) ? "—" : (v as number).toFixed(d);

// COP before/after (from the frozen /curve extract, lib/curve-history.json): measured
// old-regime vs modeled at planner-cool tanks, n-weighted over the same mild/warm weather.
const _H = history as any;
const _nwCop = (key: "af" | "cur", lo: number, hi: number) => {
  const rows = _H.receipt.filter((r: any) => r.n_v3 && r.o >= lo && r.o < hi && r[key] != null);
  const w = rows.reduce((s: number, r: any) => s + r.n_v3, 0);
  return w ? Math.round((rows.reduce((s: number, r: any) => s + r[key] * r.n_v3, 0) / w) * 10) / 10 : 0;
};
const COP_MEAS = { mild: _H.meta.cop.v3_median_mild as number, warm: _H.meta.cop.v3_median_warm as number };
const COP_POSS = { mild: _nwCop("cur", 0, 65), warm: _nwCop("cur", 65, 999) };
const COP_AF = { mild: _nwCop("af", 0, 65), warm: _nwCop("af", 65, 999) };
// same-model tank-temp effect → % less electricity for the same heat (honest, model-to-model)
const LESS_ELEC = {
  mild: Math.round((1 - COP_AF.mild / COP_POSS.mild) * 100),
  warm: Math.round((1 - COP_AF.warm / COP_POSS.warm) * 100),
};

// ── REALIZED savings from the 2026-07-16 cutover (buffer 154→135°F, setpoints 160→145°F) ──
// Model from MEASURED parameters: standby UA≈25 BTU/hr·°F (coast-down, 2026-07-16), summer
// COP≈2.6 (A-4 tub test), SPAN daily pump energy 11.8 kWh/day. Two compounding effects:
//   (1) cooler leaving-water temp → higher COP (Carnot factor ∝ (W+459.67)/(W−outdoor));
//   (2) cooler tank → less standby heat to re-make (UA·ΔT).
// Metered confirmation from tempiq_cop_points accrues over the coming days.
const CUT = { bufBefore: 154, bufAfter: 135, spBefore: 160, spAfter: 145 };
const UA_BTU = 25, AMBIENT_F = 70, COP_BEFORE = 2.6, OUTDOOR_SUMMER = 85;
const copFactor = (w: number) => (w + 459.67) / (w - OUTDOOR_SUMMER); // ∝ COP at LWT = w
const COP_AFTER = COP_BEFORE * (copFactor(CUT.spAfter) / copFactor(CUT.spBefore));
const COP_PCT = Math.round((1 - copFactor(CUT.spBefore) / copFactor(CUT.spAfter)) * 100); // % less elec
const STBY_THERMAL_KWH_DAY = (UA_BTU * (CUT.bufBefore - CUT.bufAfter) * 24) / 3412; // less heat lost/day
const THERMAL_BEFORE = DAILY_KWH * COP_BEFORE;
const ELEC_AFTER = Math.max(0, (THERMAL_BEFORE - STBY_THERMAL_KWH_DAY) / COP_AFTER);
const REALIZED_KWH_DAY = Math.max(0, DAILY_KWH - ELEC_AFTER);
const REALIZED_DAY_USD = REALIZED_KWH_DAY * RATE;
const REALIZED_MO_USD = REALIZED_DAY_USD * 30;
const STBY_ELEC_KWH_DAY = STBY_THERMAL_KWH_DAY / COP_AFTER;
const CUTOVER = "2026-07-16"; // the day the buffer target + setpoints dropped (start of the ledger)
const BASELINE_DAY_USD = DAILY_KWH * RATE; // what the OLD regime (HBX default curve + 75°C/160°F) cost/day

// ── Cumulative "saved to date vs the as-found regime" chart (owner ask 2026-07-18) ──
// Fed by the planner's MEASURED per-day realized_savings ledger (realized.ts): for each day, the
// as-found counterfactual (HBX default reset curve → old buffer target at the day's REAL outdoor
// temp, old ~163°F setpoints, + the extra standby the hotter tank bleeds) costed against actual
// metered pump electricity & measured COP. `daily` carries per-day baseline (as-found) vs actual
// $; the chart accrues them cumulatively, then projects the recent daily rate forward to day 30.
// Falls back to the static model only until the planner first populates the ledger.
function CumulativeSavings({
  daily, projDaily, savedLabel,
}: {
  daily: { label: string; baselineUsd: number; actualUsd: number }[];
  projDaily: { baselineUsd: number; actualUsd: number };
  savedLabel: string;
}) {
  const W = 900, H = 260, pad = { l: 46, r: 16, t: 14, b: 34 };
  type Pt = { i: number; label: string; baseline: number; actual: number; projected: boolean };
  const pts: Pt[] = [];
  let cumBase = 0, cumActual = 0;
  daily.forEach((o, i) => {
    cumBase += o.baselineUsd;
    cumActual += o.actualUsd;
    pts.push({ i, label: o.label, baseline: cumBase, actual: cumActual, projected: false });
  });
  const realN = pts.length;
  const savedToDate = cumBase - cumActual;
  // Projection: continue at the recent daily rate to fill out a 30-day horizon (clearly dashed).
  const horizon = Math.max(30, realN);
  for (let k = realN; k < horizon; k++) {
    cumBase += projDaily.baselineUsd;
    cumActual += projDaily.actualUsd;
    pts.push({ i: k, label: "", baseline: cumBase, actual: cumActual, projected: true });
  }
  const maxUsd = Math.max(1, pts[pts.length - 1].baseline);
  const X = (i: number) => pad.l + (horizon <= 1 ? 0 : (i / (horizon - 1)) * (W - pad.l - pad.r));
  const Y = (v: number) => pad.t + (1 - v / maxUsd) * (H - pad.t - pad.b);
  const realPts = pts.slice(0, realN);
  const line = (sel: (p: Pt) => number, arr: Pt[]) =>
    arr.map((p, j) => `${j ? "L" : "M"}${X(p.i).toFixed(1)},${Y(sel(p)).toFixed(1)}`).join("");
  // Saved band (between baseline and actual) over the REAL days only — the honest "already saved".
  const band = realN
    ? `M${realPts.map((p) => `${X(p.i).toFixed(1)},${Y(p.baseline).toFixed(1)}`).join("L")}` +
      `L${[...realPts].reverse().map((p) => `${X(p.i).toFixed(1)},${Y(p.actual).toFixed(1)}`).join("L")}Z`
    : "";
  const yTicks = [0, 0.5, 1].map((f) => f * maxUsd);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ height: "auto", aspectRatio: "900/260" }}>
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} stroke="#2c3640" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
          <text x={6} y={Y(v) + 4} fill="#8b98a5" fontSize={12}>${v.toFixed(0)}</text>
        </g>
      ))}
      {/* boundary between measured-to-date and projection */}
      {realN > 0 && realN < horizon && (
        <line x1={X(realN - 1)} x2={X(realN - 1)} y1={pad.t} y2={H - pad.b} stroke="#3d3222" strokeWidth={1.2} strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
      )}
      {band && <path d={band} fill="#63e6be" fillOpacity={0.16} vectorEffect="non-scaling-stroke" />}
      {/* baseline (what HBX-default + 75°C would cost) and actual (current regime), real + projected */}
      <path d={line((p) => p.baseline, realPts)} fill="none" stroke="#ff6b6b" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <path d={line((p) => p.actual, realPts)} fill="none" stroke="#4dabf7" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <path d={line((p) => p.baseline, pts.slice(Math.max(0, realN - 1)))} fill="none" stroke="#ff6b6b" strokeOpacity={0.5} strokeWidth={1.6} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
      <path d={line((p) => p.actual, pts.slice(Math.max(0, realN - 1)))} fill="none" stroke="#4dabf7" strokeOpacity={0.5} strokeWidth={1.6} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
      {/* running total callout at the last real day */}
      {realN > 0 && (
        <g>
          <circle cx={X(realN - 1)} cy={Y(realPts[realN - 1].actual)} r={3} fill="#63e6be" />
          <text x={X(realN - 1) + 8} y={Y(realPts[realN - 1].actual) - 6} fill="#63e6be" fontSize={12.5} fontWeight={700}>
            ${savedToDate.toFixed(2)} {savedLabel}
          </text>
        </g>
      )}
      {/* x labels: first, boundary, last */}
      {realN > 0 && <text x={X(0)} y={H - 10} fill="#8b98a5" fontSize={11.5}>{realPts[0].label}</text>}
      {realN > 0 && <text x={X(realN - 1)} y={H - 10} fill="#8b98a5" fontSize={11.5} textAnchor="middle">{realPts[realN - 1].label}</text>}
      <text x={X(horizon - 1)} y={H - 10} fill="#8b98a5" fontSize={11.5} textAnchor="end">+{horizon - realN}d projected</text>
    </svg>
  );
}

const WINDOWS: Record<string, { label: string; interval: string | null }> = {
  "24h": { label: "24h", interval: "24 hours" },
  "7d": { label: "7d", interval: "7 days" },
  "30d": { label: "30d", interval: "30 days" },
  all: { label: "all", interval: null }, // since scoring began (2026-07-14)
};

export default async function SavingsPage({ searchParams }: { searchParams: { window?: string } }) {
  const win = WINDOWS[searchParams.window ?? "7d"] ? (searchParams.window ?? "7d") : "7d";
  const winInterval = WINDOWS[win].interval;

  let gapAvg: number | null = null;
  let gapSum: number | null = null;
  let gapN = 0;
  let gap24avg: number | null = null;
  let gap24n = 0;
  let kwh24: number | null = null;
  let kwh7d: number | null = null;
  let elementCallH7d = 0;
  let hygieneHoursAgo: number | null = null;
  let writes: { ts: number; source: string; action: string; result: string; detail: string }[] = [];
  let episodes: { s: number; c: number | null; detail: string }[] = [];
  let opDays: { d: string; frac: number }[] = [];
  let realized: {
    day: string; savedUsd: number; actualElecKwh: number; cfElecKwh: number;
    copNow: number; copOld: number; avgOutdoorF: number; sessions: number; confidence: string;
  }[] = [];
  let dbError = false;

  try {
    const g = await sql`SELECT avg(gap_f)::float8 AS avg, count(gap_f)::int AS n
                        FROM plan_scores WHERE hour_ts >= now() - interval '24 hours'`;
    if (g.rows[0].n > 0) { gap24avg = g.rows[0].avg; gap24n = g.rows[0].n; }

    const gw = winInterval
      ? await sql`SELECT avg(gap_f)::float8 AS avg, sum(gap_f)::float8 AS sum, count(gap_f)::int AS n
                  FROM plan_scores WHERE hour_ts >= now() - (${winInterval})::interval`
      : await sql`SELECT avg(gap_f)::float8 AS avg, sum(gap_f)::float8 AS sum, count(gap_f)::int AS n
                  FROM plan_scores`;
    if (gw.rows[0].n > 0) { gapAvg = gw.rows[0].avg; gapSum = gw.rows[0].sum; gapN = gw.rows[0].n; }

    kwh24 = DAILY_KWH;
    kwh7d = DAILY_KWH * 7;

    const e = await sql`SELECT (count(*) FILTER (WHERE backup_called))::float8 * 5 / 60 AS callh
                        FROM slx_readings WHERE ts >= now() - interval '7 days'`;
    elementCallH7d = Number(e.rows[0].callh ?? 0);

    const h = await sql`SELECT EXTRACT(EPOCH FROM (now() - max(ts)))::float8 / 3600 AS hrs
                        FROM slx_readings WHERE tank_f >= 131`;
    hygieneHoursAgo = h.rows[0]?.hrs == null ? null : Number(h.rows[0].hrs);

    // Real operating coverage per day, within the SELECTED window (never before the cutover — that's
    // when savings began). 288 = 5-min samples in a full day, so frac is the share of the day the
    // system actually reported (an offline day accrues no savings). The window drives this chart AND
    // the summary card below, so the toggle is live end-to-end.
    const od = winInterval
      ? await sql`
          SELECT to_char(date_trunc('day', ts AT TIME ZONE 'America/New_York'), 'YYYY-MM-DD') AS d,
                 count(*)::int AS n
          FROM slx_readings
          WHERE ts >= GREATEST(${CUTOVER}::timestamptz, now() - (${winInterval})::interval)
          GROUP BY 1 ORDER BY 1`
      : await sql`
          SELECT to_char(date_trunc('day', ts AT TIME ZONE 'America/New_York'), 'YYYY-MM-DD') AS d,
                 count(*)::int AS n
          FROM slx_readings WHERE ts >= ${CUTOVER} GROUP BY 1 ORDER BY 1`;
    opDays = (od.rows as any[]).map((r) => ({ d: r.d, frac: Math.min(1, Number(r.n) / 288) }));

    // The planner's MEASURED per-day realized-savings ledger (realized_savings) — the source of
    // truth. Own try/catch: the table only exists once the planner deploys + runs ensureSchema, and
    // a missing table must fall back to the static model, not blank the page.
    try {
      const rs = winInterval
        ? await sql`SELECT to_char(day,'YYYY-MM-DD') AS day, saved_usd, actual_elec_kwh, cf_elec_kwh,
                           cop_now, cop_old, avg_outdoor_f, sessions, confidence
                    FROM realized_savings WHERE day >= (now() - (${winInterval})::interval)::date ORDER BY day`
        : await sql`SELECT to_char(day,'YYYY-MM-DD') AS day, saved_usd, actual_elec_kwh, cf_elec_kwh,
                           cop_now, cop_old, avg_outdoor_f, sessions, confidence
                    FROM realized_savings ORDER BY day`;
      realized = (rs.rows as any[]).map((r) => ({
        day: r.day, savedUsd: Number(r.saved_usd), actualElecKwh: Number(r.actual_elec_kwh),
        cfElecKwh: Number(r.cf_elec_kwh), copNow: Number(r.cop_now), copOld: Number(r.cop_old),
        avgOutdoorF: Number(r.avg_outdoor_f), sessions: Number(r.sessions), confidence: r.confidence,
      }));
    } catch { /* realized_savings not created yet — fall back to the static model below */ }

    writes = (await sql`
      SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, source, action, result, detail
      FROM hbx_writes ORDER BY id DESC LIMIT 8`).rows as any[];
    try {
      episodes = (await sql`
        SELECT EXTRACT(EPOCH FROM started_at)::float8 AS s,
               EXTRACT(EPOCH FROM cleared_at)::float8 AS c, detail
        FROM i1_episodes ORDER BY id DESC LIMIT 6`).rows as any[];
    } catch { /* table appears with the planner deploy that persists episodes */ }
  } catch {
    dbError = true;
  }

  // The headline: what running as hot as today costs vs running the plan's temperatures.
  const wasteFrac = gap24avg != null ? Math.min(gap24avg * COP_SENS_PER_F, 0.5) : null;
  const dailyKwh = kwh24;
  const dailyWasteUsd = wasteFrac != null && dailyKwh != null ? dailyKwh * wasteFrac * RATE : null;
  const monthlyWasteUsd = dailyWasteUsd != null ? dailyWasteUsd * 30 : null;
  const dailyCostUsd = dailyKwh != null ? dailyKwh * RATE : null;

  // The accumulating would-have-saved ledger (owner ask 2026-07-15): every scored hour
  // contributes hourly_kWh × gap°F × sensitivity × rate. Because savings scale ~linearly
  // with how much of the gap you close, partial-adoption scenarios are fractions of the
  // full number — "run 10°F cooler than today" ≈ (10 / avg gap) of the full plan.
  const hourlyKwh = DAILY_KWH / 24;
  const savedAt = (frac: number) =>
    gapSum == null ? null : hourlyKwh * Math.min(gapSum * frac * COP_SENS_PER_F, gapN * 0.5) * RATE;
  const projectMonthly = (v: number | null) =>
    v == null || gapN === 0 ? null : (v / gapN) * 720; // per-scored-hour rate × hours/month
  const scenarios = [
    { frac: 1.0, label: "Full plan (planner's recs)" },
    { frac: 0.75, label: "75% of the way" },
    { frac: 0.5, label: "Halfway (e.g. modest curve + setpoint trim)" },
    { frac: 0.25, label: "Light touch (a few °F cooler)" },
  ].map((s) => {
    const saved = savedAt(s.frac);
    return {
      ...s,
      saved,
      monthly: projectMonthly(saved),
      coolerF: gapAvg == null ? null : gapAvg * s.frac,
    };
  });

  const hygieneOk = hygieneHoursAgo != null && hygieneHoursAgo <= 26;

  // ── Window summary (owner ask 2026-07-18): Spent / Saved / Missed for the selected window. ──
  //   Spent  = actual metered pump electricity this window × rate — the real outlay.
  //   Saved  = the planner's MEASURED realized ledger vs the as-found regime (real, per-day).
  //   Missed = what the planner could STILL save if the plan were fully followed — the gap on the
  //            table (the would-have-saved ledger's full-plan figure; shrinks as autopilot closes it).
  // Prefer the measured realized_savings ledger; fall back to the static model only until it fills.
  const haveReal = realized.length > 0;
  const opDaySum = opDays.reduce((s, o) => s + o.frac, 0); // effective operating days in window (fallback)
  const winSpentUsd = haveReal
    ? realized.reduce((s, r) => s + r.actualElecKwh * RATE, 0)
    : DAILY_KWH * opDaySum * RATE;
  const winSavedUsd = haveReal
    ? realized.reduce((s, r) => s + r.savedUsd, 0)
    : REALIZED_DAY_USD * opDaySum;
  const winMissedUsd = scenarios[0]?.saved ?? null; // full-plan would-have-saved, this window

  // Per-day (baseline as-found $ vs actual $) feeding the cumulative chart — measured or fallback.
  const chartDaily = haveReal
    ? realized.map((r) => ({ label: r.day.slice(5), baselineUsd: r.cfElecKwh * RATE, actualUsd: r.actualElecKwh * RATE }))
    : opDays.map((o) => ({ label: o.d.slice(5), baselineUsd: BASELINE_DAY_USD * o.frac, actualUsd: (BASELINE_DAY_USD - REALIZED_DAY_USD) * o.frac }));
  // Projection = recent daily rate (avg of the last up-to-3 measured days), so the dashed tail
  // reflects how the system is actually running now, not a stale constant.
  const recent = chartDaily.slice(-3);
  const projDaily = recent.length
    ? { baselineUsd: recent.reduce((s, d) => s + d.baselineUsd, 0) / recent.length, actualUsd: recent.reduce((s, d) => s + d.actualUsd, 0) / recent.length }
    : { baselineUsd: BASELINE_DAY_USD, actualUsd: BASELINE_DAY_USD - REALIZED_DAY_USD };

  const savedLabel = win === "all" ? "saved to date" : `saved · last ${WINDOWS[win].label}`;
  const chartSubtitle = `${win === "all" ? "cumulative $, since the " + CUTOVER + " cutover" : "cumulative $, last " + WINDOWS[win].label}${haveReal ? " · measured per-day" : " · modeled (ledger filling)"}`;

  // Real per-day ledger rollups for the "Realized" card (when the measured ledger exists).
  const realDaysN = realized.length;
  const realAvgSavedDayUsd = realDaysN ? winSavedUsd / realDaysN : null;
  const realPerMonthUsd = realAvgSavedDayUsd != null ? realAvgSavedDayUsd * 30 : null;
  const realKwhSavedDay = realDaysN ? realized.reduce((s, r) => s + (r.cfElecKwh - r.actualElecKwh), 0) / realDaysN : null;
  const realCopNow = realDaysN ? realized.reduce((s, r) => s + r.copNow, 0) / realDaysN : null;
  const realCopOld = realDaysN ? realized.reduce((s, r) => s + r.copOld, 0) / realDaysN : null;
  const realOutdoor = realDaysN ? realized.reduce((s, r) => s + r.avgOutdoorF, 0) / realDaysN : null;
  const realMeasuredDays = realized.filter((r) => r.confidence === "measured").length;

  return (
    <>
      <I1Banner />
      <StormBanner />

      <div className="controls">
        <div className="seg">
          {Object.entries(WINDOWS).map(([k, w]) => (
            <a key={k} className={win === k ? "active" : ""} href={`/savings?window=${k}`}>{w.label}</a>
          ))}
        </div>
        <span className="dim" style={{ alignSelf: "center", fontSize: 12 }}>
          time window · drives the chart, the summary, and the ledger below
        </span>
      </div>

      {dbError ? (
        <div className="empty">Database not reachable.</div>
      ) : (
        <>
          <div className="chart-block">
            <h3>Saved to date — current setup vs. HBX defaults + 75&nbsp;°C setpoints <span className="dim">({chartSubtitle})</span></h3>
            {chartDaily.length === 0 ? (
              <div className="meta">
                No operating days recorded in this window yet — savings accrue from the {CUTOVER} cutover.
                Try a wider window (7d / 30d / all).
              </div>
            ) : (
              <>
                <CumulativeSavings daily={chartDaily} projDaily={projDaily} savedLabel={savedLabel} />
                {/* Window summary — the toggle's headline effect: what you spent, kept, and left on the table. */}
                <div className="temps" style={{ marginTop: 10 }}>
                  <div className="temp"><div className="v">${winSpentUsd.toFixed(2)}</div><div className="l">spent · {WINDOWS[win].label}</div></div>
                  <div className="temp"><div className="v" style={{ color: "#63e6be" }}>${winSavedUsd.toFixed(2)}</div><div className="l">saved vs. as-found</div></div>
                  <div className="temp"><div className="v" style={{ color: "#ffd666" }}>{winMissedUsd == null ? "—" : `$${winMissedUsd.toFixed(2)}`}</div><div className="l">still on the table</div></div>
                </div>
                <div className="meta" style={{ marginTop: 8 }}>
                  <span style={{ color: "#ff6b6b" }}>■</span> what the pumps <b>as found</b> (HBX default
                  curve → old buffer target at the day&apos;s <b>real outdoor temp</b>, old ~163&nbsp;°F setpoints)
                  would have cost ·{" "}
                  <span style={{ color: "#4dabf7" }}>■</span> what the <b>current</b> cooler-tank regime
                  actually cost · <span style={{ color: "#63e6be" }}>■</span> the gap is money kept.{" "}
                  {haveReal ? (
                    <>Computed <b>per day from measured data</b> — the pumps&apos; metered electricity and measured
                    COP ({realCopNow?.toFixed(2)} now vs ~{realCopOld?.toFixed(2)} at the old hotter water), plus the
                    extra standby the hotter as-found tank would bleed (measured UA ≈ {UA_BTU} BTU/hr·°F).
                    {realMeasuredDays < realDaysN ? ` ${realMeasuredDays}/${realDaysN} days are metered; the rest use the COP model until telemetry lands.` : ""}</>
                  ) : (
                    <>Interim static estimate while the planner&apos;s measured per-day ledger fills in — it takes over automatically.</>
                  )}{" "}
                  The dashed tail projects the recent daily rate forward — summer / hot-water-only; winter runs larger.
                </div>
                <div className="meta" style={{ marginTop: 6 }}>
                  <b>Spent</b> = the pumps&apos; cost this window · <b style={{ color: "#63e6be" }}>Saved</b> =
                  kept vs. the as-found HBX-default + 75&nbsp;°C setup · <b style={{ color: "#ffd666" }}>Still
                  on the table</b> = what the planner could yet save if the plan were fully followed — it
                  shrinks as autopilot closes the gap.
                </div>
              </>
            )}
          </div>

          <div className="cards">
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <h2>Realized — measured vs. the as-found regime<span className={`chip ${haveReal ? "ok" : "warn"}`}>{haveReal ? "live · per-day metered" : "ledger filling"}</span></h2>
              {haveReal ? (
                <>
                  <div className="temps">
                    <div className="temp"><div className="v">${realPerMonthUsd == null ? "—" : realPerMonthUsd.toFixed(0)}</div><div className="l">≈ saved / month (at this rate)</div></div>
                    <div className="temp"><div className="v">${realAvgSavedDayUsd == null ? "—" : realAvgSavedDayUsd.toFixed(2)}</div><div className="l">avg saved / day</div></div>
                    <div className="temp"><div className="v">{realCopNow?.toFixed(2)} → {realCopOld?.toFixed(2)}</div><div className="l">COP now vs. as-found</div></div>
                  </div>
                  <div className="meta">
                    Computed <b>per day from measured data</b>, not a static guess. Over {realDaysN} day{realDaysN === 1 ? "" : "s"}
                    {" "}({realMeasuredDays} metered) at avg <b>{realOutdoor?.toFixed(0)}°F</b> outdoor, the current cooler-tank
                    regime saved ≈ <b>${winSavedUsd.toFixed(2)}</b> vs. running the original HBX default curve + ~163°F setpoints
                    — that&apos;s the pumps&apos; measured COP ({realCopNow?.toFixed(2)}) beating the old hotter-water COP
                    (~{realCopOld?.toFixed(2)}) on the heat actually delivered, plus ≈ <b>{realKwhSavedDay?.toFixed(1)} kWh/day</b>
                    of extra pump-work the hotter as-found tank&apos;s standby would have demanded. At ${RATE.toFixed(2)}/kWh.
                    Summer / hot-water-only — winter runs larger. (Resistive-backup credit not yet included — pending the pumps&apos;
                    max water-temp spec.)
                  </div>
                </>
              ) : (
                <>
                  <div className="temps">
                    <div className="temp"><div className="v">${REALIZED_MO_USD.toFixed(0)}</div><div className="l">≈ saved / month</div></div>
                    <div className="temp"><div className="v">{REALIZED_KWH_DAY.toFixed(1)} kWh</div><div className="l">≈ saved / day</div></div>
                    <div className="temp"><div className="v">154→135 · 160→145</div><div className="l">buffer · setpoints °F</div></div>
                  </div>
                  <div className="meta">
                    Interim static estimate: buffer <b>154→135°F</b>, setpoints <b>160→145°F</b> — cooler water raises COP
                    (≈ <b>{COP_PCT}% less electricity</b>) and the cooler tank bleeds ≈ <b>{STBY_ELEC_KWH_DAY.toFixed(1)} kWh/day</b>
                    less standby. The planner&apos;s <b>measured per-day ledger</b> replaces this the moment it populates.
                  </div>
                </>
              )}
            </div>

            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <h2>If the planner were in charge<span className="chip">rough estimate</span></h2>
              <div className="temps">
                <div className="temp">
                  <div className="v">{monthlyWasteUsd == null ? "—" : `$${monthlyWasteUsd.toFixed(0)}`}</div>
                  <div className="l">potential / month</div>
                </div>
                <div className="temp">
                  <div className="v">{gap24avg == null ? "—" : `${gap24avg.toFixed(0)}°F`}</div>
                  <div className="l">hotter than needed</div>
                </div>
                <div className="temp">
                  <div className="v">{dailyCostUsd == null ? "—" : `$${dailyCostUsd.toFixed(2)}`}</div>
                  <div className="l">pumps cost / day</div>
                </div>
              </div>
              <div className="meta">
                Over the last 24h your tank averaged <b>{fmt(gap24avg, 0)}°F hotter</b> than the shadow
                plan says it needed to be. Heating water cooler is cheaper — roughly 1% less electricity
                per °F. Applied to your measured {fmt(dailyKwh, 1)} kWh/day at ${RATE.toFixed(2)}/kWh,
                that&apos;s ≈ <b>${fmt(dailyWasteUsd, 2)}/day</b> currently left on the table.
                This is a summer (hot-water-only) figure; the winter number is larger.
                The ~1%/°F slope is the exact thing the A-4 test measures for your pumps.
              </div>
            </div>

            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <h2>Why cooler water is cheaper<span className="chip warn">measured vs. modeled</span></h2>
              <div className="temps">
                <div className="temp"><div className="v">{COP_MEAS.mild} → {COP_MEAS.warm}</div><div className="l">COP today · measured</div></div>
                <div className="temp"><div className="v">{COP_POSS.mild} → {COP_POSS.warm}</div><div className="l">COP possible · modeled</div></div>
                <div className="temp"><div className="v">{LESS_ELEC.mild}–{LESS_ELEC.warm}%</div><div className="l">less power, same heat</div></div>
              </div>
              <div className="meta">
                Efficiency (COP) is heat delivered per unit of electricity — higher is cheaper. Today the pumps hold a
                150–165°F tank and measure COP ≈ {COP_MEAS.mild}–{COP_MEAS.warm} (mild → warm weather). The same pumps making
                the planner&apos;s cooler ~120°F summer water model out at COP ≈ {COP_POSS.mild}–{COP_POSS.warm}. Apples-to-apples
                (same efficiency model, only the water gets cooler) that&apos;s <b>{LESS_ELEC.mild}–{LESS_ELEC.warm}% less
                electricity for the same hot water</b> — which is where the dollars above come from.{" "}
                <a href="/curve" style={{ color: "#4dabf7" }}>Full breakdown on the curve →</a>
              </div>
            </div>

            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <h2>What you&apos;d have saved — and at partial adoption<span className="chip">forward ledger · {WINDOWS[win].label}</span></h2>
              {gapN === 0 ? (
                <div className="meta">No scored hours in this window yet — the ledger fills as the planner scores each completed hour.</div>
              ) : (
                <>
                  <div className="temps">
                    <div className="temp">
                      <div className="v">{scenarios[0].saved == null ? "—" : `$${scenarios[0].saved.toFixed(2)}`}</div>
                      <div className="l">full plan, this window</div>
                    </div>
                    <div className="temp">
                      <div className="v">{scenarios[0].monthly == null ? "—" : `$${scenarios[0].monthly.toFixed(0)}`}</div>
                      <div className="l">≈ / month at this rate</div>
                    </div>
                    <div className="temp">
                      <div className="v">{gapN}</div>
                      <div className="l">hours scored</div>
                    </div>
                  </div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse", marginTop: 6 }}>
                      <thead>
                        <tr style={{ color: "var(--dim)", textAlign: "left" }}>
                          <th style={{ padding: "3px 8px" }}>if you ran…</th>
                          <th style={{ padding: "3px 8px" }}>≈ how much cooler</th>
                          <th style={{ padding: "3px 8px" }}>saved ({WINDOWS[win].label})</th>
                          <th style={{ padding: "3px 8px" }}>≈ / month forward</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scenarios.map((s) => (
                          <tr key={s.frac} style={{ borderTop: "1px solid var(--line)" }}>
                            <td style={{ padding: "3px 8px" }}>{s.label}</td>
                            <td style={{ padding: "3px 8px" }}>{s.coolerF == null ? "—" : `${s.coolerF.toFixed(0)}°F below today`}</td>
                            <td style={{ padding: "3px 8px", fontVariantNumeric: "tabular-nums" }}>{s.saved == null ? "—" : `$${s.saved.toFixed(2)}`}</td>
                            <td style={{ padding: "3px 8px", fontVariantNumeric: "tabular-nums" }}>{s.monthly == null ? "—" : `$${s.monthly.toFixed(0)}`}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="meta">
                    Every scored hour adds to this ledger — it only grows more accurate. Partial rows
                    answer &quot;what if I don&apos;t go all the way&quot;: e.g. the halfway row ≈ trimming
                    setpoints below 75 °C and the curve by ~{scenarios[2].coolerF == null ? "—" : scenarios[2].coolerF.toFixed(0)}°F.
                    Savings scale ~linearly with °F closed (capped at 50% total). Monthly projections
                    extrapolate this window&apos;s rate; summer regime — winter will run higher.
                  </div>
                </>
              )}
            </div>

            <div className="card">
              <h2>Expensive backup heater<span className={`chip ${elementCallH7d > 0 ? "warn" : "ok"}`}>{elementCallH7d > 0 ? "was called" : "quiet"}</span></h2>
              <div className="temps">
                <div className="temp"><div className="v">{elementCallH7d.toFixed(1)}</div><div className="l">hrs called (7d)</div></div>
                <div className="temp"><div className="v">${(16.5 * RATE).toFixed(0)}/h</div><div className="l">cost if it runs</div></div>
              </div>
              <div className="meta">
                The 16.5 kW electric element is the most expensive heat in the house. HBX asked for it
                {elementCallH7d > 0 ? ` for ${elementCallH7d.toFixed(1)} hours this week` : " zero hours this week"} —
                whether it actually ran is up to its breaker, which you manage. Once targets are
                reachable (Phase B), it becomes a true emergency-only backup you can safely leave on.
              </div>
            </div>

            <div className="card">
              <h2>Bacteria safety<span className={`chip ${hygieneOk ? "ok" : "warn"}`}>{hygieneOk ? "OK today" : "check"}</span></h2>
              <div className="temps">
                <div className="temp"><div className="v">{fmt(hygieneHoursAgo, 0)}</div><div className="l">hrs since 131°F+</div></div>
                <div className="temp"><div className="v">24</div><div className="l">must happen within</div></div>
              </div>
              <div className="meta">
                The hot-water coil must get a daily hot soak (≥131°F for an hour) so nothing grows in
                it when we run the tank cooler. Today&apos;s system is always hot, so it passes trivially —
                the planner schedules this automatically once cooler targets go live, always in the
                cheapest (warmest) hour.
              </div>
            </div>

            <div className="card">
              <h2>Your pumps this week<span className="chip">SPAN baseline</span></h2>
              <div className="temps">
                <div className="temp"><div className="v">{fmt(kwh7d, 0)}</div><div className="l">kWh (7d)</div></div>
                <div className="temp"><div className="v">{kwh7d == null ? "—" : `$${(kwh7d * RATE).toFixed(0)}`}</div><div className="l">≈ cost (7d)</div></div>
              </div>
              <div className="meta">
                From your SPAN panel&apos;s July average ({DAILY_KWH} kWh/day) — all hot water, no space
                heating this month. Live per-minute numbers take over once the pumps&apos; power registers
                are calibrated against SPAN (a known commissioning item riding the next release).
              </div>
            </div>
          </div>

          <div className="chart-block">
            <h3>Changes made through this system <span className="dim">(every attempt is recorded, allowed or refused)</span></h3>
            {writes.length === 0 ? (
              <div className="meta">None yet.</div>
            ) : writes.map((w, i) => (
              <div className="meta" key={i}>
                {fmtDateTime(w.ts)} ·
                {" "}<b style={{ color: w.result === "accepted" ? "var(--ok)" : "var(--warm)" }}>{w.result}</b> · {w.detail}
              </div>
            ))}
          </div>

          <div className="chart-block">
            <h3>Conflict incidents <span className="dim">(times a pump setpoint sat below what the tank target required)</span></h3>
            {episodes.length === 0 ? (
              <div className="meta">None recorded since episode tracking began.</div>
            ) : episodes.map((e, i) => (
              <div className="meta" key={i}>
                {fmtDateTime(e.s)} → {e.c ? fmtDateTime(e.c) : <b style={{ color: "var(--crit)" }}>ongoing</b>}
                {e.c ? ` (${((e.c - e.s) / 3600).toFixed(1)}h)` : ""} · {e.detail}
              </div>
            ))}
          </div>

          <div className="chart-block">
            <h3>Why these are estimates — and what makes them exact</h3>
            <div className="meta">
              <b>1. Your pumps&apos; real efficiency curve</b> — the A-4 test (one tub of hot water, ~30 min)
              replaces the ~1%/°F assumption with your measured number.<br />
              <b>2. Billing-grade energy</b> — the SPAN panel data + your real electric rate arrive via
              the TempIQ insights API (issue #1470).<br />
              <b>3. Turning it on</b> — once Phase B lets the planner actually manage temperatures, this
              page stops estimating what you <i>could</i> save and starts reporting what you <i>did</i>.
            </div>
            <div className="meta" style={{ marginTop: 6 }}>
              <span className="dim">Engineering detail: 24h avg gap {fmt(gap24avg)}°F across {gap24n} scored hours;
              rate assumption ${RATE.toFixed(2)}/kWh (set ELECTRIC_RATE_USD_KWH); waste fraction capped at 50%.</span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
