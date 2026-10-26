// @purpose Server-side proxy for the planner's /health, reduced to what the Optimize Boost card's post-boost
// coast projection (lib/tank-coast.ts) needs: the `thermal` block (tank_f, dhw_floor_f, tank_ua, at); the Phase B
// `lead` (phaseb.ts lastLead — plan_f is what the auto-pilot COMMANDS for the block in force, stale-report aware,
// and is the coast's end point; operative_f / operative_basis ride along for the record, they are NOT used as the
// end point); and the plan curve's output at the live outdoor (curve.plan_implies), the fallback when there is no
// plan lead. One /health read for all three. Cookie-gated like /api/planner/storm; PLANNER_API_TOKEN never reaches
// the browser. Read-only.
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type Health = {
  thermal?: unknown;
  // "disabled" when Phase B is off, else the block with `lead` (null before the first cycle)
  phase_b?: { lead?: Record<string, unknown> | null } | string | null;
  curve?: { plan_implies?: { output_at_live_outdoor_f?: unknown } | null } | null;
};

export async function GET() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const base = process.env.PLANNER_URL;
  const token = process.env.PLANNER_API_TOKEN;
  if (!base || !token) return NextResponse.json({ error: "planner not configured" }, { status: 503 });
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    // /health goes 503 when polls are failing, but the thermal block (with its `at`) is still what it is.
    const out: Health = await res.json().catch(() => ({}));
    if (out.thermal == null) {
      return NextResponse.json({ error: `planner health gave no thermal block (${res.status})` }, { status: 502 });
    }
    const pb = out.phase_b;
    const l = pb && typeof pb === "object" && pb.lead && typeof pb.lead === "object" ? pb.lead : null;
    const lead = l
      ? { at: l.at ?? null, plan_f: l.plan_f ?? null, plan_basis: l.plan_basis ?? null,
          operative_f: l.operative_f ?? null, operative_basis: l.operative_basis ?? null }
      : null;
    const plan_implies_f = out.curve?.plan_implies?.output_at_live_outdoor_f ?? null;
    return NextResponse.json({ thermal: out.thermal, lead, plan_implies_f });
  } catch (e) {
    return NextResponse.json({ error: "planner unreachable", detail: String(e) }, { status: 502 });
  }
}
