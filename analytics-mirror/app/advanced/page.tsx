// @purpose Advanced HP view (kanban card) — every register, parameter, and status bit,
// rendered from the latest full snapshot each pump pushes every ~5 min (pump_snapshots).
// Read-only. Until the Pi ships the exporter change (release-* tag), this page shows an
// explanatory empty state — the Pi UI over LAN/Funnel remains the break-glass full view.
import { sql } from "@vercel/postgres";
import { I1Banner } from "../i1-banner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const f = (c: number | null | undefined) => (c == null ? null : (c * 9) / 5 + 32);
const fmt = (v: number | null | undefined, d = 1, suffix = "") =>
  v == null || !isFinite(v as number) ? "—" : `${(v as number).toFixed(d)}${suffix}`;

type SnapRow = { pump_id: string; ts: number; name: string | null; snapshot: Record<string, any> };

function Flags({ obj }: { obj: Record<string, unknown> | undefined }) {
  if (!obj) return <span className="dim">—</span>;
  const entries = Object.entries(obj).filter(([, v]) => typeof v === "boolean");
  return (
    <div className="chips-row" style={{ marginBottom: 0 }}>
      {entries.map(([k, v]) => (
        <span key={k} className={`chip ${v ? "heating" : ""}`}>{k.replace(/_/g, " ")}</span>
      ))}
    </div>
  );
}

function KV({ data, degC }: { data: Record<string, unknown> | undefined; degC?: string[] }) {
  if (!data) return <span className="dim">—</span>;
  return (
    <div className="meta" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "3px 14px" }}>
      {Object.entries(data).map(([k, v]) => {
        if (v == null || typeof v === "object") return null;
        const isC = degC?.includes(k) || k.endsWith("_c");
        const shown = isC && typeof v === "number" ? `${fmt(f(v))}°F` : String(v);
        return <span key={k}><span className="dim">{k.replace(/_/g, " ")}:</span> {shown}</span>;
      })}
    </div>
  );
}

export default async function AdvancedPage() {
  let snaps: SnapRow[] = [];
  let dbError = false;
  try {
    snaps = (await sql<SnapRow>`
      SELECT pump_id, ts, name, snapshot FROM pump_snapshots ORDER BY pump_id`).rows;
  } catch {
    dbError = true; // table appears with the first ingest after the bridge ships
  }
  const now = Date.now() / 1000;

  return (
    <>
      <header>
        <h1>Advanced</h1>
        <span className="dim">every register, param &amp; status bit · 5-min full snapshots</span>
        <a className="btn" href="/" style={{ marginLeft: "auto", textDecoration: "none" }}>Home</a>
        <form action="/api/logout" method="post"><button type="submit">Sign out</button></form>
      </header>

      <I1Banner />

      {dbError || snaps.length === 0 ? (
        <div className="empty">
          No full snapshots yet. This feed ships with the next Pi release tag (exporter
          change is on main). Until then the Pi&apos;s own dashboard has the complete
          advanced view over LAN/Tailscale.
        </div>
      ) : (
        snaps.map(({ pump_id, ts, name, snapshot: s }) => {
          const stale = now - ts > 15 * 60;
          const params: { key: string; label: string; value: number; min: number; max: number }[] = s.parameters ?? [];
          const details: Record<string, Record<string, unknown>> = s.details ?? {};
          return (
            <div key={pump_id}>
              <div className="chart-block">
                <h3>
                  {name ?? pump_id} — overview
                  <span className={`chip ${stale ? "offline" : s.online ? "heating" : "off"}`} style={{ marginLeft: 8 }}>
                    {stale ? "stale" : s.state ?? "?"}
                  </span>
                  <span className="dim" style={{ marginLeft: 8 }}>
                    as of {new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </h3>
                <div className="meta">
                  mode {s.mode_name ?? s.mode_kind} · setpoints: heat {fmt(f(s.setpoint_heating_c), 0)}°F /
                  cool {fmt(f(s.setpoint_cooling_c), 0)}°F / DHW {fmt(f(s.setpoint_hot_water_c), 0)}°F ·
                  max water (reg 2027) {fmt(f(s.max_water_temp_c), 0)}°F ·
                  inlet {fmt(f(s.inlet_c))}°F / outlet {fmt(f(s.outlet_c))}°F / ambient {fmt(f(s.ambient_c))}°F ·
                  power S1 {fmt(s.power_sys1, 0)} + S2 {fmt(s.power_sys2, 0)} ·
                  freq {fmt(s.freq_sys1_hz, 0)}/{fmt(s.freq_sys2_hz, 0)} Hz ·
                  {s.defrosting ? " DEFROSTING · " : " "}fan {s.fan_speed ?? "—"} ·
                  emergency {s.emergency_override ?? "—"}
                </div>
              </div>

              <div className="chart-block">
                <h3>{name ?? pump_id} — status &amp; switches</h3>
                <Flags obj={s.status} />
                <div style={{ height: 6 }} />
                <Flags obj={s.switches} />
              </div>

              <div className="chart-block">
                <h3>{name ?? pump_id} — unit parameters (regs 2010–2039)</h3>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", fontSize: 12.5, borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ color: "var(--dim)", textAlign: "left" }}>
                        <th style={{ padding: "3px 8px" }}>parameter</th>
                        <th style={{ padding: "3px 8px" }}>value</th>
                        <th style={{ padding: "3px 8px" }}>range</th>
                      </tr>
                    </thead>
                    <tbody>
                      {params.map((p) => (
                        <tr key={p.key} style={{ borderTop: "1px solid var(--line)" }}>
                          <td style={{ padding: "3px 8px" }}>{p.label ?? p.key}</td>
                          <td style={{ padding: "3px 8px", fontVariantNumeric: "tabular-nums" }}>{p.value}</td>
                          <td style={{ padding: "3px 8px", color: "var(--dim)" }}>{p.min}–{p.max}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {Object.entries(details).map(([stage, d]) => (
                <div className="chart-block" key={stage}>
                  <h3>{name ?? pump_id} — {stage.replace(/_/g, " ")}</h3>
                  <KV data={d} />
                </div>
              ))}

              <div className="chart-block">
                <h3>{name ?? pump_id} — comms</h3>
                <KV data={s.comm} />
              </div>
            </div>
          );
        })
      )}
    </>
  );
}
