// @purpose HBX / buffer-tank view — the §6.6 owner interface, first cut. Reads the
// planner's Neon tables (slx_readings, hbx_config_versions) plus the Pi-pushed pump
// readings (same DB) to render: live tank state, the I1 overlay chart (tank vs target vs
// target+margin vs HP setpoints vs outdoor — crossing lines = the deadlock), the reset
// curve card (configured line vs observed scatter), and the config-drift version history.
import { sql } from "@vercel/postgres";
import { fmtTime, fmtDay, fmtDateTime } from "@/lib/tz";
import { I1Banner } from "../i1-banner";
import { StormBanner } from "../storm-banner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store"; // parameterless sql = cacheable fetch bodies (see home page note)

const I1_MARGIN_F = 5; // A-4-measured 2026-07-14 (HBX terminated at +3.1°F); revisit as charges accumulate

const f = (c: number | null) => (c == null ? null : (c * 9) / 5 + 32);
const fmt = (v: number | null | undefined, d = 1) => (v == null ? "—" : v.toFixed(d));

type Pt = { x: number; y: number | null };
type Series = { color: string; points: Pt[]; dash?: boolean; width?: number };

function LineChart({ series, hours }: { series: Series[]; hours: number }) {
  const W = 900, H = 220, pad = { l: 38, r: 10, t: 10, b: 20 };
  const all = series.flatMap((s) => s.points.filter((p) => p.y != null && isFinite(p.y as number))) as { x: number; y: number }[];
  if (!all.length) return <div className="empty" style={{ padding: 20 }}>No data yet</div>;
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (y1 - y0 < 4) { const m = (y0 + y1) / 2; y0 = m - 2; y1 = m + 2; }
  const X = (x: number) => pad.l + ((x - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const grid = [y0, (y0 + y1) / 2, y1];
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
        return <path key={i} d={d} fill="none" stroke={s.color} strokeWidth={s.width ?? 1.8} strokeLinejoin="round" strokeDasharray={s.dash ? "5 4" : undefined} />;
      })}
      <text x={pad.l} y={H - 4} fill="#8b98a5" fontSize={11}>{lab(new Date(x0 * 1000))}</text>
      <text x={W - pad.r} y={H - 4} fill="#8b98a5" fontSize={11} textAnchor="end">{lab(new Date(x1 * 1000))}</text>
    </svg>
  );
}

/** Reset-curve card: configured line (from the latest config version) + observed (outdoor, target) scatter. */
function CurveChart({ cfg, pts }: { cfg: Record<string, number> | null; pts: { x: number; y: number }[] }) {
  const W = 900, H = 260, pad = { l: 38, r: 12, t: 12, b: 26 };
  const xsAll = pts.map((p) => p.x).concat(cfg ? [cfg.dot, cfg.wwsd] : []);
  const ysAll = pts.map((p) => p.y).concat(cfg ? [cfg.dbt, cfg.mbt] : []);
  if (!xsAll.length) return <div className="empty" style={{ padding: 20 }}>No data yet</div>;
  const x0 = Math.min(...xsAll) - 4, x1 = Math.max(...xsAll) + 4;
  const y0 = Math.min(...ysAll) - 3, y1 = Math.max(...ysAll) + 3;
  const X = (x: number) => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y: number) => pad.t + (1 - (y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const xticks = [x0 + 4, (x0 + x1) / 2, x1 - 4].map(Math.round);
  const yticks = [y0 + 3, (y0 + y1) / 2, y1 - 3].map(Math.round);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {yticks.map((g, i) => (
        <g key={`y${i}`}>
          <line x1={pad.l} x2={W - pad.r} y1={Y(g)} y2={Y(g)} stroke="#2c3640" strokeWidth={1} />
          <text x={4} y={Y(g) + 4} fill="#8b98a5" fontSize={11}>{g}</text>
        </g>
      ))}
      {xticks.map((g, i) => (
        <text key={`x${i}`} x={X(g)} y={H - 6} fill="#8b98a5" fontSize={11} textAnchor="middle">{g}°F out</text>
      ))}
      {pts.map((p, i) => (
        <circle key={i} cx={X(p.x)} cy={Y(p.y)} r={2.2} fill="#4dabf7" fillOpacity={0.55} />
      ))}
      {cfg && (
        <line x1={X(cfg.dot)} y1={Y(cfg.dbt)} x2={X(cfg.wwsd)} y2={Y(cfg.mbt)}
          stroke="#ffd666" strokeWidth={2.2} strokeDasharray="6 4" />
      )}
    </svg>
  );
}

type SlxRow = {
  ts: number; tank_f: number | null; tank_target_f: number | null; outdoor_f: number | null;
  hd_active: boolean | null; stages_called: boolean[] | null; backup_called: boolean | null;
  connected: boolean | null;
};
type PumpRow = { ts: number; pump_id: string; setpoint_c: number | null };
type VersionRow = { id: number; t: number; changed_fields: Record<string, { old: unknown; new: unknown }> | null };
type ShadowBlock = { ts: string; outdoor_f: number; tank_target_f: number; hp1_setpoint_f: number; reason: string };
type ShadowMeta = { dhw_windows?: [number, number][]; windows_learned?: boolean; learn_days?: number; draw_events?: number };

export default async function HbxPage({ searchParams }: { searchParams: { hours?: string } }) {
  const hours = searchParams.hours === "168" ? 168 : 24;
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const sinceEpoch = Date.now() / 1000 - hours * 3600;

  let slx: SlxRow[] = [];
  let pumps: PumpRow[] = [];
  let cfg: Record<string, any> | null = null;
  let versions: VersionRow[] = [];
  let shadow: ShadowBlock[] | null = null;
  let shadowAt: number | null = null;
  let shadowMeta: ShadowMeta | null = null;
  let gap: { avg: number; n: number } | null = null;
  let scored: { t: number; s: number }[] = [];
  let phasebLog: { t: number; pump_id: string; mode: string; value_c: number | null; result: string }[] = [];
  let stormEvents: { id: number; s: number; e: number | null; trigger: string; ceiling_f: number | null }[] = [];
  let floorSnap: {
    t: number;
    zones: { name: string; deliveryType: string; awtF: number | null; calling: boolean }[];
    bindingZone: string | null; bindingAwtF: number | null; floorF: number | null; source: string | null;
  } | null = null;
  let dbError = false;
  try {
    slx = (await sql<SlxRow>`
      SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, tank_f, tank_target_f, outdoor_f,
             hd_active, stages_called, backup_called, connected
      FROM slx_readings WHERE ts >= ${since}::timestamptz ORDER BY ts ASC`).rows;
    pumps = (await sql<PumpRow>`
      SELECT ts, pump_id, setpoint_c FROM readings
      WHERE ts >= ${sinceEpoch} ORDER BY ts ASC`).rows;
    const c = await sql`SELECT config FROM hbx_config_versions ORDER BY id DESC LIMIT 1`;
    cfg = c.rowCount ? (c.rows[0].config as Record<string, any>) : null;
    versions = (await sql<VersionRow>`
      SELECT id, EXTRACT(EPOCH FROM observed_at)::float8 AS t, changed_fields
      FROM hbx_config_versions ORDER BY id DESC LIMIT 12`).rows;
    try {
      scored = (await sql`
        SELECT EXTRACT(EPOCH FROM hour_ts)::float8 AS t, shadow_target_f::float8 AS s
        FROM plan_scores WHERE hour_ts >= ${since}::timestamptz ORDER BY hour_ts ASC`).rows as { t: number; s: number }[];
      const sp = await sql`SELECT plan, meta, EXTRACT(EPOCH FROM computed_at)::float8 AS t FROM shadow_plans ORDER BY id DESC LIMIT 1`;
      if (sp.rowCount) {
        shadow = sp.rows[0].plan as ShadowBlock[];
        shadowAt = sp.rows[0].t as number;
        shadowMeta = (sp.rows[0].meta ?? null) as ShadowMeta | null;
      }
      try {
        phasebLog = (await sql`
          SELECT EXTRACT(EPOCH FROM ts)::float8 AS t, pump_id, mode, value_c::float8 AS value_c, result
          FROM phase_b_log ORDER BY id DESC LIMIT 10`).rows as any[];
      } catch { /* table appears with the planner deploy that logs decisions */ }
      const g = await sql`SELECT avg(gap_f)::float8 AS avg_gap, count(gap_f)::int AS n
                          FROM plan_scores WHERE hour_ts >= now() - interval '24 hours'`;
      if (g.rowCount && g.rows[0].n > 0) gap = { avg: g.rows[0].avg_gap as number, n: g.rows[0].n as number };
    } catch { /* tables appear with the first planner deploy that computes a plan */ }
    try {
      stormEvents = (await sql`
        SELECT id, EXTRACT(EPOCH FROM started_at)::float8 AS s, EXTRACT(EPOCH FROM ended_at)::float8 AS e, trigger, ceiling_f
        FROM storm_events ORDER BY id DESC LIMIT 5`).rows as typeof stormEvents;
    } catch { /* storm_events appears with the W0-5 planner deploy */ }
    try {
      const zf = await sql`
        SELECT EXTRACT(EPOCH FROM ts)::float8 AS t, zones, binding_zone, binding_awt_f::float8 AS awt, tank_target_f::float8 AS floor, source
        FROM zone_floor_snapshots ORDER BY ts DESC LIMIT 1`;
      if (zf.rowCount) {
        floorSnap = {
          t: zf.rows[0].t as number,
          zones: (zf.rows[0].zones ?? []) as { name: string; deliveryType: string; awtF: number | null; calling: boolean }[],
          bindingZone: (zf.rows[0].binding_zone as string | null) || null,
          bindingAwtF: zf.rows[0].awt as number | null,
          floorF: zf.rows[0].floor as number | null,
          source: zf.rows[0].source as string | null,
        };
      }
    } catch { /* zone_floor_snapshots appears once WINTER_SOLVER_SHADOW runs */ }
  } catch {
    dbError = true;
  }

  const last = slx[slx.length - 1];
  const stale = last ? Date.now() / 1000 - last.ts > 900 : true;
  const pick = (k: keyof SlxRow) => slx.map((r) => ({ x: r.ts, y: r[k] as number | null }));
  const i1Line = slx.map((r) => ({ x: r.ts, y: r.tank_target_f == null ? null : r.tank_target_f + I1_MARGIN_F }));
  const pumpSeries = ["pump1", "pump2"].map((id) => ({
    id,
    points: pumps.filter((p) => p.pump_id === id).map((p) => ({ x: p.ts, y: f(p.setpoint_c) })),
  })).filter((s) => s.points.length);

  // scatter, decimated to keep the SVG light
  const scatterAll = slx.filter((r) => r.outdoor_f != null && r.tank_target_f != null)
    .map((r) => ({ x: r.outdoor_f as number, y: r.tank_target_f as number }));
  const step = Math.max(1, Math.floor(scatterAll.length / 500));
  const scatter = scatterAll.filter((_, i) => i % step === 0);
  const curveCfg = cfg && [cfg.dot, cfg.wwsd, cfg.dbt, cfg.mbt].every((v) => typeof v === "number")
    ? { dot: cfg.dot, wwsd: cfg.wwsd, dbt: cfg.dbt, mbt: cfg.mbt } : null;

  const stagesTxt = last?.stages_called?.map((s, i) => (s ? `S${i + 1}` : null)).filter(Boolean).join(" ") || "none";

  return (
    <>
      <header>
        <h1>HBX — Buffer Tank</h1>
        <span className="dim">ECO-0600 via SensorLinx · 5-min polls</span>
        <a className="btn" href="/" style={{ marginLeft: "auto", textDecoration: "none" }}>Pumps</a>
        <a className="btn" href="/curve" style={{ textDecoration: "none" }}>Curve</a>
        <a className="btn" href="/control" style={{ textDecoration: "none" }}>Control</a>
        <form action="/api/logout" method="post"><button type="submit">Sign out</button></form>
      </header>

      <I1Banner />
      <StormBanner />

      <div className="controls">
        <div className="seg">
          <a className={hours === 24 ? "active" : ""} href="/hbx?hours=24">24h</a>
          <a className={hours === 168 ? "active" : ""} href="/hbx?hours=168">7d</a>
        </div>
      </div>

      {dbError ? (
        <div className="empty">Database not reachable.</div>
      ) : !last ? (
        <div className="empty">No SensorLinx readings yet — the planner service polls every 5 minutes.</div>
      ) : (
        <>
          <div className="cards">
            <div className="card">
              <h2>Tank
                <span className={`chip ${stale ? "offline" : last.hd_active ? "heating" : "cooling"}`}>
                  {stale ? "stale" : last.hd_active ? "heat demand" : "idle"}
                </span>
              </h2>
              <div className="temps">
                <div className="temp"><div className="v">{fmt(last.tank_f)}°</div><div className="l">Tank</div></div>
                <div className="temp"><div className="v">{fmt(last.tank_target_f)}°</div><div className="l">Target</div></div>
                <div className="temp"><div className="v">{fmt(last.outdoor_f)}°</div><div className="l">Outdoor</div></div>
              </div>
              <div className="meta">
                Stages called: {stagesTxt} · Backup: {last.backup_called ? "CALLED" : "off"} ·
                HBX {last.connected ? "online" : "OFFLINE"} ·
                {" "}last poll {fmtTime(last.ts)}
              </div>
              {curveCfg && (
                <div className="meta">
                  Curve: {curveCfg.dbt}°F @ {curveCfg.dot}°F out → {curveCfg.mbt}°F @ {curveCfg.wwsd}°F out
                  {" "}· diff {cfg!.htDif}°F · bkLag {cfg!.bkLag}m · permHD {cfg!.permHD ? "on" : "off"}
                </div>
              )}
            </div>
          </div>

          <div className="chart-block">
            <h3>Tank vs target vs HP setpoints °F <span className="dim">(HP lines must stay above the red line — plan §3, invariant I1)</span></h3>
            <div className="chart">
              <LineChart hours={hours} series={[
                { color: "#4dabf7", points: pick("tank_f") },
                { color: "#ffd666", points: pick("tank_target_f"), dash: true },
                { color: "#ff6b6b", points: i1Line, dash: true, width: 1.2 },
                { color: "#e599f7", points: scored.flatMap((r) => [{ x: r.t, y: r.s }, { x: r.t + 3599, y: r.s }]), dash: true, width: 1.3 },
                ...pumpSeries.map((s, i) => ({ color: i === 0 ? "#63e6be" : "#f783ac", points: s.points })),
                { color: "#845ef7", points: pick("outdoor_f") },
              ]} />
            </div>
            <div className="legend">
              <span><i style={{ background: "#4dabf7" }} />Tank</span>
              <span><i style={{ background: "#ffd666" }} />Target</span>
              <span><i style={{ background: "#ff6b6b" }} />Target + {I1_MARGIN_F}°F (I1)</span>
              <span><i style={{ background: "#e599f7" }} />Planner wanted (shadow)</span>
              {pumpSeries.map((s, i) => (
                <span key={s.id}><i style={{ background: i === 0 ? "#63e6be" : "#f783ac" }} />{s.id} setpoint</span>
              ))}
              <span><i style={{ background: "#845ef7" }} />Outdoor</span>
            </div>
          </div>

          <div className="chart-block">
            <h3>Reset curve — configured line vs observed <span className="dim">(points off the line = someone changed something)</span></h3>
            <div className="chart"><CurveChart cfg={curveCfg} pts={scatter} /></div>
            <div className="legend">
              <span><i style={{ background: "#ffd666" }} />Configured (Design {curveCfg ? `${curveCfg.dot}°F → ${curveCfg.dbt}°F` : "—"}, WWSD {curveCfg ? `${curveCfg.wwsd}°F → ${curveCfg.mbt}°F` : "—"})</span>
              <span><i style={{ background: "#4dabf7" }} />Observed (outdoor, target)</span>
            </div>
          </div>

          {shadow && shadow.length > 0 && (
            <div className="chart-block">
              <h3>Shadow plan — next 24h <span className="dim">
                (what the planner WOULD command; nothing is written · computed {shadowAt ? fmtTime(shadowAt) : "—"})
              </span></h3>
              <div className="chart">
                <LineChart hours={24} series={[
                  { color: "#ffd666", points: shadow.flatMap((b) => {
                    const t = new Date(b.ts).getTime() / 1000;
                    return [{ x: t, y: b.tank_target_f }, { x: t + 3599, y: b.tank_target_f }];
                  }), dash: true },
                  { color: "#63e6be", points: shadow.flatMap((b) => {
                    const t = new Date(b.ts).getTime() / 1000;
                    return [{ x: t, y: b.hp1_setpoint_f }, { x: t + 3599, y: b.hp1_setpoint_f }];
                  }) },
                  { color: "#845ef7", points: shadow.map((b) => ({ x: new Date(b.ts).getTime() / 1000, y: b.outdoor_f })) },
                ]} />
              </div>
              <div className="legend">
                <span><i style={{ background: "#ffd666" }} />Shadow tank target</span>
                <span><i style={{ background: "#63e6be" }} />Shadow HP1 setpoint</span>
                <span><i style={{ background: "#845ef7" }} />Forecast outdoor</span>
              </div>
              <div className="meta">
                DHW windows: {shadowMeta?.dhw_windows?.map(([a, b2]) => `${String(a).padStart(2, "0")}–${String(b2).padStart(2, "0")}`).join(", ") ?? "06–09, 17–22"}
                {" "}({shadowMeta?.windows_learned
                  ? `learned from ${shadowMeta.learn_days}d / ${shadowMeta.draw_events} draws`
                  : "defaults — learner activates after 5 days of tank history"})
                {gap && <> · 24h opportunity gap: actual target ran <b>{gap.avg >= 0 ? "+" : ""}{gap.avg.toFixed(1)}°F</b> above shadow ({gap.n} hrs scored)</>}
              </div>
              {shadow.filter((b) => !b.reason.startsWith("idle")).slice(0, 8).map((b, i) => (
                <div className="meta" key={i}>
                  {fmtTime(new Date(b.ts))} → {b.tank_target_f}°F · {b.reason}
                </div>
              ))}
            </div>
          )}

          {phasebLog.length > 0 && (
            <div className="chart-block">
              <h3>Phase B rehearsal <span className="dim">(what the tracking loop {phasebLog[0]?.mode === "active" ? "sent" : "WOULD have sent"} — the flip evidence)</span></h3>
              {phasebLog.map((r, i) => (
                <div className="meta" key={i}>
                  {fmtDateTime(r.t)} · {r.pump_id} → {r.value_c == null ? "—" : `${r.value_c}°C`} · {r.mode} · {r.result}
                </div>
              ))}
            </div>
          )}

          {stormEvents.length > 0 && (
            <div className="chart-block">
              <h3>Storm events <span className="dim">(§6.11 ledger — armed windows, manual or triggered)</span></h3>
              {stormEvents.map((ev) => (
                <div className="meta" key={ev.id}>
                  {fmtDateTime(ev.s)} · {ev.trigger} · {ev.e ? `${((ev.e - ev.s) / 3600).toFixed(1)} h` : "open"}
                </div>
              ))}
            </div>
          )}

          {floorSnap && (() => {
            // Zone service floors (§6.9, shadow-only) + the §6.10 unlock, recommend-only.
            // Modeled COP mirrors the planner's Carnot-style surface (η base 0.43).
            const outNow = last?.outdoor_f ?? null;
            const copAt = (o: number, w: number) => {
              if (w - o <= 5) return 6;
              const eta = Math.max(0.3, 0.43 - Math.max(0, 17 - o) * 0.001);
              return Math.max(1, Math.min(6, (eta * (w + 459.67)) / (w - o)));
            };
            const margin = floorSnap.floorF != null && floorSnap.bindingAwtF != null
              ? floorSnap.floorF - floorSnap.bindingAwtF : 4.5;
            const floors = floorSnap.zones.filter((z) => z.awtF != null).sort((a, b) => (b.awtF ?? 0) - (a.awtF ?? 0));
            const calling = floors.filter((z) => z.calling);
            const callDriven = (floorSnap.source ?? "").includes("calls"); // "insights+calls" vs conservative "insights"
            const bindingIsBaseboard = floors[0]?.deliveryType === "baseboard";
            const nextFloor = floors.find((z) => z.deliveryType !== "baseboard");
            const unlocked = bindingIsBaseboard && nextFloor?.awtF != null && floorSnap.floorF != null
              ? Math.round((nextFloor.awtF + margin) * 10) / 10 : null;
            return (
              <div className="chart-block">
                <h3>Winter solver — zone service floors <span className="dim">(§6.9 SHADOW — proposes, never commands)</span></h3>
                <div className="meta">
                  Call feed:{" "}
                  <b>{callDriven ? "live zone calls (Nest hvacStatus)" : "conservative — all zones (calls feed stale)"}</b>
                  {" · "}<b>{calling.length}</b> of {floors.length} hydronic zones calling{callDriven ? "" : " (assumed)"}.
                  <span className="dim"> Plant-level call truth (SensorLinx relays) joins as a second source with TempIQ#1505.</span>
                </div>
                <div className="meta">
                  {floorSnap.bindingAwtF != null ? (
                    <>Binding zone: <b>{floorSnap.bindingZone || calling[0]?.name || "—"}</b> needs{" "}
                    <b>{fmt(floorSnap.bindingAwtF)}°F</b> at the emitter → proposed tank floor{" "}
                    <b>{fmt(floorSnap.floorF)}°F</b> (live HBX target: {fmt(last?.tank_target_f)}°F).</>
                  ) : (
                    <>Binding zone: <b>none calling</b> → no hydronic demand, riding the HBX reset curve
                    (live target {fmt(last?.tank_target_f)}°F).</>
                  )}
                  {" "}DHW window / sanitize floors still govern the final plan on top of this.
                </div>
                {floors.slice(0, 8).map((z, i) => (
                  <div className="meta" key={i} style={z.calling ? { color: "#a9e34b" } : { opacity: 0.5 }}>
                    {z.calling ? "● " : "○ "}{z.name || "(unnamed zone)"} · {z.deliveryType} → {fmt(z.awtF)}°F
                    {z.calling ? " · calling" : ""}
                  </div>
                ))}
                {unlocked != null && outNow != null && floorSnap.floorF != null && (() => {
                  const copNow = copAt(outNow, floorSnap.floorF);
                  const copUnlocked = copAt(outNow, unlocked);
                  return copUnlocked - copNow >= 0.05 ? (
                    <div className="meta" style={{ color: "#e599f7" }}>
                      §6.10 unlock (recommend-only, modeled): mini-split assist for the baseboard zones would drop the
                      floor {fmt(floorSnap.floorF)}°F → {fmt(unlocked)}°F — modeled COP{" "}
                      {copNow.toFixed(2)} → {copUnlocked.toFixed(2)} at {fmt(outNow)}°F out.
                      Measured split COP arrives with TempIQ#1506.
                    </div>
                  ) : (
                    <div className="meta">
                      §6.10 unlock: floor would drop {fmt(floorSnap.floorF)}°F → {fmt(unlocked)}°F with baseboard
                      assist, but at {fmt(outNow)}°F out the lift is already tiny — this bites in heating season.
                    </div>
                  );
                })()}
                <div className="meta">snapshot {fmtDateTime(floorSnap.t)} · degraded mode falls back to the HBX curve (never depends on TempIQ)</div>
              </div>
            );
          })()}

          <div className="chart-block">
            <h3>Storm auto-raise <span className="dim">(§6.11 — what pre-charges the tank, and why)</span></h3>
            <div className="meta">
              Posture: <b>auto-raise + notify</b>. A qualifying storm lifts the in-window tank ceiling to the
              HBX reset-curve target <b>+3°F</b> (capped 135°F), <b>only ever raises</b> a block (never lowers below
              the plan), and pages you on every transition. The winter solver stays shadow; this is the one
              plan-shaping path, safe because Phase B is still dry-run.
            </div>
            <div className="meta">
              <b>Prediction sources:</b> NWS active alerts (api.weather.gov), the OpenMeteo 3-day hourly forecast,
              and OutageWatch grid status. A dead feed never arms anything.
            </div>
            <div className="meta">
              <b>What arms a raise:</b> an NWS <i>Warning</i> (Winter Storm · Ice Storm · Blizzard · High Wind ·
              Extreme Cold / Wind Chill) · forecast &lt; 0°F · gusts &gt; 45 mph for ≥3 h · freezing rain ≥2 h ·
              ≥8 in total snow · a confirmed grid outage (activates immediately, to bank heat before power loss).
            </div>
            <div className="meta dim">
              Watches &amp; Advisories page you but do <b>not</b> raise. Tune any threshold in planner/src/storm.ts.
            </div>
          </div>

          <div className="chart-block">
            <h3>Config versions <span className="dim">(append-only; every row after #1 is a detected edit)</span></h3>
            {versions.map((v) => (
              <div className="meta" key={v.id}>
                #{v.id} · {fmtDateTime(v.t)} ·
                {" "}{v.changed_fields
                  ? Object.entries(v.changed_fields).map(([k, c]) => `${k}: ${c.old} → ${c.new}`).join(" · ")
                  : "initial snapshot (as-found baseline)"}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
