/**
 * @purpose The HTML for every A2W alert email (owner, 2026-10-20: "really hard to skim"). hub/src/alertemail.ts is a
 * byte-for-byte copy — change both. One layout, read top to
 * bottom on a phone in five seconds:
 *
 *   tier banner     how urgent, in words (and colour, never colour alone)
 *   headline        the title, large
 *   What to do      the action, boxed, when a human has one
 *   facts           a short label/value table
 *   details         the technical body, small and grey, last
 *   footer          when, which part of A2W, why this reached you
 *
 * Email-safe: tables and inline styles only, light surface (mail clients apply their own dark transforms), no
 * external assets. The plain-text body is always sent alongside.
 */
/** Same union as alertpolicy.ts; declared here so hub/src/alertemail.ts can be an exact copy of this file. */
export type Tier = "page" | "attention" | "record";

export const C = {
  ink: "#0b0b0b", ink2: "#52514e", muted: "#8a8984", rule: "#e8e7e3", tile: "#f4f5f7", link: "#2a78d6",
  page: { fg: "#ffffff", bg: "#b3261e" },
  attention: { fg: "#6b4400", bg: "#fff1d6" },
  resolved: { fg: "#055c05", bg: "#e6f4e6" },
  info: { fg: "#33322f", bg: "#eeeeec" },
};

export const DASH_URL = "https://a2w-analytics-mirror.vercel.app";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text → paragraphs; single newlines kept as line breaks. */
export function paragraphs(text: string, style: string): string {
  return text.trim().split(/\n{2,}/).filter(Boolean)
    .map((p) => `<p style="margin:0 0 10px;${style}">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
}

function banner(tier: Tier, resolved: boolean): { label: string; fg: string; bg: string } {
  if (resolved) return { label: "✅ RESOLVED · no action needed", ...C.resolved };
  if (tier === "page") return { label: "🚨 URGENT · act now", ...C.page };
  if (tier === "attention") return { label: "NEEDS A LOOK · this week", ...C.attention };
  return { label: "FYI", ...C.info };
}

const WHY: Record<Tier, string> = {
  page: "You got this because the house may lose heat or hot water, or something needs a hand at the panel.",
  attention: "You got this because something should be looked at this week. Nothing is wrong right now.",
  record: "Informational.",
};

export interface AlertEmail {
  tier: Tier;
  resolved?: boolean;
  title: string;
  /** the technical detail (the plain-text body) */
  body: string;
  /** what the owner should do, in one or two sentences */
  action?: string;
  facts?: [string, string][];
  source: string;
  at?: Date;
}

/** Strip the emoji/✓/⚠ prefixes and the "A2W:" label the ntfy titles carry. */
export const cleanTitle = (t: string) =>
  t.trim().replace(/^[\u26A0\u2705\u2713\u{1F6A8}\uFE0F\s]+/u, "").replace(/^\s*A2W\s*[:—-]\s*/i, "").trim() || t.trim();

export function shell(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"></head>` +
    `<body style="margin:0;padding:0;background:#ffffff">` +
    `<div style="max-width:560px;margin:0 auto;padding:12px 14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${C.ink}">` +
    inner + `</div></body></html>`;
}

export function factsTable(facts: [string, string][]): string {
  if (!facts.length) return "";
  const rows = facts.map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;color:${C.ink2};font-size:14px;white-space:nowrap;vertical-align:top;border-bottom:1px solid ${C.rule}">${esc(k)}</td>` +
    `<td style="padding:6px 0;font-size:15px;font-weight:600;vertical-align:top;border-bottom:1px solid ${C.rule}">${esc(v)}</td></tr>`).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;margin:0 0 16px">${rows}</table>`;
}

export function footer(source: string, at: Date, why: string): string {
  const when = at.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `<div style="border-top:1px solid ${C.rule};margin-top:18px;padding-top:10px;font-size:12px;line-height:1.5;color:${C.muted}">` +
    `${esc(when)} ET · ${esc(source)} · <a href="${DASH_URL}" style="color:${C.link}">Dashboard</a><br>${esc(why)} ` +
    `Everything else is in the Monday digest.</div>`;
}

export function renderAlertEmail(e: AlertEmail): string {
  const b = banner(e.tier, !!e.resolved);
  const at = e.at ?? new Date();
  const action = e.action && !e.resolved
    ? `<div style="border-left:4px solid ${e.tier === "page" ? C.page.bg : "#c98a00"};background:${C.tile};padding:10px 12px;margin:0 0 16px;border-radius:0 6px 6px 0">` +
      `<div style="font-size:12px;font-weight:700;letter-spacing:.04em;color:${C.ink2};margin-bottom:3px">WHAT TO DO</div>` +
      `<div style="font-size:16px;line-height:1.4">${esc(e.action)}</div></div>`
    : "";
  const details = e.body.trim()
    ? `<div style="font-size:12px;font-weight:700;letter-spacing:.04em;color:${C.muted};margin:0 0 4px">DETAILS</div>` +
      paragraphs(e.body, `font-size:13px;line-height:1.45;color:${C.ink2}`)
    : "";
  return shell(
    `<div style="display:inline-block;background:${b.bg};color:${b.fg};font-size:12px;font-weight:700;letter-spacing:.04em;padding:5px 9px;border-radius:4px;margin:4px 0 10px">${esc(b.label)}</div>` +
    `<h1 style="font-size:21px;line-height:1.25;margin:0 0 14px;font-weight:700">${esc(cleanTitle(e.title))}</h1>` +
    action + factsTable(e.facts ?? []) + details +
    footer(e.source, at, e.resolved ? "This closes an alert you were sent earlier." : WHY[e.tier]));
}
