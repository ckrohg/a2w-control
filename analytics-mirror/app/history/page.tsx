// @purpose History — the "look back" surface (owner ask 2026-07-18 note 4): scrub any past window
// and see the physical state over time (tank temp, target, outdoor) plus what the system saved and
// the moves autopilot made in that span. The home page only shows NOW; retention is indefinite
// (nothing prunes), so this makes the accumulated history actually browsable. All server-side from
// Neon; hourly-downsampled so a 30-day window stays light. House idioms: nodejs runtime,
// force-dynamic, parameterized sql, Eastern time via @/lib/tz, try/catch degraded states.
import { sql } from "@vercel/postgres";
import { fmtDateTime, fmtDay } from "@/lib/tz";
import { I1Banner } from "../i1-banner";
import { StormBanner } from "../storm-banner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const WINDOWS: Record<string, { label: string; interval: string; bucket: string }> = {
  "24h": { label: "24h", interval: "24 hours", bucket: "15 minutes" },
  "7d": { label: "7d", interval: "7 days", bucket: "1 hour" },
  "30d": { label: "30d", interval: "30 days", bucket: "3 hours" },
  all: { label: "all", interval: "3650 days", bucket: "6 hours" },
};

type Pt = { t: number; tank: number | null; target: number | null; outdoor: number | null };

const fmt = (v: number | null | undefined, d = 0) =>
  v == null || !isFinite(v as number) ? "—" : (v as number).toFixed(d);

// Compact multi-series line chart. Three temps (tank/target/outdoor) share one °F axis.
function HistoryChart({ pts }: { pts: Pt[] }) {
  const W = 960, H = 320, pad = { l: 40, r: 14, t: 14, b: 26 };
  const ts = pts.map((p) => p.t);
  const tmin = Math.min(...ts), tmax = Math.max(...ts);
  const vals = pts.flatMap((p) => [p.tank, p.target, p.outdoor].filter((v): v is number => v != null));
  const vmin = Math.min(...vals, 40), vmax = Math.max(...vals, 160);
  const X = (t: number) => pad.l + (tmax === tmin ? 0 : (t - tmin) / (tmax - tmin)) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - vmin) / (vmax - vmin || 1)) * (H - pad.t - pad.b);
  const path = (sel: (p: Pt) => number | null) => {
    let d = "", pen = false;
    for (const p of pts) {
      const v = sel(p);
      if (v == null) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${X(p.t).toFixed(1)},${Y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const yTicks = [vmin, (vmin + vmax) / 2, vmax];
  const xTicks = [tmin, (tmin + tmax) / 2, tmax];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ height: "auto", aspectRatio: "960/320" }}>
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} stroke="#2c3640" strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
          <text x={4} y={Y(v) + 4} fill="#8b98a5" fontSize={12}>{v.toFixed(0)}</text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <text key={i} x={X(t)} y={H - 8} fill="#8b98a5" fontSize={11.5} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>{fmtDay(t)}</text>
      ))}
      <path d={path((p) => p.outdoor)} fill="none" stroke="#845ef7" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
      <path d={path((p) => p.target)} fill="none" stroke="#ffd666" strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
      <path d={path((p) => p.tank)} fill="none" stroke="#4dabf7" strokeWidth={1.8} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default async function HistoryPage({ searchParams }: { searchParams: { window?: string } }) {
  const win = WINDOWS[searchParams.window ?? "7d"] ? (searchParams.window ?? "7d") : "7d";
  const { interval, bucket } = WINDOWS[win];

  let pts: Pt[] = [];
  let saved: number | null = null;
  let moves: { ts: number; targetF: number | null; reason: string; result: string }[] = [];
  let firstDay: string | null = null;
  let dbError = false;

  try {
    const r = await sql<{ t: number; tank: number | null; target: number | null; outdoor: number | null }>`
      SELECT EXTRACT(EPOCH FROM time_bucket)::float8 AS t, tank, target, outdoor FROM (
        SELECT date_bin(${bucket}::interval, ts, TIMESTAMPTZ '2020-01-01') AS time_bucket,
               avg(tank_f)::float8 AS tank, avg(tank_target_f)::float8 AS target, avg(outdoor_f)::float8 AS outdoor
        FROM slx_readings WHERE ts >= now() - (${interval})::interval
        GROUP BY 1
      ) q ORDER BY time_bucket`;
    pts = r.rows.map((x) => ({ t: x.t, tank: x.tank, target: x.target, outdoor: x.outdoor }));

    const fd = await sql`SELECT to_char(min(ts) AT TIME ZONE 'America/New_York', 'Mon D, YYYY') AS d FROM slx_readings`;
    firstDay = fd.rows[0]?.d ?? null;

    try {
      const s = await sql`SELECT sum(saved_usd)::float8 AS s FROM realized_savings
                          WHERE day >= (now() - (${interval})::interval)::date`;
      saved = s.rows[0]?.s ?? null;
    } catch { /* realized_savings may not exist yet */ }

    try {
      moves = (await sql`
        SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, target_f, reason, result
        FROM autopilot_log WHERE ts >= now() - (${interval})::interval ORDER BY id DESC LIMIT 12`
      ).rows.map((x: any) => ({ ts: x.ts, targetF: x.target_f, reason: x.reason, result: x.result }));
    } catch { /* autopilot_log may not exist yet */ }
  } catch {
    dbError = true;
  }

  return (
    <>
      <I1Banner />
      <StormBanner />

      <div className="controls">
        <div className="seg">
          {Object.entries(WINDOWS).map(([k, w]) => (
            <a key={k} className={win === k ? "active" : ""} href={`/history?window=${k}`}>{w.label}</a>
          ))}
        </div>
        <span className="dim" style={{ alignSelf: "center", fontSize: 12 }}>
          look back over any window · kept indefinitely{firstDay ? ` · since ${firstDay}` : ""}
        </span>
      </div>

      {dbError ? (
        <div className="empty">Database not reachable.</div>
      ) : pts.length === 0 ? (
        <div className="empty">No readings recorded in this window yet.</div>
      ) : (
        <>
          <div className="chart-block">
            <h3>Tank, target &amp; outdoor over time <span className="dim">(last {WINDOWS[win].label}, {WINDOWS[win].bucket} average)</span></h3>
            <HistoryChart pts={pts} />
            <div className="meta" style={{ marginTop: 8 }}>
              <span style={{ color: "#4dabf7" }}>■</span> tank temp ·{" "}
              <span style={{ color: "#ffd666" }}>■</span> target ·{" "}
              <span style={{ color: "#845ef7" }}>■</span> outdoor. The tank riding just above its (dashed) target
              with clean reheats is autopilot working; the target stepping down is it trimming to demand.
            </div>
          </div>

          <div className="cards">
            <div className="card">
              <h2>Saved this window<span className="chip ok">measured</span></h2>
              <div className="temps">
                <div className="temp"><div className="v" style={{ color: "#63e6be" }}>{saved == null ? "—" : `$${saved.toFixed(2)}`}</div><div className="l">vs. the as-found regime</div></div>
              </div>
              <div className="meta">From the measured realized-savings ledger over the same window. Full breakdown on <a href="/savings" style={{ color: "#4dabf7" }}>Savings →</a></div>
            </div>
            <div className="card" style={{ gridColumn: "span 2" }}>
              <h2>Autopilot moves this window<span className="chip">{moves.length}</span></h2>
              {moves.length === 0 ? (
                <div className="meta">No target changes recorded in this window.</div>
              ) : moves.map((m, i) => (
                <div className="meta" key={i} style={{ borderTop: i ? "1px solid var(--line)" : "none", paddingTop: i ? 5 : 0 }}>
                  {fmtDateTime(m.ts)} · <b style={{ color: m.result === "set" || m.result === "held" ? "var(--ok)" : "var(--warm)" }}>{m.result}</b>
                  {m.targetF != null ? ` ${Math.round(m.targetF)}°F` : ""}{m.reason ? ` — ${m.reason}` : ""}
                </div>
              ))}
              <div className="meta" style={{ marginTop: 6 }}>Every change, with its reason, lives on <a href="/activity" style={{ color: "#4dabf7" }}>Activity →</a></div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
