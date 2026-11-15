// @purpose Server-side proxy to the planner's HBX restore endpoint — returns the plant to the
// planner's current curve (a2w#232; the as-found curve only when no plan is being commanded, or
// on an explicit {"to":"as-found"} body, passed through). Never rate-limited planner-side.
// Cookie-gated + isAuthed() like every control proxy; env gate, bearer, timeout and the
// 502/503/504 shapes in lib/planner-proxy.ts. An empty body is sent as no body (no Content-Type).
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { forwardToPlanner } from "@/lib/planner-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // > DEFAULT_PLANNER_TIMEOUT_MS (lib/planner-proxy.ts), so the relay answers 504 before the platform cuts it off

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.text().catch(() => "");
  const r = await forwardToPlanner("/api/hbx/restore", { method: "POST", body: body || undefined });
  return NextResponse.json(r.body, { status: r.status });
}
