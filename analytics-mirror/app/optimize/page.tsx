// @purpose Server wrapper for the Optimize page — the interim, guided savings surface.
// Renders the shared I1 conflict banner (server component, Neon query) above the
// client-side OptimizeClient, which polls /api/planner/target and drives the single
// guarded "set tank target to 131°F" apply through the same planner guardrails the
// Control page's HbxTargetCard uses.
import { I1Banner } from "../i1-banner";
import OptimizeClient from "./optimize-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store"; // the I1 banner's queries are parameterless (see home page note)

// Read the $ constants server-side (same env the Savings page uses) and pass them down, so the
// estimate tracks a non-default prod rate/baseline instead of the client's compiled-in defaults.
const RATE = Number(process.env.ELECTRIC_RATE_USD_KWH ?? "0.30");
const DAILY_KWH = Number(process.env.DAILY_KWH_BASELINE ?? "11.8");

export default function OptimizePage() {
  return (
    <>
      <I1Banner />
      <header>
        <h1>Optimize</h1>
        <p className="dim">
          The interim, guided savings surface — one caution-first, fully reversible
          summer setting that runs the tank cooler for a higher COP.
        </p>
      </header>
      <OptimizeClient rate={RATE} dailyKwh={DAILY_KWH} />
    </>
  );
}
