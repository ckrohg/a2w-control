// @purpose Home dashboard — one place for the whole plant: pump cards + buffer-tank card
// + current shadow-plan card, an alert-chip row (reader/pump offline, backup called, HBX
// drift), the I1 banner, and the per-pump history charts. Mobile-first (kanban card).
// Deep views: /hbx (tank, curve, plan detail), /control (setpoint writes).
import { sql } from "@vercel/postgres";
import { ensureSchema, recentReadings, type Reading } from "@/lib/db";
import { fmtTime, fmtDay, fmtDateTime } from "@/lib/tz";
import { I1Banner } from "./i1-banner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// force-no-store matters as much as force-dynamic: @vercel/postgres runs over HTTP fetch,
// and parameterless queries (identical request bodies) otherwise hit Vercel's Data Cache —
// the tank card once fossilized on a 10-hour-old row this way while parameterized queries
// (changing ${since}) stayed fresh.
export const fetchCache = "force-no-store";

const f = (c: number | null) => (c == null ? null : (c * 9) / 5 + 32);
const fmt = (v: number | null | undefined, d = 0) => (v == null ? "—" : v.toFixed(d));

type Pt = { x: number; y: number | null };
type Series = { color: string; points: Pt[]; dash?: boolean };

function Chart({ series, hours }: { series: Series[]; hours: number }) {
  const W = 900, H = 200, pad = { l: 38, r: 10, t: 10, b: 20 };
  const all = series.flatMap((s) => s.points.filter((p) => p.y != null && isFinite(p.y as number))) as { x: number; y: number }[];
  if (!all.length) return <div className="empty" style={{ padding: 20 }}>No data yet</div>;
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 4) { const m = (y0 + y1) / 2; y0 = m - 2; y1 = m + 2; }
  const X = (x: number) => pad.l + ((x - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const grid = [y0, (y0 + y1) / 2, y1];
  const t0 = new Date(x0 * 1000), t1 = new Date(x1 * 1000);
  const lab = (d: Date) => (hours > 48 ? fmtDay(d) : fmtTime(d));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {grid.map((g, i) => (
        <g key={i}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(g)} y2={Y(g)} stroke="#2c3640" strokeWidth={1} />
          <text x={4} y={Y(g) + 4} fill="#8b98a5" fontSize={11}>{Math.round(g)}</text>
        </g>
      ))}
      {series.map((s, i) => {
        const pts = s.points.filter((p) => p.y != null && isFinite(p.y as number)) as { x: number; y: number }[];
        if (!pts.length) return null;
        const d = pts.map((p, j) => `${j ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("");
        return <path key={i} d={d} fill="none" stroke={s.color} strokeWidth={1.8} strokeLinejoin="round" strokeDasharray={s.dash ? "5 4" : undefined} />;
      })}
      <text x={pad.l} y={H - 4} fill="#8b98a5" fontSize={11}>{lab(t0)}</text>
      <text x={W - pad.r} y={H - 4} fill="#8b98a5" fontSize={11} textAnchor="end">{lab(t1)}</text>
    </svg>
  );
}

type SlxLatest = {
  ts: number; tank_f: number | null; tank_target_f: number | null; outdoor_f: number | null;
  hd_active: boolean | null; stages_called: boolean[] | null; backup_called: boolean | null;
  connected: boolean | null;
};
type ShadowBlock = { ts: string; tank_target_f: number; hp1_setpoint_f: number; reason: string };

export default async function Dashboard({ searchParams }: { searchParams: { hours?: string } }) {
  const hours = searchParams.hours === "168" ? 168 : 24;
  let rows: Reading[] = [];
  let slx: SlxLatest | null = null;
  let shadow: ShadowBlock[] | null = null;
  let driftAt: number | null = null;
  let faults: { pump: string; code: string; message: string; severity: string; since?: number }[] = [];
  let dbError = false;
  try {
    await ensureSchema();
    rows = await recentReadings(hours);
    try {
      const s = await sql<SlxLatest>`
        SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, tank_f, tank_target_f, outdoor_f,
               hd_active, stages_called, backup_called, connected
        FROM slx_readings ORDER BY ts DESC LIMIT 1`;
      slx = s.rowCount ? s.rows[0] : null;
      const sp = await sql`SELECT plan FROM shadow_plans ORDER BY id DESC LIMIT 1`;
      shadow = sp.rowCount ? (sp.rows[0].plan as ShadowBlock[]) : null;
      const d = await sql`
        SELECT EXTRACT(EPOCH FROM observed_at)::float8 AS t FROM hbx_config_versions
        WHERE changed_fields IS NOT NULL AND changed_fields->>'_source' IS NULL
          AND observed_at >= now() - interval '48 hours'
        ORDER BY id DESC LIMIT 1`;
      driftAt = d.rowCount ? (d.rows[0].t as number) : null;
      const fs = await sql`
        SELECT pump_id, name, ts, snapshot->'active_faults' AS faults FROM pump_snapshots
        WHERE jsonb_array_length(snapshot->'active_faults') > 0`;
      faults = fs.rows.flatMap((r: any) =>
        (r.faults as { code: string; message: string; severity: string; since?: number }[])
          .map((f) => ({ pump: (r.name as string) ?? r.pump_id, ...f })));
    } catch { /* planner tables may not exist yet */ }
  } catch {
    dbError = true;
  }

  const byPump = new Map<string, Reading[]>();
  for (const r of rows) {
    if (!byPump.has(r.pump_id)) byPump.set(r.pump_id, []);
    byPump.get(r.pump_id)!.push(r);
  }

  const now = Date.now() / 1000;
  const slxStale = !slx || now - slx.ts > 15 * 60;
  const chips: { cls: string; text: string }[] = [];
  for (const [id, rs] of byPump) {
    const last = rs[rs.length - 1];
    if (!last.online || now - last.ts > 15 * 60) chips.push({ cls: "offline", text: `${last.name ?? id} offline` });
  }
  if (slxStale) chips.push({ cls: "offline", text: "HBX reader stale" });
  if (slx?.backup_called) chips.push({ cls: "offline", text: "16.5 kW backup CALLED" });
  if (driftAt) chips.push({ cls: "warn", text: `HBX config changed ${fmtDateTime(driftAt)}` });
  if (faults.length) chips.push({ cls: "offline", text: `${faults.length} active pump fault${faults.length > 1 ? "s" : ""}` });
  if (!chips.length) chips.push({ cls: "ok", text: "all systems normal" });

  // current + next interesting shadow block
  const nowBlock = shadow?.find((b) => {
    const t = new Date(b.ts).getTime();
    return t <= Date.now() && Date.now() < t + 3600_000;
  });
  const nextAction = shadow?.find((b) => new Date(b.ts).getTime() > Date.now() && !b.reason.startsWith("idle"));

  const stagesTxt = slx?.stages_called?.map((s, i) => (s ? `S${i + 1}` : null)).filter(Boolean).join(" ") || "none";

  return (
    <>
      <header>
        <h1>A2W Control</h1>
        <span className="dim">home</span>
        <a className="btn" href="/hbx" style={{ marginLeft: "auto", textDecoration: "none" }}>HBX</a>
        <a className="btn" href="/curve" style={{ textDecoration: "none" }}>Curve</a>
        <a className="btn" href="/savings" style={{ textDecoration: "none" }}>Savings</a>
        <a className="btn" href="/advanced" style={{ textDecoration: "none" }}>Advanced</a>
        <a className="btn" href="/control" style={{ textDecoration: "none" }}>Control</a>
        <form action="/api/logout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </header>

      <I1Banner />

      <div className="chips-row">
        {chips.map((c, i) => <span key={i} className={`chip ${c.cls}`}>{c.text}</span>)}
      </div>

      {faults.length > 0 && (
        <div className="cards">
          {faults.map((f, i) => (
            <div className="card" key={i} style={{ borderColor: f.severity === "critical" ? "var(--crit)" : "#6b5330" }}>
              <h2>
                {f.pump}: {f.code}
                <span className={`chip ${f.severity === "critical" || f.severity === "high" ? "offline" : "warn"}`}>{f.severity}</span>
              </h2>
              <div className="meta" style={{ color: "var(--text)" }}>{f.message}</div>
              {f.since ? <div className="meta">active since {fmtDateTime(f.since)}</div> : null}
            </div>
          ))}
        </div>
      )}

      {dbError ? (
        <div className="empty">Database not reachable — check the Vercel Postgres integration &amp; env vars.</div>
      ) : (
        <>
          <div className="cards">
            {[...byPump.entries()].map(([id, rs]) => {
              const last = rs[rs.length - 1];
              const state = last.online ? (last.state ?? "idle") : "offline";
              return (
                <div className="card" key={id}>
                  <h2>{last.name ?? id}<span className={`chip ${state}`}>{state}</span></h2>
                  <div className="temps">
                    <div className="temp"><div className="v">{fmt(f(last.outlet_c))}°</div><div className="l">Outlet</div></div>
                    <div className="temp"><div className="v">{fmt(f(last.inlet_c))}°</div><div className="l">Inlet</div></div>
                    <div className="temp"><div className="v">{fmt(f(last.setpoint_c))}°</div><div className="l">Setpoint</div></div>
                  </div>
                  <div className="meta">
                    {fmt(last.power_w, 0)} W · {last.active_faults ? `${last.active_faults} fault(s) · ` : ""}
                    last {fmtTime(last.ts)}
                  </div>
                </div>
              );
            })}

            <div className="card">
              <h2>Buffer tank
                <span className={`chip ${slxStale ? "offline" : slx?.hd_active ? "heating" : "cooling"}`}>
                  {slxStale ? "stale" : slx?.hd_active ? "heat demand" : "idle"}
                </span>
              </h2>
              <div className="temps">
                <div className="temp"><div className="v">{fmt(slx?.tank_f, 1)}°</div><div className="l">Tank</div></div>
                <div className="temp"><div className="v">{fmt(slx?.tank_target_f, 1)}°</div><div className="l">Target</div></div>
                <div className="temp"><div className="v">{fmt(slx?.outdoor_f, 1)}°</div><div className="l">Outdoor</div></div>
              </div>
              <div className="meta">
                Stages: {stagesTxt} · Backup: {slx?.backup_called ? "CALLED" : "off"} · <a href="/hbx" style={{ color: "#4dabf7" }}>details →</a>
              </div>
            </div>

            <div className="card">
              <h2>Planner (practice mode)<span className="chip">not in control</span></h2>
              {nowBlock ? (
                <>
                  <div className="temps">
                    <div className="temp"><div className="v">{fmt(slx?.tank_target_f, 0)}°</div><div className="l">Running now</div></div>
                    <div className="temp"><div className="v">{nowBlock.tank_target_f}°</div><div className="l">Plan says enough</div></div>
                  </div>
                  <div className="meta">
                    The planner is rehearsing, not steering: right now it would run the tank at
                    {" "}{nowBlock.tank_target_f}°F ({nowBlock.reason}).
                  </div>
                  {nextAction && (
                    <div className="meta">
                      Next move it would make: {fmtTime(new Date(nextAction.ts))} → {nextAction.tank_target_f}°F ({nextAction.reason}).
                      {" "}<a href="/savings" style={{ color: "#4dabf7" }}>what that&apos;s worth →</a>
                    </div>
                  )}
                </>
              ) : (
                <div className="meta">No practice plan yet — the planner computes one hourly.</div>
              )}
            </div>
          </div>

          {byPump.size > 0 && (
            <div className="controls">
              <div className="seg">
                <a className={hours === 24 ? "active" : ""} href="/?hours=24">24h</a>
                <a className={hours === 168 ? "active" : ""} href="/?hours=168">7d</a>
              </div>
            </div>
          )}

          {[...byPump.entries()].map(([id, rs]) => {
            const name = rs[rs.length - 1].name ?? id;
            const pick = (k: keyof Reading, conv = false) =>
              rs.map((r) => ({ x: r.ts, y: conv ? f(r[k] as number | null) : (r[k] as number | null) }));
            return (
              <div key={id}>
                <div className="chart-block">
                  <h3>{name} — Temperatures °F</h3>
                  <div className="chart">
                    <Chart hours={hours} series={[
                      { color: "#4dabf7", points: pick("outlet_c", true) },
                      { color: "#63e6be", points: pick("inlet_c", true) },
                      { color: "#845ef7", points: pick("ambient_c", true) },
                      { color: "#ffd666", points: pick("setpoint_c", true), dash: true },
                    ]} />
                  </div>
                  <div className="legend">
                    <span><i style={{ background: "#4dabf7" }} />Outlet</span>
                    <span><i style={{ background: "#63e6be" }} />Inlet</span>
                    <span><i style={{ background: "#845ef7" }} />Outdoor</span>
                    <span><i style={{ background: "#ffd666" }} />Setpoint</span>
                  </div>
                </div>
                <div className="chart-block">
                  <h3>{name} — Power W</h3>
                  <div className="chart">
                    <Chart hours={hours} series={[{ color: "#ff9f43", points: pick("power_w") }]} />
                  </div>
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
