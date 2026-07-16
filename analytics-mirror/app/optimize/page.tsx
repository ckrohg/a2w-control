// @purpose Server wrapper for the Plan page (route /optimize) — today's hour-by-hour planner
// schedule + the REAL autonomy state. Renders the shared I1 conflict banner and reads, server-side
// from Neon: the latest shadow_plans row (24 ShadowBlocks + computed_at) AND the planner's
// controller_status heartbeat (the actual auto-pilot + Phase B flags), so the client shows
// ground-truth autonomy instead of hardcoded copy that can drift. The client draws the timeline,
// previews the autonomy modes + Boost (preview only), and keeps the guarded 131°F rec + Restore.
import { sql } from "@vercel/postgres";
import { I1Banner } from "../i1-banner";
import OptimizeClient, { type ShadowBlock, type Autonomy } from "./optimize-client";

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

  // Real controller state from the planner's heartbeat. Own try/catch — controller_status isn't
  // created until the planner deploys + runs ensureSchema, and a missing table must not break the
  // page. ageMin is computed server-side so the "N min ago" text can't cause a hydration mismatch.
  let autonomy: Autonomy = null;
  try {
    const cs = await sql<{
      t: number; ae: boolean; adr: boolean; ares: string | null; atf: number | null;
      pe: boolean; pdr: boolean; pres: string | null;
    }>`SELECT EXTRACT(EPOCH FROM updated_at)::float8 AS t,
              autopilot_enabled AS ae, autopilot_dry_run AS adr, autopilot_result AS ares, autopilot_target_f AS atf,
              phaseb_enabled AS pe, phaseb_dry_run AS pdr, phaseb_result AS pres
       FROM controller_status WHERE id = 1`;
    if (cs.rowCount) {
      const r = cs.rows[0];
      const ageMin = Math.round(Date.now() / 1000 / 60 - r.t / 60);
      autonomy = {
        reporting: ageMin < 15,
        ageMin,
        autopilot: { enabled: r.ae, dryRun: r.adr, result: r.ares, targetF: r.atf },
        phaseb: { enabled: r.pe, dryRun: r.pdr, result: r.pres },
      };
    }
  } catch {
    /* controller_status not created yet — the client shows a graceful "no report yet" state */
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
      <OptimizeClient
        rate={RATE}
        dailyKwh={DAILY_KWH}
        blocks={blocks}
        computedAt={computedAt}
        autonomy={autonomy}
      />
    </>
  );
}
