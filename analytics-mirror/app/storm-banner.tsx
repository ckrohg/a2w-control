// @purpose Storm-mode banner (plan §6.11, W0-6) — server component rendered directly
// under <I1Banner /> on every analytics page. Shows the open storm_events row (an armed
// or active storm the planner is banking heat for) straight from Neon — no planner
// dependency, so the flag stays visible even if the planner service is down. Degrades
// silently: any error (table not deployed yet) or no open event renders nothing.
import { sql } from "@vercel/postgres";
import { fmtTime } from "@/lib/tz";

type StormRow = { id: number; t: number; trigger: string; ceiling_f: number | null };

export async function StormBanner() {
  try {
    const r = await sql<StormRow>`
      SELECT id, EXTRACT(EPOCH FROM started_at)::float8 AS t, trigger, ceiling_f
      FROM storm_events WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`;
    if (!r.rowCount) return null;
    const { t, trigger, ceiling_f } = r.rows[0];
    return (
      <div
        className="banner"
        style={{ background: "#3d3222", border: "1px solid #6b5a30", color: "#ffe0a3" }}
      >
        ⛈ Storm mode ARMED — {trigger} · since {fmtTime(t)}
        {ceiling_f ? ` · banking to ${ceiling_f}°F` : ""}
      </div>
    );
  } catch {
    return null; // storm_events appears with the W0-5 planner deploy — never block the page
  }
}
