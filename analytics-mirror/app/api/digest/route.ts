// @purpose Weekly email digest (owner ask 2026-08-06): every Monday morning a Vercel cron
// hits this route, which sums the week from Neon — electricity, measured COP, realized
// savings, faults, backup-element activity — and mails it via Resend. The same route
// previews in the browser (?preview implied for cookie sessions; cron's CRON_SECRET
// bearer actually sends). No-ops with a clear body when Resend env is missing, so the
// cron never error-spams while unconfigured.
import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { isAuthed } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DASH_URL = "https://a2w-analytics-mirror.vercel.app";

type WeekRow = {
  saved: number; kwh: number; outdoor: number | null; cop: number | null;
  days: number; metered_days: number; measured_days: number;
};
type FaultRow = {
  pump_id: string; code: string; severity: string; message: string | null;
  n: number; last_ts: number;
};

const fmt = (v: number | null | undefined, digits = 1) =>
  v == null || Number.isNaN(v) ? "—" : v.toFixed(digits);

const day = (epoch: number) =>
  new Date(epoch * 1000).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "America/New_York",
  });

async function buildDigest() {
  const week = (await sql<WeekRow>`
    SELECT coalesce(sum(saved_usd), 0)::float8 AS saved,
           coalesce(sum(actual_elec_kwh), 0)::float8 AS kwh,
           avg(avg_outdoor_f)::float8 AS outdoor,
           (CASE WHEN sum(actual_elec_kwh) > 0
                 THEN sum(cop_now * actual_elec_kwh) / sum(actual_elec_kwh) END)::float8 AS cop,
           count(*)::int AS days,
           (count(*) FILTER (WHERE energy_metered))::int AS metered_days,
           (count(*) FILTER (WHERE confidence = 'measured'))::int AS measured_days
    FROM realized_savings WHERE day >= (now() - interval '7 days')::date`).rows[0];

  const totalSaved = Number(
    (await sql`SELECT coalesce(sum(saved_usd), 0)::float8 AS s FROM realized_savings`).rows[0].s);

  // pump_events.ts is epoch seconds (double), not timestamptz — mirror of the Pi's event log.
  const faults = (await sql<FaultRow>`
    SELECT pump_id, code, severity, max(message) AS message, count(*)::int AS n,
           max(ts)::float8 AS last_ts
    FROM pump_events
    WHERE type = 'fault_on' AND severity <> 'info'
      AND ts >= extract(epoch FROM now() - interval '7 days')
    GROUP BY pump_id, code, severity ORDER BY max(ts) DESC LIMIT 10`).rows;

  // A fault is active now if its latest on/off edge is an "on".
  const active = (await sql<FaultRow & { type: string }>`
    SELECT pump_id, code, severity, message, last_ts, 0 AS n, type FROM (
      SELECT DISTINCT ON (pump_id, code) pump_id, code, severity, message, type,
             ts::float8 AS last_ts
      FROM pump_events WHERE type IN ('fault_on', 'fault_off') AND severity <> 'info'
      ORDER BY pump_id, code, ts DESC) latest
    WHERE type = 'fault_on'`).rows;

  const plant = (await sql`
    SELECT avg(tank_f)::float8 AS tank,
           (count(*) FILTER (WHERE backup_called))::float8 * 5 / 60 AS backup_h
    FROM slx_readings WHERE ts >= now() - interval '7 days'`).rows[0];

  const moves = Number((await sql`
    SELECT count(*)::int AS n FROM autopilot_log
    WHERE ts >= now() - interval '7 days'`).rows[0].n);

  // Comm-quality trend: offline edges this week vs the week before, per pump. A rising
  // dropout count is the earliest hardware-degradation signal we have — HP2's comm board
  // flapped for days at low grade before dying (2026-08-06).
  const comm = (await sql<{ pump_id: string; drops: number; prev: number; err: number | null }>`
    SELECT e.pump_id,
           coalesce(e.drops, 0) AS drops, coalesce(e.prev, 0) AS prev, r.err
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

  const faultLines = faults.map((f) => {
    const still = activeKeys.has(`${f.pump_id}:${f.code}`) ? " — <b>still active</b>" : " — cleared";
    const times = f.n > 1 ? ` (×${f.n} this week)` : "";
    return `<li style="margin:4px 0"><b>${f.pump_id.toUpperCase()} ${f.code}</b>
      (${f.severity}): ${f.message ?? ""}${times}, last ${day(f.last_ts)}${still}</li>`;
  });
  // Long-running faults predate the week's fault_on edges but are still worth showing.
  for (const f of active) {
    if (!faults.some((w) => w.pump_id === f.pump_id && w.code === f.code)) {
      faultLines.push(`<li style="margin:4px 0"><b>${f.pump_id.toUpperCase()} ${f.code}</b>
        (${f.severity}): ${f.message ?? ""} — <b>still active</b> since ${day(f.last_ts)}</li>`);
    }
  }

  const stat = (label: string, value: string, note = "") => `
    <td style="padding:12px 16px;background:#f4f5f7;border-radius:8px">
      <div style="font-size:22px;font-weight:600;color:#111">${value}</div>
      <div style="font-size:12px;color:#555;margin-top:2px">${label}${note ? ` · ${note}` : ""}</div>
    </td>`;

  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400_000);
  const range = `${day(start.getTime() / 1000)} – ${day(end.getTime() / 1000)}`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#222">
    <h2 style="margin:16px 0 2px">A2W Control — weekly</h2>
    <div style="color:#666;font-size:13px;margin-bottom:16px">${range} · 6 Black Brook Rd</div>
    <table cellspacing="8" style="border-collapse:separate;width:100%"><tr>
      ${stat("electricity", `${fmt(week.kwh, 0)} kWh`,
             week.metered_days === week.days && week.days > 0 ? "metered" : `${week.metered_days}/${week.days} days metered`)}
      ${stat("average COP", fmt(week.cop, 2),
             week.measured_days > 0 ? `measured ${week.measured_days}/${week.days} days` : "modeled")}
    </tr><tr>
      ${stat("saved this week", `$${fmt(week.saved, 2)}`, `$${fmt(totalSaved, 0)} since Jul 16`)}
      ${stat("avg outdoor", `${fmt(week.outdoor, 0)}°F`, `tank avg ${fmt(plant.tank != null ? Number(plant.tank) : null, 0)}°F`)}
    </tr></table>
    <h3 style="margin:20px 0 6px">Faults</h3>
    ${faultLines.length
      ? `<ul style="padding-left:18px;margin:0;font-size:14px">${faultLines.join("")}</ul>`
      : `<div style="font-size:14px;color:#3a7d44">No faults this week.</div>`}
    <h3 style="margin:20px 0 6px">Notes</h3>
    <ul style="padding-left:18px;margin:0;font-size:14px">
      <li style="margin:4px 0">Backup element called ${backupH > 0 ? `<b>${fmt(backupH, 1)} h</b>` : "0 h"} this week${backupH > 0 ? " — worth a look" : ""}.</li>
      <li style="margin:4px 0">Autopilot adjusted the tank target ${moves} time${moves === 1 ? "" : "s"}.</li>
      ${comm.map((c) => {
        const rising = c.drops > c.prev && c.drops >= 3;
        const errBit = c.err != null ? ` · ${fmt(Number(c.err), 1)}% comm err` : "";
        return `<li style="margin:4px 0">${c.pump_id.toUpperCase()} comm: ${c.drops} dropout${c.drops === 1 ? "" : "s"} (prev wk ${c.prev})${errBit}${rising ? " — <b>degrading, keep an eye on it</b>" : ""}.</li>`;
      }).join("")}
    </ul>
    <div style="margin:24px 0;font-size:13px">
      <a href="${DASH_URL}" style="color:#2563eb">Open the dashboard →</a>
    </div>
    <div style="color:#999;font-size:11px;border-top:1px solid #eee;padding-top:8px">
      Sent Mondays by the A2W weekly digest cron.
    </div>
  </div>`;

  const faultBit = faults.length || active.length
    ? ` · ${Math.max(faults.length, active.length)} fault${Math.max(faults.length, active.length) === 1 ? "" : "s"}`
    : "";
  const subject = `A2W weekly: $${fmt(week.saved, 2)} saved · COP ${fmt(week.cop, 2)} · ${fmt(week.kwh, 0)} kWh${faultBit}`;
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
