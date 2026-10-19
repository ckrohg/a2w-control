// @purpose #165: validate the two /health bodies the weekly digest's Pi-link tile renders (planner /health.pi and the
// hub's /health dropout counters, #178) into plain finite numbers before any of it reaches HTML. Both endpoints are
// external to the digest: a malformed, partial or hostile body must render as "unavailable", never throw (and fail
// the whole digest) or inject markup (codex pass 1 on #193).

export interface PiTile {
  count: number;
  longestMin: number | null;
  gapReboot: number;
  gapOnly: number;
  socketOnly: number;
  unknown: number;
  reboots7d: number | null;
}

export interface HubTile {
  d7: number;
  d24: number;
  longest24Min: number | null;
  /** ISO, re-serialised from a parsed date (never the raw string) */
  since: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number | null => { const n = num(v); return n != null && n >= 0 && Number.isInteger(n) ? n : null; };

/** planner /health → the tile's numbers, or null when the `pi` block is missing or malformed. */
export function normalizePi(health: unknown): PiTile | null {
  const pi = (health as { pi?: unknown } | null)?.pi as Record<string, any> | undefined;
  const sum = pi && typeof pi === "object" ? pi.summary : null;
  const v = sum && typeof sum === "object" ? sum.verdicts : null;
  if (!sum || !v || typeof v !== "object") return null;
  const c = count(sum.count), gr = count(v["gap+reboot"]), go = count(v.gap_only), so = count(v.socket_only);
  if (c == null || gr == null || go == null || so == null) return null;
  return {
    count: c, longestMin: num(sum.longest_min), gapReboot: gr, gapOnly: go, socketOnly: so,
    unknown: count(v.unknown) ?? 0, reboots7d: count(pi!.reboots_7d),
  };
}

/** hub /health → its dropout counters, or null when they are absent (a hub before #178) or malformed. */
export function normalizeHub(health: unknown): HubTile | null {
  const h = health as Record<string, unknown> | null;
  if (!h || typeof h !== "object") return null;
  const d7 = count(h.pi_dropouts_7d), d24 = count(h.pi_dropouts_24h);
  if (d7 == null || d24 == null) return null;
  const t = typeof h.tracking_since === "string" ? Date.parse(h.tracking_since) : NaN;
  return { d7, d24, longest24Min: num(h.longest_dropout_min), since: Number.isFinite(t) ? new Date(t).toISOString() : null };
}

/** HTML-escape for anything textual that still has to be shown. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
