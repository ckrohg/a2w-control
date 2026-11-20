// @purpose Server-side proxy to the planner's guarded HBX write API (GET status /
// POST set-target). Cookie-gated by middleware + isAuthed() defense-in-depth (same
// pattern as the hub proxies) — PLANNER_API_TOKEN never reaches the browser. The
// planner enforces the real guardrails (I4 envelope, I1 cross-check, rate limit,
// read-back, audit); this route only relays (env gate, bearer, timeout and the 502/503/504 shapes
// in lib/planner-proxy.ts) — plus, on GET with a boost on record, a read-only
// `boost_superseded_by` from the shared DB (#186; lib/db.ts boostSupersededBy).
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { boostSupersededBy } from "@/lib/db";
import { forwardToPlanner } from "@/lib/planner-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // > DEFAULT_PLANNER_TIMEOUT_MS (lib/planner-proxy.ts), so the relay answers 504 before the platform cuts it off

export async function GET() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await forwardToPlanner("/api/hbx/target", { method: "GET" });
  const ok = r.status >= 200 && r.status < 300;
  const body = r.body as Record<string, unknown> | null;
  if (!ok || !body || typeof body !== "object") return NextResponse.json(body ?? {}, { status: r.status });
  // #186: with a boost on record, say whether the curve has been written over since (shared DB, read
  // only). Absent = could not tell (the client falls back to the curve check); null = not superseded.
  if (body.active_boost) {
    try { body.boost_superseded_by = await boostSupersededBy(); } catch { /* tables missing / DB down */ }
  }
  return NextResponse.json(body, { status: r.status });
}

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const r = await forwardToPlanner("/api/hbx/target", { method: "POST", body: await req.text() });
  return NextResponse.json(r.body, { status: r.status });
}
