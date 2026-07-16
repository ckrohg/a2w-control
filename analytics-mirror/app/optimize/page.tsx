// @purpose Server wrapper for the Plan page (route still /optimize) — today's hour-by-hour
// planner schedule + an autonomy preview. Renders the shared I1 conflict banner (server
// component, Neon query) and reads the latest shadow_plans row server-side (same query the
// Curve page uses), passing the 24 ShadowBlocks + computed_at down to the client PlanClient.
// The client draws the timeline canvas, previews the autonomy modes and Boost (NONE of which
// execute — Phase B is off and the HBX write path is a no-op), and keeps the old guarded
// 131°F summer recommendation + Restore in a compact card at the bottom (apply stays DISABLED).
import { sql } from "@vercel/postgres";
import { I1Banner } from "../i1-banner";
import OptimizeClient, { type ShadowBlock } from "./optimize-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store"; // the I1 banner's queries are parameterless (see home page note)

// Read the $ constants server-side (same env the Savings page uses) and pass them down, so the
// estimate tracks a non-default prod rate/baseline instead of the client's compiled-in defaults.
const RATE = Number(process.env.ELECTRIC_RATE_USD_KWH ?? "0.30");
const DAILY_KWH = Number(process.env.DAILY_KWH_BASELINE ?? "11.8");

export default async function OptimizePage() {
  // Latest plan, same pattern as curve/page.tsx — wrapped so the page still renders if Neon is down.
  let blocks: ShadowBlock[] = [];
  let computedAt: number | null = null;
  try {
    const sp = await sql`SELECT plan, EXTRACT(EPOCH FROM computed_at)::float8 AS t FROM shadow_plans ORDER BY id DESC LIMIT 1`;
    if (sp.rowCount) {
      blocks = sp.rows[0].plan as ShadowBlock[];
      computedAt = sp.rows[0].t as number;
    }
  } catch {
    /* page still renders without Neon — the client shows a graceful empty chart state */
  }

  return (
    <>
      <I1Banner />
      <header>
        <h1>Plan</h1>
        <p className="dim">
          Today&apos;s plan, hour by hour — what the planner wants each hour, and how much
          autonomy you grant it, from just watching to fully hands-off.
        </p>
      </header>
      <OptimizeClient rate={RATE} dailyKwh={DAILY_KWH} blocks={blocks} computedAt={computedAt} />
    </>
  );
}
