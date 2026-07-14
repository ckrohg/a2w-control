// @purpose Savings page v0 (kanban card) — the measurable-today evidence: plan-vs-actual
// opportunity gap (°F·h the as-found system ran hotter than the shadow plan), backup-element
// call accounting, estimated pump energy by day, I8 thermal-hygiene status, and the HBX
// write audit. v1 (real $) arrives with the A-6 weather-normalized baseline + TempIQv2#1470
// (SPAN kWh + rates) — the explainer at the bottom says exactly what upgrades this page.
import { sql } from "@vercel/postgres";
import { I1Banner } from "../i1-banner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const fmt = (v: number | null | undefined, d = 1) =>
  v == null || !isFinite(v as number) ? "—" : (v as number).toFixed(d);

export default async function SavingsPage() {
  let gap24: { avg: number; sum: number; n: number } | null = null;
  let gap7d: { avg: number; sum: number; n: number } | null = null;
  let elementDays: { day: string; callH: number }[] = [];
  let pumpDays: { day: string; pump: string; kwh: number }[] = [];
  let hygieneHoursAgo: number | null = null;
  let writes: { ts: number; source: string; action: string; result: string; detail: string }[] = [];
  let dbError = false;

  try {
    const g = async (interval: string) => {
      const r = await sql`SELECT avg(gap_f)::float8 AS avg, sum(gap_f)::float8 AS sum, count(gap_f)::int AS n
                          FROM plan_scores WHERE hour_ts >= now() - ${interval}::interval`;
      return r.rows[0].n > 0 ? { avg: r.rows[0].avg, sum: r.rows[0].sum, n: r.rows[0].n } : null;
    };
    gap24 = await g("24 hours");
    gap7d = await g("7 days");

    elementDays = (await sql`
      SELECT to_char(date_trunc('day', ts), 'Mon DD') AS day,
             (count(*) FILTER (WHERE backup_called))::float8 * 5 / 60 AS callh
      FROM slx_readings WHERE ts >= now() - interval '14 days'
      GROUP BY date_trunc('day', ts) ORDER BY date_trunc('day', ts) DESC`).rows
      .map((r) => ({ day: r.day as string, callH: Number(r.callh) }));

    pumpDays = (await sql`
      SELECT to_char(to_timestamp(ts)::date, 'Mon DD') AS day, pump_id AS pump,
             (sum(power_w) / 60000)::float8 AS kwh
      FROM readings WHERE ts >= extract(epoch FROM now() - interval '7 days')
      GROUP BY to_timestamp(ts)::date, pump_id ORDER BY to_timestamp(ts)::date DESC, pump_id`).rows
      .map((r) => ({ day: r.day as string, pump: r.pump as string, kwh: Number(r.kwh) }));

    const h = await sql`SELECT EXTRACT(EPOCH FROM (now() - max(ts)))::float8 / 3600 AS hrs
                        FROM slx_readings WHERE tank_f >= 131`;
    hygieneHoursAgo = h.rows[0]?.hrs == null ? null : Number(h.rows[0].hrs);

    writes = (await sql`
      SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, source, action, result, detail
      FROM hbx_writes ORDER BY id DESC LIMIT 10`).rows as any[];
  } catch {
    dbError = true;
  }

  const hygieneOk = hygieneHoursAgo != null && hygieneHoursAgo <= 26;

  return (
    <>
      <header>
        <h1>Savings</h1>
        <span className="dim">v0 — evidence in °F·h and call-hours; $ arrives with the baseline + TempIQ insights</span>
        <a className="btn" href="/" style={{ marginLeft: "auto", textDecoration: "none" }}>Home</a>
        <form action="/api/logout" method="post"><button type="submit">Sign out</button></form>
      </header>

      <I1Banner />

      {dbError ? (
        <div className="empty">Database not reachable.</div>
      ) : (
        <>
          <div className="cards">
            <div className="card">
              <h2>Opportunity gap<span className="chip">shadow vs actual</span></h2>
              <div className="temps">
                <div className="temp"><div className="v">{fmt(gap24?.avg)}°</div><div className="l">avg °F (24h)</div></div>
                <div className="temp"><div className="v">{fmt(gap24?.sum, 0)}</div><div className="l">°F·h (24h)</div></div>
                <div className="temp"><div className="v">{fmt(gap7d?.sum, 0)}</div><div className="l">°F·h (7d)</div></div>
              </div>
              <div className="meta">
                How much hotter the as-found HBX target ran than the shadow plan wanted,
                hour by hour. This is the raw material Phase B/C converts into kWh.
                {gap24 ? ` Scored ${gap24.n} of the last 24 hours.` : " Scoring begins as plans accumulate."}
              </div>
            </div>

            <div className="card">
              <h2>Thermal hygiene<span className={`chip ${hygieneOk ? "ok" : "warn"}`}>{hygieneOk ? "I8 met" : "check"}</span></h2>
              <div className="temps">
                <div className="temp"><div className="v">{fmt(hygieneHoursAgo)}</div><div className="l">hrs since ≥131°F</div></div>
                <div className="temp"><div className="v">26</div><div className="l">alert threshold</div></div>
              </div>
              <div className="meta">
                The DHW coil&apos;s potable slug must see ≥131°F within every rolling 24h (invariant I8).
                As-found operation satisfies this trivially; it becomes load-bearing when optimized
                targets go live.
              </div>
            </div>

            <div className="card">
              <h2>Backup element<span className="chip">{elementDays.some((d) => d.callH > 0) ? "called recently" : "quiet"}</span></h2>
              <div className="meta" style={{ marginTop: 2 }}>
                Call-hours by day (HBX asked; SPAN decides if it actually ran — element is
                owner-managed at the panel):
                {elementDays.slice(0, 7).map((d) => (
                  <span key={d.day}><br />{d.day}: {d.callH > 0 ? `${d.callH.toFixed(1)} h` : "0"}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="chart-block">
            <h3>Pump energy — estimated kWh/day <span className="dim">(integrated from 60s power samples; SPAN is the accounting truth)</span></h3>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: "var(--dim)", textAlign: "left" }}>
                    <th style={{ padding: "3px 8px" }}>day</th>
                    <th style={{ padding: "3px 8px" }}>pump</th>
                    <th style={{ padding: "3px 8px" }}>est. kWh</th>
                  </tr>
                </thead>
                <tbody>
                  {pumpDays.map((r, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "3px 8px" }}>{r.day}</td>
                      <td style={{ padding: "3px 8px" }}>{r.pump}</td>
                      <td style={{ padding: "3px 8px", fontVariantNumeric: "tabular-nums" }}>{r.kwh.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="chart-block">
            <h3>HBX write audit <span className="dim">(every attempt through the guarded path, accepted or rejected)</span></h3>
            {writes.length === 0 ? (
              <div className="meta">No writes yet.</div>
            ) : writes.map((w, i) => (
              <div className="meta" key={i}>
                {new Date(w.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} ·
                {" "}{w.source} · {w.action} · <b style={{ color: w.result === "accepted" ? "var(--ok)" : "var(--warm)" }}>{w.result}</b> · {w.detail}
              </div>
            ))}
          </div>

          <div className="chart-block">
            <h3>What upgrades this page to real dollars</h3>
            <div className="meta">
              1. <b>A-6 baseline freeze</b> — the weather-normalized kWh model of the as-found system
              (plan §8.1); every day then gets a &quot;what the old system would have used&quot; counterfactual.<br />
              2. <b>TempIQv2#1470</b> — SPAN circuit kWh (the metered truth incl. fixed-frequency
              compressors) + your real $/kWh via the insights API.<br />
              3. <b>Phase B live</b> — once setpoints actually track, the gap on this page stops being
              &quot;opportunity&quot; and starts being &quot;captured&quot;.
            </div>
          </div>
        </>
      )}
    </>
  );
}
