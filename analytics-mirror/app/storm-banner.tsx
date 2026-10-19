// @purpose Storm-mode banner (plan §6.11, W0-6; #183) — server component rendered directly under
// <I1Banner /> on every analytics page. Driven by the planner's /health.storm (lib/planner-health),
// NOT by storm_events: rows there are orphaned open by planner restarts, which kept "Storm mode armed
// since 08:33 AM" on screen for three weeks while the planner was idle. Hidden when idle or when the
// planner can't be read; "notify-only" when STORM_MODE_ENABLED is off. The newest open storm_events
// row supplies only the start date (and ceiling) of the live episode — see lib/storm-state.ts.
import { sql } from "@/lib/sql";
import { fetchPlannerStorm } from "@/lib/planner-health";
import { stormBanner, type OpenStormRow } from "@/lib/storm-state";

export async function StormBanner() {
  const { storm } = await fetchPlannerStorm();
  if (!storm || storm.state === "idle") return null;
  let row: OpenStormRow | null = null;
  try {
    const r = await sql<OpenStormRow>`
      SELECT EXTRACT(EPOCH FROM started_at)::float8 AS t, trigger, ceiling_f
      FROM storm_events WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`;
    row = r.rowCount ? r.rows[0] : null;
  } catch { /* no start date then — the banner still shows */ }
  const b = stormBanner(storm, row, Date.now());
  if (!b.show) return null;
  return (
    <div
      className="banner"
      style={b.notifyOnly
        ? { background: "#2a2f36", border: "1px solid #4a5260", color: "#d6dde6" }
        : { background: "#3d3222", border: "1px solid #6b5a30", color: "#ffe0a3" }}
    >
      ⛈ <b>{b.text}</b>
    </div>
  );
}
