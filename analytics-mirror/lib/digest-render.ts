// @purpose The weekly digest's pure rendering (app/api/digest/route.ts keeps the SQL and fetches): number formatting,
// the week-over-week delta chip, the one-sentence headline, the fault list and the subject line. Every string that
// comes from the database or the Pi goes through esc before it reaches the email HTML — fault messages are written by
// the bridge from pump payloads, and a `<` or `&` in one must render as text, not markup.
import { esc } from "./pi-tile";

// Email-safe palette (light surface committed — email clients force their own dark
// transforms; near-black ink + one validated series hue survive them best).
export const INK = "#0b0b0b", INK2 = "#52514e", MUTED = "#9b9a94";
// SERIES is mark-grade (bars, links; ≥3:1 on white, validated). GOOD/BAD are darkened
// text-grade steps of the status hues — the palette's mark-grade status colors don't
// clear small-text contrast on white.
export const SERIES = "#2a78d6", GOOD = "#067806", BAD = "#b3261e";
export const TILE_BG = "#f4f5f7", RULE = "#e8e7e3";

export type FaultRow = {
  pump_id: string; code: string; severity: string; message: string | null;
  n: number; last_ts: number;
};

export const fmt = (v: number | null | undefined, digits = 1) =>
  v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(digits);

export const day = (epoch: number) =>
  new Date(epoch * 1000).toLocaleDateString("en-US", {
    month: "short", day: "numeric", timeZone: "America/New_York",
  });

/** Week-over-week delta chip. goodWhen says which direction is a win — the color follows
 *  the BENEFIT, the glyph carries the direction, so neither is color-alone. */
export function delta(cur: number | null, prev: number | null | undefined, goodWhen: "up" | "down"): string {
  if (cur == null || prev == null || !isFinite(prev) || Math.abs(prev) < 1e-9) return "";
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  if (!isFinite(pct) || Math.abs(pct) < 0.5) return `<span style="color:${INK2}">· flat vs last wk</span>`;
  const up = pct > 0;
  const win = (up && goodWhen === "up") || (!up && goodWhen === "down");
  const glyph = up ? "▲" : "▼";
  return `<span style="color:${win ? GOOD : BAD}">${glyph} ${Math.abs(pct).toFixed(0)}%</span>` +
         `<span style="color:${INK2}"> vs last wk</span>`;
}

export type HeadlineInput = {
  activeFaults: number;
  /** share of the week's binding-zone samples with the floor at the 135°F cap (0–1) */
  pegShare: number;
  lastZone: string | null | undefined;
  backupH: number;
  backupKwh: number;
  curSaved: number;
  prevSaved: number | null | undefined;
};

/** One sentence, most important thing first: active faults > floor pegged ≥ 25% > backup > 1 h >
 *  week-over-week savings > a quiet week. */
export function headline(h: HeadlineInput): string {
  if (h.activeFaults) {
    return `⚠ ${h.activeFaults} fault${h.activeFaults === 1 ? "" : "s"} currently active — see below.`;
  }
  if (h.pegShare >= 0.25) {
    // A floor pinned at the everyday cap is the week's most important fact: it means the
    // house is asking for more than the cap allows, so we are either giving up the winter
    // savings or under-heating, and only real cold tells us which (#89).
    return `The demand floor sat at the 135°F cap ${(h.pegShare * 100).toFixed(0)}% of the week` +
      `${h.lastZone ? ` (binding zone: ${esc(h.lastZone)})` : ""} — the sizing question (#89) is live.`;
  }
  if (h.backupH > 1) {
    return `The backup element ran ${fmt(h.backupH, 1)} h this week (~${fmt(h.backupKwh, 0)} kWh at COP 1) — worth a look.`;
  }
  if (h.prevSaved != null && h.prevSaved > 0.5) {
    const d = ((h.curSaved - h.prevSaved) / h.prevSaved) * 100;
    return d >= 0
      ? `Saved $${fmt(h.curSaved, 2)} — up ${d.toFixed(0)}% on last week. No active faults.`
      : `Saved $${fmt(h.curSaved, 2)} — down ${Math.abs(d).toFixed(0)}% on last week (weather-dependent). No active faults.`;
  }
  return `A quiet week: $${fmt(h.curSaved, 2)} saved, no active faults.`;
}

/** The Faults list: this week's fault_on groups, each marked still active or cleared, then any fault that is
 *  active now but did not fire this week (it went on earlier and never cleared). */
export function faultLines(faults: FaultRow[], active: FaultRow[]): string[] {
  const activeKeys = new Set(active.map((f) => `${f.pump_id}:${f.code}`));
  const head = (f: FaultRow) =>
    `<b>${esc(String(f.pump_id).toUpperCase())} ${esc(String(f.code))}</b>`;
  const lines = faults.map((f) => {
    const still = activeKeys.has(`${f.pump_id}:${f.code}`)
      ? ` — <b style="color:${BAD}">still active</b>` : " — cleared";
    const times = f.n > 1 ? ` (×${f.n} this week)` : "";
    return `<li style="margin:4px 0">${head(f)}
      (${esc(String(f.severity))}): ${esc(f.message ?? "")}${times}, last ${day(f.last_ts)}${still}</li>`;
  });
  for (const f of active) {
    if (!faults.some((w) => w.pump_id === f.pump_id && w.code === f.code)) {
      lines.push(`<li style="margin:4px 0">${head(f)}
        (${esc(String(f.severity))}): ${esc(f.message ?? "")} — <b style="color:${BAD}">still active</b> since ${day(f.last_ts)}</li>`);
    }
  }
  return lines;
}

/** Plain-text subject (not HTML — nothing here is escaped, and only numbers go in). */
export function subjectLine(s: {
  curSaved: number; prevSaved: number | null | undefined; cop: number | null; kwh: number; activeFaults: number;
}): string {
  const faultBit = s.activeFaults ? ` · ${s.activeFaults} active fault${s.activeFaults === 1 ? "" : "s"}` : "";
  const deltaBit = s.prevSaved != null && s.prevSaved > 0.5
    ? ` (${s.curSaved >= s.prevSaved ? "▲" : "▼"}${Math.abs(((s.curSaved - s.prevSaved) / s.prevSaved) * 100).toFixed(0)}%)` : "";
  return `A2W weekly: $${fmt(s.curSaved, 2)} saved${deltaBit} · COP ${fmt(s.cop, 2)} · ${fmt(s.kwh, 0)} kWh${faultBit}`;
}
