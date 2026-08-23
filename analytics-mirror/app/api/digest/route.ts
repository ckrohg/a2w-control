// @purpose Weekly email digest v2 (owner asks 2026-08-06): every Monday morning a Vercel
// cron hits this route, which composes the week from Neon — electricity, measured COP,
// realized savings (all with week-over-week deltas), a 7-day savings bar strip, hot-water
// usage (TempIQ aggregate), backup-element cost, hygiene recency, comm quality, faults —
// and mails it via Resend. Cookie sessions get a browser preview of the same HTML; only
// the cron's CRON_SECRET bearer (or ?send=1) actually sends. No-ops with a clear body
// when Resend env is missing so the cron never error-spams while unconfigured.
// Chart craft follows the dataviz method: stat tiles for headline magnitudes, one
// single-hue bar strip (validated #2a78d6 on white), baseline-anchored 4px data ends,
// selective direct labels, status colors reserved for status (with glyphs, never alone).
import { NextResponse } from "next/server";
import { sql } from "@/lib/sql";
import { isAuthed } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DASH_URL = "https://a2w-analytics-mirror.vercel.app";
const ELEMENT_KW = 16.5;
const RATE = Number(process.env.DIGEST_RATE_USD_KWH ?? "0.31");

// Email-safe palette (light surface committed — email clients force their own dark
// transforms; near-black ink + one validated series hue survive them best).
const INK = "#0b0b0b", INK2 = "#52514e", MUTED = "#9b9a94";
// SERIES is mark-grade (bars, links; ≥3:1 on white, validated). GOOD/BAD are darkened
// text-grade steps of the status hues — the palette's mark-grade status colors don't
// clear small-text contrast on white.
const SERIES = "#2a78d6", GOOD = "#067806", BAD = "#b3261e";
const TILE_BG = "#f4f5f7", RULE = "#e8e7e3";

type WeekAgg = {
  wk: string; saved: number; kwh: number; outdoor: number | null; cop: number | null;
  days: number; metered_days: number; measured_days: number;
};
type FaultRow = {
  pump_id: string; code: string; severity: string; message: string | null;
  n: number; last_ts: number;
};

const fmt = (v: number | null | undefined, digits = 1) =>
  v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(digits);

const day = (epoch: number) =>
  new Date(epoch * 1000).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "America/New_York",
  });

/** Week-over-week delta chip. goodWhen says which direction is a win — the color follows
 *  the BENEFIT, the glyph carries the direction, so neither is color-alone. */
function delta(cur: number | null, prev: number | null | undefined, goodWhen: "up" | "down"): string {
  if (cur == null || prev == null || !isFinite(prev) || Math.abs(prev) < 1e-9) return "";
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  if (!isFinite(pct) || Math.abs(pct) < 0.5) return `<span style="color:${INK2}">· flat vs last wk</span>`;
  const up = pct > 0;
  const win = (up && goodWhen === "up") || (!up && goodWhen === "down");
  const glyph = up ? "▲" : "▼";
  return `<span style="color:${win ? GOOD : BAD}">${glyph} ${Math.abs(pct).toFixed(0)}%</span>` +
         `<span style="color:${INK2}"> vs last wk</span>`;
}

async function buildDigest() {
  const weeks = (await sql<WeekAgg>`
    SELECT (CASE WHEN day >= (now() - interval '7 days')::date THEN 'cur' ELSE 'prev' END) AS wk,
           coalesce(sum(saved_usd), 0)::float8 AS saved,
           coalesce(sum(actual_elec_kwh), 0)::float8 AS kwh,
           avg(avg_outdoor_f)::float8 AS outdoor,
           (CASE WHEN sum(actual_elec_kwh) > 0
                 THEN sum(cop_now * actual_elec_kwh) / sum(actual_elec_kwh) END)::float8 AS cop,
           count(*)::int AS days,
           (count(*) FILTER (WHERE energy_metered))::int AS metered_days,
           (count(*) FILTER (WHERE confidence = 'measured'))::int AS measured_days
    FROM realized_savings WHERE day >= (now() - interval '14 days')::date GROUP BY 1`).rows;
  const cur = weeks.find((w) => w.wk === "cur") ??
    { wk: "cur", saved: 0, kwh: 0, outdoor: null, cop: null, days: 0, metered_days: 0, measured_days: 0 };
  const prev = weeks.find((w) => w.wk === "prev");

  const totalSaved = Number(
    (await sql`SELECT coalesce(sum(saved_usd), 0)::float8 AS s FROM realized_savings`).rows[0].s);

  const daily = (await sql<{ d: string; dow: string; saved: number }>`
    SELECT to_char(day, 'MM-DD') AS d, to_char(day, 'Dy') AS dow,
           coalesce(saved_usd, 0)::float8 AS saved
    FROM realized_savings
    WHERE day >= (now() - interval '7 days')::date ORDER BY day`).rows;

  // pump_events.ts is epoch seconds (double) — mirror of the Pi's event log.
  const faults = (await sql<FaultRow>`
    SELECT pump_id, code, severity, max(message) AS message, count(*)::int AS n,
           max(ts)::float8 AS last_ts
    FROM pump_events
    WHERE type = 'fault_on' AND severity <> 'info'
      AND ts >= extract(epoch FROM now() - interval '7 days')
    GROUP BY pump_id, code, severity ORDER BY max(ts) DESC LIMIT 10`).rows;
  const active = (await sql<FaultRow & { type: string }>`
    SELECT pump_id, code, severity, message, last_ts, 0 AS n, type FROM (
      SELECT DISTINCT ON (pump_id, code) pump_id, code, severity, message, type,
             ts::float8 AS last_ts
      FROM pump_events WHERE type IN ('fault_on', 'fault_off') AND severity <> 'info'
      ORDER BY pump_id, code, ts DESC) latest
    WHERE type = 'fault_on'`).rows;

  const plant = (await sql`
    SELECT avg(tank_f) FILTER (WHERE ts >= now() - interval '7 days')::float8 AS tank,
           (count(*) FILTER (WHERE backup_called AND ts >= now() - interval '7 days'))::float8 * 5 / 60 AS backup_h,
           (count(*) FILTER (WHERE backup_called AND ts < now() - interval '7 days'))::float8 * 5 / 60 AS backup_h_prev
    FROM slx_readings WHERE ts >= now() - interval '14 days'`).rows[0];

  const moves = Number((await sql`
    SELECT count(*)::int AS n FROM autopilot_log
    WHERE ts >= now() - interval '7 days'`).rows[0].n);

  // Last pasteurization-grade dwell marker (>=131°F, the savings page's hygiene marker).
  const hygiene = (await sql`
    SELECT EXTRACT(EPOCH FROM (now() - max(ts)))::float8 / 86400 AS days_ago
    FROM slx_readings WHERE tank_f >= 131`).rows[0];

  // Hot water: TempIQ aggregate (single-row jsonb; events carry per-recharge kWh).
  let dhw: { weekKwh: number; events: number; cop: number | null } | null = null;
  try {
    const payload = (await sql`SELECT payload FROM tempiq_dhw_usage WHERE id = 1`).rows[0]?.payload as
      { events?: Array<{ at: string; energyKwh: number }>; estimate?: { hydronicCop?: number } } | undefined;
    if (payload?.events) {
      const cutoff = Date.now() - 7 * 86400_000;
      const wk = payload.events.filter((e) => new Date(e.at).getTime() >= cutoff);
      dhw = {
        weekKwh: wk.reduce((s, e) => s + (e.energyKwh || 0), 0),
        events: wk.length,
        cop: payload.estimate?.hydronicCop ?? null,
      };
    }
  } catch { /* aggregate missing — omit the block */ }

  // Comm-quality trend (dropouts wk vs prev wk + avg error rate) — the early hardware
  // signal that flagged the Aug-5 WiFi regression on its first render.
  const comm = (await sql<{ pump_id: string; drops: number; prev: number; err: number | null }>`
    SELECT e.pump_id, coalesce(e.drops, 0) AS drops, coalesce(e.prev, 0) AS prev, r.err
    FROM (
      SELECT pump_id,
             (count(*) FILTER (WHERE ts >= extract(epoch FROM now() - interval '7 days')))::int AS drops,
             (count(*) FILTER (WHERE ts <  extract(epoch FROM now() - interval '7 days')))::int AS prev
      FROM pump_events
      WHERE type = 'comm' AND code = 'offline'
        AND ts >= extract(epoch FROM now() - interval '14 days')
      GROUP BY pump_id) e
    FULL JOIN (
      SELECT pump_id, (avg(error_rate) * 100)::float8 AS err
      FROM readings WHERE ts >= extract(epoch FROM now() - interval '7 days')
      GROUP BY pump_id) r USING (pump_id)
    ORDER BY pump_id`).rows;

  const activeKeys = new Set(active.map((f) => `${f.pump_id}:${f.code}`));
  const backupH = plant.backup_h != null ? Number(plant.backup_h) : 0;
  const backupKwh = backupH * ELEMENT_KW;
  const hygDays = hygiene.days_ago != null ? Number(hygiene.days_ago) : null;

  // ---- headline: one sentence, most important thing first --------------------------
  let headline: string;
  if (active.length) {
    headline = `⚠ ${active.length} fault${active.length === 1 ? "" : "s"} currently active — see below.`;
  } else if (backupH > 1) {
    headline = `The backup element ran ${fmt(backupH, 1)} h this week (~${fmt(backupKwh, 0)} kWh at COP 1) — worth a look.`;
  } else if (prev && prev.saved > 0.5) {
    const d = ((cur.saved - prev.saved) / prev.saved) * 100;
    headline = d >= 0
      ? `Saved $${fmt(cur.saved, 2)} — up ${d.toFixed(0)}% on last week. No active faults.`
      : `Saved $${fmt(cur.saved, 2)} — down ${Math.abs(d).toFixed(0)}% on last week (weather-dependent). No active faults.`;
  } else {
    headline = `A quiet week: $${fmt(cur.saved, 2)} saved, no active faults.`;
  }

  // ---- stat tiles ------------------------------------------------------------------
  const tile = (label: string, value: string, sub: string) => `
    <td width="50%" style="padding:12px 14px;background:${TILE_BG};border-radius:8px">
      <div style="font-size:22px;font-weight:600;color:${INK};line-height:1.1">${value}</div>
      <div style="font-size:12px;color:${INK2};margin-top:3px">${label}</div>
      ${sub ? `<div style="font-size:11px;margin-top:2px">${sub}</div>` : ""}
    </td>`;

  const tiles = `
  <table cellspacing="8" cellpadding="0" style="border-collapse:separate;width:100%"><tr>
    ${tile("electricity", `${fmt(cur.kwh, 0)} kWh`,
           `${delta(cur.kwh, prev?.kwh, "down")}${cur.metered_days === cur.days && cur.days > 0 ? "" : ` <span style=\"color:${MUTED}\">· ${cur.metered_days}/${cur.days}d metered</span>`}`)}
    ${tile("average COP", fmt(cur.cop, 2),
           `${delta(cur.cop, prev?.cop, "up")} <span style="color:${MUTED}">· measured ${cur.measured_days}/${cur.days}d</span>`)}
  </tr><tr>
    ${tile("saved this week", `$${fmt(cur.saved, 2)}`,
           `${delta(cur.saved, prev?.saved, "up")} <span style="color:${MUTED}">· $${fmt(totalSaved, 0)} since Jul 16</span>`)}
    ${tile("hot water", dhw ? `${fmt(dhw.weekKwh, 1)} kWh` : "—",
           dhw ? `<span style="color:${INK2}">${dhw.events} recharge${dhw.events === 1 ? "" : "s"}</span> <span style="color:${MUTED}">· DHW COP ${fmt(dhw.cop, 1)}</span>` : `<span style="color:${MUTED}">no TempIQ data</span>`)}
  </tr></table>`;

  // ---- 7-day savings bar strip (single series -> no legend; title names it; ---------
  // selective labels on max + latest; zero days get a muted 2px stub) ---------------
  let barStrip = "";
  if (daily.length) {
    const maxSaved = Math.max(...daily.map((r) => r.saved), 0.01);
    const maxIdx = daily.findIndex((r) => r.saved === Math.max(...daily.map((x) => x.saved)));
    const cells = daily.map((r, i) => {
      const h = Math.max(2, Math.round((r.saved / maxSaved) * 56));
      const zero = r.saved < 0.005;
      const label = (i === maxIdx || i === daily.length - 1) && !zero
        ? `<div style="font-size:10px;color:${INK2};text-align:center;margin-bottom:2px">$${r.saved.toFixed(2)}</div>` : "";
      return `<td style="vertical-align:bottom;padding:0 2px">
        ${label}
        <div style="height:${zero ? 2 : h}px;background:${zero ? RULE : SERIES};border-radius:4px 4px 0 0"></div>
      </td>`;
    }).join("");
    const dows = daily.map((r) => `<td style="font-size:10px;color:${MUTED};text-align:center;padding-top:3px">${r.dow.trim()[0]}</td>`).join("");
    barStrip = `
    <div style="font-size:12px;color:${INK2};margin:18px 0 0">Saved per day ($)</div>
    <table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse;margin-top:6px">
      <tr>${cells}</tr>
      <tr style="border-top:1px solid ${RULE}">${dows}</tr>
    </table>`;
  }

  // ---- faults ----------------------------------------------------------------------
  const faultLines = faults.map((f) => {
    const still = activeKeys.has(`${f.pump_id}:${f.code}`)
      ? ` — <b style="color:${BAD}">still active</b>` : " — cleared";
    const times = f.n > 1 ? ` (×${f.n} this week)` : "";
    return `<li style="margin:4px 0"><b>${f.pump_id.toUpperCase()} ${f.code}</b>
      (${f.severity}): ${f.message ?? ""}${times}, last ${day(f.last_ts)}${still}</li>`;
  });
  for (const f of active) {
    if (!faults.some((w) => w.pump_id === f.pump_id && w.code === f.code)) {
      faultLines.push(`<li style="margin:4px 0"><b>${f.pump_id.toUpperCase()} ${f.code}</b>
        (${f.severity}): ${f.message ?? ""} — <b style="color:${BAD}">still active</b> since ${day(f.last_ts)}</li>`);
    }
  }

  // ---- notes -----------------------------------------------------------------------
  const notes: string[] = [];
  notes.push(backupH > 0
    ? `Backup element: <b>${fmt(backupH, 1)} h</b> (~${fmt(backupKwh, 0)} kWh ≈ $${fmt(backupKwh * RATE, 2)} at COP 1)${delta(backupH, plant.backup_h_prev != null ? Number(plant.backup_h_prev) : null, "down") ? " " + delta(backupH, Number(plant.backup_h_prev), "down") : ""} — it joins during hard hot-water draws.`
    : `Backup element: 0 h — pumps carried every draw.`);
  notes.push(`Autopilot: ${moves} target adjustment${moves === 1 ? "" : "s"}; tank averaged ${fmt(plant.tank != null ? Number(plant.tank) : null, 0)}°F at ${fmt(cur.outdoor, 0)}°F avg outdoor.`);
  if (hygDays != null) {
    const stale = hygDays > 3.5;
    notes.push(`Hygiene: last pasteurization-grade soak ${fmt(hygDays, 1)} days ago${stale ? ` — <b style="color:${BAD}">longer than the summer cadence expects</b>` : ""}.`);
  }
  for (const c of comm) {
    const rising = c.drops > c.prev && c.drops >= 3;
    notes.push(`${c.pump_id.toUpperCase()} comm: ${c.drops} dropout${c.drops === 1 ? "" : "s"} (prev wk ${c.prev})${c.err != null ? ` · ${fmt(Number(c.err), 1)}% err` : ""}${rising ? ` — <b style="color:${BAD}">degrading, keep an eye on it</b>` : ""}.`);
  }

  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400_000);
  const range = `${day(start.getTime() / 1000)} – ${day(end.getTime() / 1000)}`;

  const html = `
  <div style="background:#ffffff;color:${INK};font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:4px 8px">
    <h2 style="margin:16px 0 2px;color:${INK}">A2W Control — weekly</h2>
    <div style="color:${INK2};font-size:13px;margin-bottom:10px">${range} · 6 Black Brook Rd</div>
    <div style="font-size:14px;line-height:1.45;margin:0 0 14px;padding:10px 12px;background:${TILE_BG};border-radius:8px">${headline}</div>
    ${tiles}
    ${barStrip}
    <h3 style="margin:22px 0 6px;color:${INK}">Faults</h3>
    ${faultLines.length
      ? `<ul style="padding-left:18px;margin:0;font-size:14px;line-height:1.4">${faultLines.join("")}</ul>`
      : `<div style="font-size:14px;color:${GOOD}">✓ No faults this week.</div>`}
    <h3 style="margin:20px 0 6px;color:${INK}">Notes</h3>
    <ul style="padding-left:18px;margin:0;font-size:14px;line-height:1.5">
      ${notes.map((n) => `<li style="margin:4px 0">${n}</li>`).join("")}
    </ul>
    <div style="margin:22px 0;font-size:13px">
      <a href="${DASH_URL}" style="color:${SERIES}">Open the dashboard →</a>
    </div>
    <div style="color:${MUTED};font-size:11px;border-top:1px solid ${RULE};padding-top:8px">
      Sent Mondays by the A2W weekly digest cron.
    </div>
  </div>`;

  const faultBit = active.length ? ` · ${active.length} active fault${active.length === 1 ? "" : "s"}` : "";
  const deltaBit = prev && prev.saved > 0.5
    ? ` (${cur.saved >= prev.saved ? "▲" : "▼"}${Math.abs(((cur.saved - prev.saved) / prev.saved) * 100).toFixed(0)}%)` : "";
  const subject = `A2W weekly: $${fmt(cur.saved, 2)} saved${deltaBit} · COP ${fmt(cur.cop, 2)} · ${fmt(cur.kwh, 0)} kWh${faultBit}`;
  return { subject, html };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const secret = process.env.CRON_SECRET ?? "";
  const isCron = !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
  const hasKey = !!secret && url.searchParams.get("key") === secret;
  if (!isCron && !hasKey && !isAuthed()) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const digest = await buildDigest();

  // Browser hits preview by default; only the cron (or an explicit ?send=1) emails.
  const wantSend = isCron || url.searchParams.get("send") === "1";
  if (!wantSend) {
    return new Response(digest.html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.DIGEST_TO;
  if (!apiKey || !to) {
    return NextResponse.json({ skipped: "RESEND_API_KEY / DIGEST_TO not configured" });
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.DIGEST_FROM ?? "A2W Control <onboarding@resend.dev>",
      to: [to],
      subject: digest.subject,
      html: digest.html,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json({ error: "resend failed", status: res.status, body }, { status: 502 });
  }
  return NextResponse.json({ sent: true, id: (body as { id?: string }).id ?? null });
}
