// @purpose Advanced HP view (kanban card) — every register, parameter, and status bit,
// rendered from the latest full snapshot each pump pushes every ~5 min (pump_snapshots).
// Read-only. Until the Pi ships the exporter change (release-* tag), this page shows an
// explanatory empty state — the Pi UI over LAN/Funnel remains the break-glass full view.
import { sql } from "@vercel/postgres";
import { fmtTime, fmtDateTime } from "@/lib/tz";
import { recentEvents, latestSystemStat, recentSystemStats,
  type Event, type EventFilter, type SystemStat } from "@/lib/db";
import { Chart, type Series } from "../ui/chart";
import { I1Banner } from "../i1-banner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const EVENT_TABS: { key: EventFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "faults", label: "Faults" },
  { key: "writes", label: "Writes" },
  { key: "runtime", label: "Runtime" },
];

// Colored chip mirroring the Pi UI: fault/critical → red, write → warn, state → blue.
function eventChip(e: Event): string {
  const sev = (e.severity ?? "").toLowerCase();
  if (e.type === "fault_on" || e.type === "fault_off" || sev === "critical") return "offline";
  if (e.type && e.type.endsWith("_write")) return "warn";
  if (e.type === "state") return "cooling";
  return "";
}

async function EventLog({ filter, pumpNames }: { filter: EventFilter; pumpNames: Map<string, string> }) {
  let events: Event[] = [];
  let dbError = false;
  try {
    events = await recentEvents({ filter, limit: 100 });
  } catch {
    dbError = true; // pump_events table appears with the first events push from the Pi
  }
  return (
    <div className="chart-block">
      <h3>Event log</h3>
      <div className="seg" style={{ marginBottom: 12 }}>
        {EVENT_TABS.map((t) => (
          <a key={t.key} className={filter === t.key ? "active" : ""} href={`/advanced?events=${t.key}`}>
            {t.label}
          </a>
        ))}
      </div>
      {dbError || events.length === 0 ? (
        <div className="empty">
          Event history appears here once the Pi ships the events feed (next Pi update) —
          faults, setpoint changes, defrosts, and comm drops will land here.
        </div>
      ) : (
        <div className="meta" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {events.map((e) => (
            <div key={e.id} style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span className="dim">{fmtDateTime(e.ts)}</span>
              <span className="dim">·</span>
              <span>{pumpNames.get(e.pump_id) ?? e.pump_id}</span>
              <span className={`chip ${eventChip(e)}`}>{e.severity ?? e.type ?? "event"}</span>
              <span>{e.message ?? e.type ?? ""}{e.code ? ` (${e.code})` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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

// --- Pi health card (bridge/sysstat.py → mirror) ---------------------------------------
// Thresholds tuned for a Raspberry Pi 5: SoC throttles ~80–85°C; free disk on the SD/NVMe is
// the one thing that grows; load compared to core count. Green = healthy, amber = watch,
// red = act. A null metric (Linux-only field off the Pi, or pre-first-delta CPU%) shows grey.
type Level = "ok" | "warn" | "bad" | "na";

// higher value = worse (temp, cpu, mem, load); pass invert for "lower = worse" (free disk).
function level(v: number | null | undefined, warn: number, bad: number, invert = false): Level {
  if (v == null || !isFinite(v)) return "na";
  const isBad = invert ? v <= bad : v >= bad;
  const isWarn = invert ? v <= warn : v >= warn;
  return isBad ? "bad" : isWarn ? "warn" : "ok";
}
const chipClass = (l: Level) => (l === "bad" ? "offline" : l === "warn" ? "warn" : l === "ok" ? "heating" : "off");

function Metric({ label, text, lvl }: { label: string; text: string; lvl: Level }) {
  return (
    <span>
      <span className="dim">{label}: </span>
      <span className={`chip ${chipClass(lvl)}`}>{text}</span>
    </span>
  );
}

function fmtUptime(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "—";
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
}

async function PiHealth() {
  let latest: SystemStat | null = null;
  let history: SystemStat[] = [];
  let dbError = false;
  try {
    latest = await latestSystemStat();
    history = await recentSystemStats(24);
  } catch {
    dbError = true; // system_stats table appears with the first health push from the Pi
  }
  if (dbError || !latest) {
    return (
      <div className="chart-block">
        <h3>Pi health</h3>
        <div className="empty">
          Pi CPU, memory, temperature, and free disk appear here once the Pi ships the health
          feed (next Pi update). Recorded every ~60s and kept 90 days.
        </div>
      </div>
    );
  }
  const diskFreePct = latest.disk_used_pct == null ? null : 100 - latest.disk_used_pct;
  const ncpu = latest.ncpu ?? 4;
  const tempSeries: Series[] = [
    { color: "#e0555c", label: "CPU °C", points: history.map((r) => ({ x: r.ts, y: r.cpu_temp_c })) },
  ];
  return (
    <div className="chart-block">
      <h3>
        Pi health
        <span className="dim" style={{ marginLeft: 8 }}>as of {fmtTime(latest.ts)}</span>
      </h3>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "8px 0 12px" }}>
        <Metric label="CPU" text={fmt(latest.cpu_pct, 0, "%")} lvl={level(latest.cpu_pct, 70, 90)} />
        <Metric
          label="load"
          text={`${fmt(latest.load1, 2)} / ${fmt(latest.load5, 2)} / ${fmt(latest.load15, 2)}`}
          lvl={level(latest.load1, ncpu, ncpu * 2)}
        />
        <Metric label="RAM" text={fmt(latest.mem_used_pct, 0, "%")} lvl={level(latest.mem_used_pct, 85, 95)} />
        <Metric label="CPU temp" text={fmt(latest.cpu_temp_c, 0, "°C")} lvl={level(latest.cpu_temp_c, 70, 80)} />
        <Metric
          label="disk free"
          text={`${fmt(diskFreePct, 0, "%")} (${fmt(latest.disk_free_gb, 0)} GB)`}
          lvl={level(diskFreePct, 15, 8, true)}
        />
        <span><span className="dim">uptime: </span>{fmtUptime(latest.uptime_s)}</span>
      </div>
      <div className="meta dim" style={{ marginBottom: 4 }}>CPU temperature — last 24h (°C)</div>
      <Chart series={tempSeries} hours={24} height={140} />
    </div>
  );
}

export default async function AdvancedPage({ searchParams }: { searchParams: { events?: string } }) {
  let snaps: SnapRow[] = [];
  let dbError = false;
  try {
    snaps = (await sql<SnapRow>`
      SELECT pump_id, ts, name, snapshot FROM pump_snapshots ORDER BY pump_id`).rows;
  } catch {
    dbError = true; // table appears with the first ingest after the bridge ships
  }
  const now = Date.now() / 1000;

  const eventFilter: EventFilter =
    EVENT_TABS.some((t) => t.key === searchParams.events)
      ? (searchParams.events as EventFilter)
      : "all";
  const pumpNames = new Map(snaps.map((s) => [s.pump_id, s.name ?? s.pump_id]));

  return (
    <>
      <I1Banner />

      <PiHealth />

      <EventLog filter={eventFilter} pumpNames={pumpNames} />

      {dbError || snaps.length === 0 ? (
        <div className="empty">
          Full register detail appears here once a pump pushes its next 5-minute snapshot.
          Until then, the Pi&apos;s own dashboard (over the local network) has the complete view.
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
                    as of {fmtTime(ts)}
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
