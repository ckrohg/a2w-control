// @purpose Server-side proxy to the planner's timed-boost endpoint — a fixed tank target
// with a DURABLE auto-restore (survives planner restarts). Used for the I8 sanitize soak
// and A/B protocol charges. isAuthed() here; env gate, bearer, timeout and the 502/503/504
// shapes in lib/planner-proxy.ts (shared by every planner write proxy). The planner's status
// passes through untouched — 202 is the arming acknowledgement the dashboard waits on.
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { forwardToPlanner } from "@/lib/planner-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // > DEFAULT_PLANNER_TIMEOUT_MS (lib/planner-proxy.ts), so the relay answers 504 before the platform cuts it off

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await forwardToPlanner("/api/hbx/boost", { method: "POST", body: await req.text() });
  return NextResponse.json(r.body, { status: r.status });
}
