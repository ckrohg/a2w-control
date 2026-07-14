import { ensureSchema, recentReadings, type Reading } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const f = (c: number | null) => (c == null ? null : (c * 9) / 5 + 32);
const fmt = (v: number | null, d = 0) => (v == null ? "—" : v.toFixed(d));

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
  const lab = (d: Date) => hours > 48
    ? d.toLocaleDateString([], { month: "short", day: "numeric" })
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

export default async function Dashboard({ searchParams }: { searchParams: { hours?: string } }) {
  const hours = searchParams.hours === "168" ? 168 : 24;
  let rows: Reading[] = [];
  let dbError = false;
  try {
    await ensureSchema();
    rows = await recentReadings(hours);
  } catch {
    dbError = true;
  }

  const byPump = new Map<string, Reading[]>();
  for (const r of rows) {
    if (!byPump.has(r.pump_id)) byPump.set(r.pump_id, []);
    byPump.get(r.pump_id)!.push(r);
  }

  return (
    <>
      <header>
        <h1>A2W Analytics</h1>
        <span className="dim">read-only cloud mirror</span>
        <a className="btn" href="/hbx" style={{ marginLeft: "auto", textDecoration: "none" }}>HBX</a>
        <a className="btn" href="/control" style={{ textDecoration: "none" }}>Control</a>
        <form action="/api/logout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </header>

      <div className="controls">
        <div className="seg">
          <a className={hours === 24 ? "active" : ""} href="/?hours=24">24h</a>
          <a className={hours === 168 ? "active" : ""} href="/?hours=168">7d</a>
        </div>
      </div>

      {dbError ? (
        <div className="empty">Database not reachable — check the Vercel Postgres integration &amp; env vars.</div>
      ) : byPump.size === 0 ? (
        <div className="empty">No data yet. Once the Pi&apos;s exporter is configured, snapshots appear within a minute.</div>
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
                    <div className="temp"><div className="v">{fmt(f(last.ambient_c))}°</div><div className="l">Outdoor</div></div>
                  </div>
                  <div className="meta">
                    Setpoint {fmt(f(last.setpoint_c))}°F · {fmt(last.power_w, 0)} W ·
                    {" "}last {new Date(last.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                </div>
              );
            })}
          </div>

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
