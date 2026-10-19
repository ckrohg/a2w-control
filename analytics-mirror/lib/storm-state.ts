// @purpose Pure state mapping for the storm banner and the Tank page's storm-event rows (#183, mirror
// half). The planner's /health.storm is the ONLY authority on whether storm mode is on: storm_events
// rows can be left open forever by a planner restart (index.ts stormEvaluate closes only max(id), and
// only on an in-memory transition), which is how the banner said "armed since 08:33 AM" for three
// weeks while the planner was idle. The table is used only for the start date of the CURRENT episode.
// No "@/" imports so scripts/test-*.ts can run it under tsx.

/** planner index.ts /health → storm. `startedAt` is optional so a later planner field is preferred. */
export type HealthStorm = {
  state: "idle" | "armed" | "active" | string;
  trigger: string | null;
  windowEnd: string | null;
  enabled: boolean;
  startedAt?: string | null;
};

export type OpenStormRow = { t: number; trigger: string; ceiling_f: number | null };

const ROW_MAX_AGE_MS = 4 * 86400_000;

export type StormBanner =
  | { show: false }
  | { show: true; notifyOnly: boolean; text: string };

function fmtDT(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

/**
 * Banner from /health.storm. Hidden when idle, and hidden when the planner can't be read (a stale
 * table row is exactly what this replaces — and a planner that is down is not banking heat).
 */
export function stormBanner(storm: HealthStorm | null, newestOpenRow: OpenStormRow | null, nowMs: number): StormBanner {
  if (!storm || storm.state === "idle" || (storm.state !== "armed" && storm.state !== "active")) return { show: false };
  // The newest open row is this episode's only if it matches the live trigger and is recent (a manual
  // arm is ≤ 72 h; 4 d covers an auto window) — otherwise it is an orphan and its date would lie.
  const openRow = newestOpenRow && (storm.trigger == null || newestOpenRow.trigger === storm.trigger)
    && nowMs - newestOpenRow.t * 1000 <= ROW_MAX_AGE_MS ? newestOpenRow : null;
  const trigger = storm.trigger ?? openRow?.trigger ?? "a storm";
  const startMs = storm.startedAt ? Date.parse(storm.startedAt) : openRow ? openRow.t * 1000 : NaN;
  const since = Number.isFinite(startMs) ? ` · since ${fmtDT(startMs)}` : "";
  const endMs = storm.windowEnd ? Date.parse(storm.windowEnd) : NaN;
  const until = Number.isFinite(endMs) ? ` · window ends ${fmtDT(endMs)}` : "";
  const word = storm.state === "active" ? "active" : "armed";
  if (!storm.enabled) {
    return {
      show: true,
      notifyOnly: true,
      text: `Storm watch ${word} (notify-only) — ${trigger}${since}${until}. Storm shaping is off (STORM_MODE_ENABLED), so the plan is NOT banking extra heat.`,
    };
  }
  const ceiling = openRow?.ceiling_f ? ` · up to ${Math.round(openRow.ceiling_f)} °F` : "";
  return { show: true, notifyOnly: false, text: `Storm mode ${word} — banking heat ahead of ${trigger}${since}${until}${ceiling}` };
}

/** Tank page row label for a storm_events row: closed rows show duration; open ones say whether the planner agrees. */
export function stormRowStatus(row: { s: number; e: number | null }, storm: HealthStorm | null): string {
  if (row.e != null) return `${((row.e - row.s) / 3600).toFixed(1)} h`;
  if (storm == null) return "open (planner state unknown)";
  if (storm.state === "idle") return "open (planner idle)";
  return `open (planner ${storm.state})`;
}
