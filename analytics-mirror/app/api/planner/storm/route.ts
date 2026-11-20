// @purpose Server-side proxy to the planner's storm-mode API (GET status / POST
// arm|disarm). Cookie-gated by middleware + isAuthed() defense-in-depth, same pattern
// as the /api/planner/target proxy — PLANNER_API_TOKEN never reaches the browser. GET
// returns just the planner's /health `storm` field (lib/planner-health.ts, shared with the
// storm banner so both read the same authority, #183); POST validates {action: "arm"|"disarm",
// hours?} (400) and relays it to /api/storm/arm or /api/storm/disarm through lib/planner-proxy.ts
// (env gate, bearer, timeout, 502/503/504 shapes shared with the other write proxies).
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { fetchPlannerStorm } from "@/lib/planner-health";
import { forwardToPlanner } from "@/lib/planner-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // > DEFAULT_PLANNER_TIMEOUT_MS (lib/planner-proxy.ts), so the relay answers 504 before the platform cuts it off
export const fetchCache = "force-no-store";

export async function GET() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { storm, status, error } = await fetchPlannerStorm();
  if (storm) return NextResponse.json({ storm });
  return NextResponse.json({ error }, { status });
}

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let action: unknown, hours: unknown;
  try {
    const body = await req.json();
    action = body?.action;
    hours = body?.hours;
  } catch { /* falls through to the action check */ }
  if (action !== "arm" && action !== "disarm") {
    return NextResponse.json({ error: 'action must be "arm" or "disarm"' }, { status: 400 });
  }
  const r = await forwardToPlanner(`/api/storm/${action}`, {
    method: "POST",
    body: JSON.stringify(action === "arm" ? { hours: Number(hours) || 24 } : {}),
  });
  return NextResponse.json(r.body, { status: r.status });
}
