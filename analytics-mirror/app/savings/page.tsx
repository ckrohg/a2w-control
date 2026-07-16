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

const WINDOWS: Record<string, { label: string; interval: string | null }> = {
  "24h": { label: "24h", interval: "24 hours" },
  "7d": { label: "7d", interval: "7 days" },
  "30d": { label: "30d", interval: "30 days" },
  all: { label: "all", interval: null }, // since scoring began (2026-07-14)
};

export default async function SavingsPage({ searchParams }: { searchParams: { window?: string } }) {
  const win = WINDOWS[searchParams.window ?? "24h"] ? (searchParams.window ?? "24h") : "24h";
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
          would-have-saved ledger window · accumulating since Jul 14
        </span>
      </div>

      {dbError ? (
        <div className="empty">Database not reachable.</div>
      ) : (
        <>
          <div className="cards">
            <div className="card" style={{ gridColumn: "1 / -1" }}>
              <h2>Realized — since today&apos;s cutover<span className="chip ok">live · measured params</span></h2>
              <div className="temps">
                <div className="temp"><div className="v">${REALIZED_MO_USD.toFixed(0)}</div><div className="l">≈ saved / month</div></div>
                <div className="temp"><div className="v">{REALIZED_KWH_DAY.toFixed(1)} kWh</div><div className="l">≈ saved / day</div></div>
                <div className="temp"><div className="v">154→135 · 160→145</div><div className="l">buffer · setpoints °F</div></div>
              </div>
              <div className="meta">
                Today the buffer target dropped <b>154→135°F</b> and both pump setpoints <b>160→145°F</b> — two
                compounding wins. Cooler leaving water raises efficiency (≈ <b>{COP_PCT}% less electricity</b> for
                the same hot water, COP ~{COP_BEFORE.toFixed(1)}→{COP_AFTER.toFixed(1)}), and the cooler tank bleeds
                ≈ <b>{STBY_ELEC_KWH_DAY.toFixed(1)} kWh/day</b> less standby heat (measured UA ≈ {UA_BTU} BTU/hr·°F).
                Combined ≈ <b>{REALIZED_KWH_DAY.toFixed(1)} kWh/day (${REALIZED_DAY_USD.toFixed(2)}/day, ${REALIZED_MO_USD.toFixed(0)}/mo)</b>
                {" "}at ${RATE.toFixed(2)}/kWh. Model-based on measured parameters (UA from the coast-down, COP from the
                A-4 test, {fmt(DAILY_KWH, 1)} kWh/day from SPAN); metered confirmation from the pumps&apos; COP telemetry
                accrues over the coming days. Summer / hot-water-only figure — winter is larger.
              </div>
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
