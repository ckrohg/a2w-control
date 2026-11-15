// @purpose Server-side proxy for the I8 auto-sanitize toggle. Forwards the dashboard's on/off to the
// planner's guarded /api/sanitize endpoint, holding PLANNER_API_TOKEN server-side (the browser never
// sees it). Independent of the Off/Armed mode: it flips auto_sanitize in controller_flags, which
// governs whether checkI8 auto-fires the daily soak. isAuthed() here; env gate, bearer, timeout and
// the 502/503/504 shapes in lib/planner-proxy.ts (shared by every planner write proxy).
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { forwardToPlanner } from "@/lib/planner-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // > DEFAULT_PLANNER_TIMEOUT_MS (lib/planner-proxy.ts), so the relay answers 504 before the platform cuts it off

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await forwardToPlanner("/api/sanitize", { method: "POST", body: await req.text() });
  return NextResponse.json(r.body, { status: r.status });
}
