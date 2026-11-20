// @purpose Server-side proxy for the identification-driver mode (off | shadow | armed). Forwards the
// dashboard's choice to the planner's guarded /api/identification, holding PLANNER_API_TOKEN
// server-side (the browser never sees it). Independent of the Off/Armed autonomy mode: it flips
// controller_flags.identification_mode, which governs whether identify.ts draws and writes randomised
// supply-water probes (gtm#1616 / #137). isAuthed() here; env gate, bearer, timeout and the
// 502/503/504 shapes in lib/planner-proxy.ts (shared by every planner write proxy).
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { forwardToPlanner } from "@/lib/planner-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // > DEFAULT_PLANNER_TIMEOUT_MS (lib/planner-proxy.ts), so the relay answers 504 before the platform cuts it off

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await forwardToPlanner("/api/identification", { method: "POST", body: await req.text() });
  return NextResponse.json(r.body, { status: r.status });
}
