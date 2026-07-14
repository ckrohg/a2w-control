// @purpose Savings page v0.2 — rewritten for the owner after "really confusing" feedback.
// Leads with a dollars headline (rough, clearly labeled), then plain-English cards. The
// engineering numbers (°F·h, gap averages) survive in a small footnote line. $ math:
// measured pump kWh × (avg overshoot °F × ~1%/°F COP sensitivity) × rate — the 1%/°F is a
// typical figure for these water temps and is exactly what the A-4 test calibrates.
// Rate: ELECTRIC_RATE_USD_KWH env (default 0.30) until TempIQ#1470 supplies the real tariff.
import { sql } from "@vercel/postgres";
import { fmtDateTime } from "@/lib/tz";
import { I1Banner } from "../i1-banner";

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

export default async function SavingsPage() {
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

  const hygieneOk = hygieneHoursAgo != null && hygieneHoursAgo <= 26;

  return (
    <>
      <header>
        <h1>Savings</h1>
        <span className="dim">shadow mode — measuring what optimization is worth, not acting yet</span>
        <a className="btn" href="/curve" style={{ marginLeft: "auto", textDecoration: "none" }}>Curve</a>
        <a className="btn" href="/" style={{ textDecoration: "none" }}>Home</a>
        <form action="/api/logout" method="post"><button type="submit">Sign out</button></form>
      </header>

      <I1Banner />

      {dbError ? (
        <div className="empty">Database not reachable.</div>
      ) : (
        <>
          <div className="cards">
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
