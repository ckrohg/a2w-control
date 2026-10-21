// @purpose The weekly digest's "Alerts & events" block (owner alert policy, knowledge/reference/alert-policy.md,
// 2026-10-20). Real-time notifications now reach the owner only for pages (phone + email) and attention items
// (email); everything else is RECORDED. This block is where the record tier surfaces: what reached the owner, and
// what A2W noticed and handled without bothering them, grouped so a repeating pattern stands out.

export type AlertRow = {
  tier: "page" | "attention" | "record" | string;
  resolved: boolean;
  title: string;
  ts: number; // epoch seconds
};

export type AlertSummary = {
  pages: number;
  emails: number;
  recorded: number;
  /** page + attention opens, newest first */
  reached: { tier: string; title: string; ts: number }[];
  /** record-tier opens grouped by title shape, most frequent first */
  patterns: { title: string; n: number }[];
};

/** Numbers vary between repeats of the same alert ("offline 12 min" / "offline 47 min"): group on the shape. */
export const titleShape = (t: string) =>
  t.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim();

export function summarizeAlerts(rows: AlertRow[]): AlertSummary {
  const opens = rows.filter((r) => !r.resolved);
  const reached = opens.filter((r) => r.tier === "page" || r.tier === "attention")
    .sort((a, b) => b.ts - a.ts)
    .map((r) => ({ tier: r.tier, title: r.title, ts: r.ts }));
  const counts = new Map<string, number>();
  for (const r of opens) if (r.tier === "record") counts.set(titleShape(r.title), (counts.get(titleShape(r.title)) ?? 0) + 1);
  const patterns = [...counts.entries()].map(([title, n]) => ({ title, n }))
    .sort((a, b) => b.n - a.n || a.title.localeCompare(b.title));
  return {
    pages: opens.filter((r) => r.tier === "page").length,
    emails: reached.length,
    recorded: opens.filter((r) => r.tier === "record").length,
    reached,
    patterns,
  };
}

export function alertsHeadline(s: AlertSummary): string {
  if (!s.emails && !s.recorded) return "Nothing needed you this week, and nothing unusual was recorded.";
  const told = s.emails === 0 ? "Nothing needed you this week"
    : `A2W contacted you ${s.emails} time${s.emails === 1 ? "" : "s"}${s.pages ? ` (${s.pages} urgent)` : ""}`;
  return `${told}; ${s.recorded} other event${s.recorded === 1 ? "" : "s"} recorded and handled.`;
}
