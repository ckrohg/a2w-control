// @purpose Activity — the running change-log the owner asked for (2026-07-18 note 5): every
// move the autonomous system made, newest first, each with its rationale and whether it was
// accepted or refused. Pure surfacing — the data already exists, deduped-on-change, in three
// planner tables:
//   • autopilot_log  — buffer-target decisions (target_f, reason, result, dry_run)
//   • phase_b_log    — per-pump HP-setpoint tracking (pump_id, mode, value_c, result)
//   • hbx_writes     — every write attempt through the guarded API (source, action, detail, result)
// We merge them into one timeline grouped by day. Nothing here writes; it only reads. House
// idioms: nodejs runtime, force-dynamic, parameterized sql, Eastern time via @/lib/tz, try/catch
// degraded state. This is also the "easier to look back" surface — retention is indefinite
// (nothing prunes), so the "all" window reaches back to when each table began recording.
import { sql } from "@vercel/postgres";
import { fmtDay, fmtTime, fmtDateTime } from "@/lib/tz";
import { I1Banner } from "../i1-banner";
import { StormBanner } from "../storm-banner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const WINDOWS: Record<string, { label: string; interval: string | null }> = {
  "24h": { label: "24h", interval: "24 hours" },
  "7d": { label: "7d", interval: "7 days" },
  "30d": { label: "30d", interval: "30 days" },
  all: { label: "all", interval: null },
};

type Kind = "autopilot" | "phaseb" | "write";
type Tone = "ok" | "warn" | "shadow";
type Event = {
  ts: number; // epoch seconds
  kind: Kind;
  kindLabel: string;
  title: string;
  reason: string | null;
  result: string;
  tone: Tone;
  dryRun: boolean;
};

const fmtF = (v: number | null | undefined) =>
  v == null || !isFinite(v as number) ? "—" : `${Math.round(v as number)}°F`;

// Map a raw autopilot result word to a tone. "set"/"held" = it acted (or was already right);
// "would-set" = shadow/dry-run (computed, wrote nothing); "rejected"/"rate-limited" = a guardrail
// or the rate limiter held it back (the system working as designed, not an error to alarm on).
function autopilotTone(result: string, dryRun: boolean): Tone {
  if (dryRun || result.startsWith("would")) return "shadow";
  if (result === "set" || result === "held") return "ok";
  return "warn"; // rejected / rate-limited
}
function writeTone(result: string): Tone {
  return result === "accepted" ? "ok" : "warn";
}
function phasebTone(result: string | null): Tone {
  const r = (result ?? "").toLowerCase();
  if (r.startsWith("would") || r.includes("dry")) return "shadow";
  if (r.includes("sent") || r.includes("ok") || r.includes("set")) return "ok";
  return "warn";
}

const TONE_COLOR: Record<Tone, string> = { ok: "var(--ok)", warn: "var(--warm)", shadow: "var(--dim)" };
const KIND_STYLE: Record<Kind, { label: string; bg: string; fg: string }> = {
  autopilot: { label: "Auto-pilot", bg: "#14324e", fg: "var(--info)" },
  phaseb: { label: "Phase B", bg: "#2a2340", fg: "#c0a9f7" }, // plan violet
  write: { label: "Write", bg: "#1f3d2b", fg: "var(--ok)" },
};

export default async function ActivityPage({ searchParams }: { searchParams: { window?: string } }) {
  const win = WINDOWS[searchParams.window ?? "7d"] ? (searchParams.window ?? "7d") : "7d";
  const iv = WINDOWS[win].interval;

  const events: Event[] = [];
  let dbError = false;
  const counts = { autopilot: 0, phaseb: 0, write: 0 };

  try {
    // Each source is queried independently and merged in JS — one missing/young table can't
    // blank the whole page (each has its own try/catch). LIMIT keeps a wide window bounded.
    try {
      const ap = iv
        ? await sql`SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, target_f, reason, result, dry_run
                    FROM autopilot_log WHERE ts >= now() - (${iv})::interval ORDER BY id DESC LIMIT 300`
        : await sql`SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, target_f, reason, result, dry_run
                    FROM autopilot_log ORDER BY id DESC LIMIT 300`;
      for (const r of ap.rows as any[]) {
        const dryRun = !!r.dry_run;
        const verb = r.result === "set" ? "set" : r.result === "held" ? "held"
          : r.result?.startsWith("would") ? "would set" : r.result?.startsWith("rejected") ? "blocked"
          : r.result === "rate-limited" ? "deferred" : r.result;
        events.push({
          ts: r.ts, kind: "autopilot", kindLabel: KIND_STYLE.autopilot.label,
          title: `Buffer target ${verb} ${fmtF(r.target_f)}`,
          reason: r.reason || null, result: r.result, tone: autopilotTone(r.result, dryRun), dryRun,
        });
        counts.autopilot++;
      }
    } catch { /* autopilot_log not present yet */ }

    try {
      const pb = iv
        ? await sql`SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, pump_id, mode, value_c, result
                    FROM phase_b_log WHERE ts >= now() - (${iv})::interval ORDER BY id DESC LIMIT 300`
        : await sql`SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, pump_id, mode, value_c, result
                    FROM phase_b_log ORDER BY id DESC LIMIT 300`;
      for (const r of pb.rows as any[]) {
        const dryRun = (r.result ?? "").toLowerCase().includes("would") || (r.result ?? "").toLowerCase().includes("dry");
        events.push({
          ts: r.ts, kind: "phaseb", kindLabel: KIND_STYLE.phaseb.label,
          title: `${r.pump_id} setpoint → ${r.value_c == null ? "—" : `${Number(r.value_c).toFixed(0)}°C`}`,
          reason: r.mode || null, result: r.result ?? "—", tone: phasebTone(r.result), dryRun,
        });
        counts.phaseb++;
      }
    } catch { /* phase_b_log not present yet */ }

    try {
      const hw = iv
        ? await sql`SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, source, action, result, detail
                    FROM hbx_writes WHERE ts >= now() - (${iv})::interval ORDER BY id DESC LIMIT 300`
        : await sql`SELECT EXTRACT(EPOCH FROM ts)::float8 AS ts, source, action, result, detail
                    FROM hbx_writes ORDER BY id DESC LIMIT 300`;
      for (const r of hw.rows as any[]) {
        events.push({
          ts: r.ts, kind: "write", kindLabel: KIND_STYLE.write.label,
          title: `${r.action}${r.source ? ` · ${r.source}` : ""}`,
          reason: r.detail || null, result: r.result, tone: writeTone(r.result), dryRun: false,
        });
        counts.write++;
      }
    } catch { /* hbx_writes not present yet */ }
  } catch {
    dbError = true;
  }

  events.sort((a, b) => b.ts - a.ts);

  // Group into day buckets (already newest-first, so the groups come out newest-first too).
  const days: { day: string; rows: Event[] }[] = [];
  for (const e of events) {
    const day = fmtDay(e.ts);
    const last = days[days.length - 1];
    if (last && last.day === day) last.rows.push(e);
    else days.push({ day, rows: [e] });
  }

  return (
    <>
      <I1Banner />
      <StormBanner />

      <div className="controls">
        <div className="seg">
          {Object.entries(WINDOWS).map(([k, w]) => (
            <a key={k} className={win === k ? "active" : ""} href={`/activity?window=${k}`}>{w.label}</a>
          ))}
        </div>
        <span className="dim" style={{ alignSelf: "center", fontSize: 12 }}>
          every autonomous change, newest first · kept indefinitely
        </span>
      </div>

      {dbError ? (
        <div className="empty">Database not reachable.</div>
      ) : events.length === 0 ? (
        <div className="empty">
          No changes recorded in this window. The system only logs when a decision <i>changes</i> —
          a quiet stretch means it held steady.
        </div>
      ) : (
        <>
          <div className="cards">
            <div className="card">
              <h2>Auto-pilot<span className="chip cooling">buffer target</span></h2>
              <div className="temps">
                <div className="temp"><div className="v">{counts.autopilot}</div><div className="l">decisions ({WINDOWS[win].label})</div></div>
              </div>
              <div className="meta">Every time the planner’s buffer-target decision changed — set, held, blocked by a guardrail, or (in shadow) what it would have set.</div>
            </div>
            <div className="card">
              <h2>Phase B<span className="chip" style={{ background: "#2a2340", color: "#c0a9f7" }}>HP setpoints</span></h2>
              <div className="temps">
                <div className="temp"><div className="v">{counts.phaseb}</div><div className="l">setpoint moves ({WINDOWS[win].label})</div></div>
              </div>
              <div className="meta">Per-pump leaving-water setpoint tracking toward the tank target + margin.</div>
            </div>
            <div className="card">
              <h2>Writes<span className="chip ok">guarded</span></h2>
              <div className="temps">
                <div className="temp"><div className="v">{counts.write}</div><div className="l">write attempts ({WINDOWS[win].label})</div></div>
              </div>
              <div className="meta">Every attempt through the guarded API — accepted or refused. A refusal is the guardrail doing its job, not a fault.</div>
            </div>
          </div>

          {days.map((d) => (
            <div className="chart-block" key={d.day}>
              <h3>{d.day}</h3>
              {d.rows.map((e, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "5px 0", borderTop: i ? "1px solid var(--line)" : "none" }}>
                  <span className="dim" style={{ fontVariantNumeric: "tabular-nums", minWidth: 62, fontSize: 12.5 }}>{fmtTime(e.ts)}</span>
                  <span className="chip" style={{ background: KIND_STYLE[e.kind].bg, color: KIND_STYLE[e.kind].fg, flex: "0 0 auto" }}>{e.kindLabel}</span>
                  <span style={{ flex: 1, fontSize: 13.5 }}>
                    <b style={{ color: TONE_COLOR[e.tone] }}>{e.title}</b>
                    {e.dryRun && <span className="dim" style={{ fontSize: 11.5 }}> · shadow (wrote nothing)</span>}
                    {e.reason && <div className="dim" style={{ fontSize: 12.5, marginTop: 2 }}>{e.reason}</div>}
                  </span>
                </div>
              ))}
            </div>
          ))}

          <div className="chart-block">
            <h3>How to read this</h3>
            <div className="meta">
              The system records a line only when a decision <b>changes</b> — so this is a log of moves,
              not a per-minute feed. <b style={{ color: "var(--ok)" }}>Green</b> = it acted (set or held on
              purpose). <b style={{ color: "var(--warm)" }}>Amber</b> = a guardrail or the rate limiter held
              it back (working as designed). <span className="dim">Grey · shadow</span> = it computed the move
              but wrote nothing (advisory mode). Nothing here is pruned — the <b>all</b> window reaches back to
              when logging began.
            </div>
          </div>
        </>
      )}
    </>
  );
}
