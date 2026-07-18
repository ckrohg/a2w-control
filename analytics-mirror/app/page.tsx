// @purpose Home dashboard — one place for the whole plant: pump cards + buffer-tank card
// + current shadow-plan card, an alert-chip row (reader/pump offline, backup called, HBX
// drift), the I1 banner, and the per-pump history charts. Mobile-first (kanban card).
// Deep views: /hbx (tank, curve, plan detail), /control (setpoint writes).
import { sql } from "@vercel/postgres";
import { ensureSchema, recentReadings, recentSpanReadings, type Reading } from "@/lib/db";
import { fmtTime, fmtDay, fmtDateTime } from "@/lib/tz";
import { I1Banner } from "./i1-banner";
import { StormBanner } from "./storm-banner";
import { Chart, type Series, type Band } from "@/app/ui/chart";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// force-no-store matters as much as force-dynamic: @vercel/postgres runs over HTTP fetch,
// and parameterless queries (identical request bodies) otherwise hit Vercel's Data Cache —
// the tank card once fossilized on a 10-hour-old row this way while parameterized queries
// (changing ${since}) stayed fresh.
export const fetchCache = "force-no-store";

const f = (c: number | null) => (c == null ? null : (c * 9) / 5 + 32);
const fmt = (v: number | null | undefined, d = 0) => (v == null ? "—" : v.toFixed(d));
// Comm health — the Pi pushes readings.error_rate (fraction or %); surface it as link quality.
const commPct = (er: number | null) =>
  er == null ? "" : ` · ${(er <= 1 ? er * 100 : er).toFixed(0)}% comm err`;

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
  let commandedTargetF: number | null = null;
  let autopilot: { ts: number; targetF: number | null; reason: string; result: string; dryRun: boolean } | null = null;
  let shadow: ShadowBlock[] | null = null;
  let driftAt: number | null = null;
  let faults: { pump: string; code: string; message: string; severity: string; since?: number }[] = [];
  let calls: { ts: number; any_call: boolean }[] = [];
  let spanElement: { x: number; y: number | null }[] = [];
  // Backup shadow-test: with the 16.5 kW element's SPAN breaker physically OFF, backup_called
  // still reflects the HBX's DECISION to call it — so this counts how often our settings would
  // have fired the element over 7 days (cost-free while the breaker is off). 0 = settings clean.
  let backupShadow: { episodes7d: number; lastCalled: number | null } | null = null;
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
      // Commanded target = midpoint of the latest reset-curve we wrote. Differs from the
      // operative (slx.tank_target_f) during the adoption lag (until the next reheat cycle).
      const cc = await sql<{ dbt: number; mbt: number }>`
        SELECT (config->>'dbt')::float8 AS dbt, (config->>'mbt')::float8 AS mbt
        FROM hbx_config_versions ORDER BY id DESC LIMIT 1`;
      commandedTargetF = cc.rowCount ? Math.round((cc.rows[0].dbt + cc.rows[0].mbt) / 2) : null;
      // Auto-pilot latest decision. Its own try/catch — the table isn't created until the planner
      // deploys + runs ensureSchema, and a missing table must not break the whole page.
      try {
        const ap = await sql<{ ts: number; target_f: number | null; reason: string; result: string; dry_run: boolean }>`
          SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, target_f, reason, result, dry_run
          FROM autopilot_log ORDER BY id DESC LIMIT 1`;
        if (ap.rowCount) {
          const r = ap.rows[0];
          autopilot = { ts: r.ts, targetF: r.target_f, reason: r.reason, result: r.result, dryRun: r.dry_run };
        }
      } catch { /* autopilot_log not created yet — ignore */ }
      const sp = await sql`SELECT plan FROM shadow_plans ORDER BY id DESC LIMIT 1`;
      shadow = sp.rowCount ? (sp.rows[0].plan as ShadowBlock[]) : null;
      const d = await sql`
        SELECT EXTRACT(EPOCH FROM observed_at)::float8 AS t FROM hbx_config_versions
        WHERE changed_fields IS NOT NULL AND changed_fields->>'_source' IS NULL
          AND observed_at >= now() - interval '48 hours'
        ORDER BY id DESC LIMIT 1`;
      driftAt = d.rowCount ? (d.rows[0].t as number) : null;
      calls = (await sql`
        SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts,
               (backup_called OR EXISTS (SELECT 1 FROM unnest(stages_called) s WHERE s)) AS any_call
        FROM slx_readings WHERE ts >= now() - (${hours} || ' hours')::interval
        ORDER BY ts ASC`).rows as { ts: number; any_call: boolean }[];
      try {
        const spanRows = await recentSpanReadings(hours);
        spanElement = spanRows
          .filter((s) => s.name === "Buffer Tank")
          .map((s) => ({ x: s.ts, y: s.power_w }));
      } catch { /* span_readings not created until the bridge deploys — ignore */ }
      const bs = await sql`
        WITH b AS (
          SELECT ts, backup_called, lag(backup_called) OVER (ORDER BY ts) AS prev
          FROM slx_readings WHERE ts >= now() - interval '7 days')
        SELECT COUNT(*) FILTER (WHERE backup_called AND NOT COALESCE(prev, false)) AS episodes,
               EXTRACT(EPOCH FROM MAX(ts) FILTER (WHERE backup_called))::float8 AS last_called
        FROM b`;
      backupShadow = {
        episodes7d: Number(bs.rows[0].episodes) || 0,
        lastCalled: bs.rows[0].last_called != null ? Number(bs.rows[0].last_called) : null,
      };
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
      <I1Banner />
      <StormBanner />

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
        <div className="empty">Can&apos;t load live data right now — this page retries on its own.</div>
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
                    last {fmtTime(last.ts)}{commPct(last.error_rate)}
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
                <div className="temp">
                  <div className="v">{commandedTargetF != null ? commandedTargetF : fmt(slx?.tank_target_f, 1)}°</div>
                  <div className="l">
                    {commandedTargetF != null && slx?.tank_target_f != null && Math.abs(commandedTargetF - slx.tank_target_f) > 3
                      ? `Target · adopting (${fmt(slx.tank_target_f, 0)}°)`
                      : "Target"}
                  </div>
                </div>
                <div className="temp"><div className="v">{fmt(slx?.outdoor_f, 1)}°</div><div className="l">Outdoor</div></div>
              </div>
              <div className="meta">
                Stages: {stagesTxt} · Backup: {slx?.backup_called ? "CALLED" : "off"} · <a href="/hbx" style={{ color: "#4dabf7" }}>details →</a>
              </div>
              {backupShadow && (
                <div className="meta" style={{ marginTop: 4 }}>
                  <span
                    className={`chip ${backupShadow.episodes7d === 0 && !slx?.backup_called ? "ok" : "warn"}`}
                    style={{ marginRight: 6 }}
                  >
                    backup shadow-test
                  </span>
                  {backupShadow.episodes7d === 0 && !slx?.backup_called
                    ? "HBX hasn't called the backup in 7 days ✓ — breaker off, settings clean"
                    : `HBX called the backup ${backupShadow.episodes7d}× in 7 days${
                        backupShadow.lastCalled
                          ? ` · last ${new Date(backupShadow.lastCalled * 1000).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                              timeZone: "America/New_York",
                            })}`
                          : ""
                      } — investigate (a setting may be triggering it)`}
                </div>
              )}
              {autopilot && (
                <div className="meta" style={{ marginTop: 4 }}>
                  <span className={`chip ${autopilot.dryRun ? "warn" : "ok"}`} style={{ marginRight: 6 }}>
                    auto-pilot · {autopilot.dryRun ? "dry-run" : "LIVE"}
                  </span>
                  {autopilot.result === "held"
                    ? `holding ${autopilot.targetF}°F`
                    : autopilot.result === "would-set"
                      ? `would set ${autopilot.targetF}°F`
                      : `${autopilot.result} · ${autopilot.targetF}°F`}
                  {autopilot.reason ? ` — ${autopilot.reason}` : ""}
                </div>
              )}
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
            // Running band: contiguous state === "heating" stretches (compressors on),
            // bridged across normal 60s sample gaps — the "was it actually running" strip.
            const runBands: Band[] = [];
            for (const r of rs) {
              if (r.state !== "heating") continue;
              const last = runBands[runBands.length - 1];
              if (last && r.ts - last.x1 <= 180) last.x1 = r.ts + 60;
              else runBands.push({ x0: r.ts, x1: r.ts + 60 });
            }
            // Unserved-call band (red): an HBX call was up but NO pump anywhere was
            // running (±3 min tolerance for start ramps) — the HP2-winter-failure
            // signature, drawn as a system condition on every pump's chart.
            const heatingTs = rows.filter((r) => r.state === "heating").map((r) => r.ts);
            const unservedBands: Band[] = [];
            for (const c of calls) {
              if (!c.any_call) continue;
              const served = heatingTs.some((t) => Math.abs(t - c.ts) <= 180);
              if (served) continue;
              const last = unservedBands[unservedBands.length - 1];
              if (last && c.ts - last.x1 <= 420) last.x1 = c.ts + 300;
              else unservedBands.push({ x0: c.ts, x1: c.ts + 300, color: "#ff6b6b" });
            }
            // require persistence ≥10 min so anti-short-cycle restarts stay innocent
            const flaggedBands = unservedBands.filter((b) => b.x1 - b.x0 >= 600);
            return (
              <div key={id}>
                <div className="chart-block">
                  <h3>{name} — Temperatures °F</h3>
                  <div className="chart">
                    <Chart hours={hours} bands={[...runBands, ...flaggedBands]} series={[
                      { color: "#4dabf7", points: pick("outlet_c", true) },
                      { color: "#63e6be", points: pick("inlet_c", true) },
                      { color: "#845ef7", points: pick("ambient_c", true) },
                      { color: "#ffd666", points: pick("setpoint_c", true), dash: true },
                    ]} />
                  </div>
                  <div className="legend">
                    <span><i style={{ background: "#63e6be", borderRadius: 3 }} />Running (top strip)</span>
                    <span><i style={{ background: "#ff6b6b", borderRadius: 3 }} />Called, nothing running</span>
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
          <div className="chart-block">
            <h3>Backup Element (Buffer Tank) — Power W</h3>
            <div className="chart">
              <Chart hours={hours} series={[{ color: "#ff6b6b", points: spanElement }]} />
            </div>
            <div className="legend">
              <span><i style={{ background: "#ff6b6b" }} />16.5 kW electric element — SPAN live watts</span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
