// @purpose Server-side proxy for the autonomy Off/Armed switch (W2-B). Forwards the dashboard's
// mode change to the planner's guarded /api/autonomy endpoint, holding PLANNER_API_TOKEN
// server-side (the browser never sees it). off → both controllers shadow (compute + log, write
// nothing); arm → both live inside the I4/I1 guardrails. The planner returns 501 for the
// not-yet-implemented set/req modes; we pass that status through. isAuthed() here; env gate, bearer,
// timeout and the 502/503/504 shapes in lib/planner-proxy.ts (shared by every planner write proxy).
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { forwardToPlanner } from "@/lib/planner-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // > DEFAULT_PLANNER_TIMEOUT_MS (lib/planner-proxy.ts), so the relay answers 504 before the platform cuts it off

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await forwardToPlanner("/api/autonomy", { method: "POST", body: await req.text() });
  return NextResponse.json(r.body, { status: r.status });
}
