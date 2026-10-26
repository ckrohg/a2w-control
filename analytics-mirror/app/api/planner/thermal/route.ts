// @purpose Server-side proxy for the planner's /health.thermal block (tank_f, dhw_floor_f, tank_ua, at).
// Cookie-gated like /api/planner/storm; PLANNER_API_TOKEN never reaches the browser. Read-only. Feeds the
// Optimize Boost card's post-boost coast projection (lib/tank-coast.ts).
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

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
    const out: { thermal?: unknown } = await res.json().catch(() => ({}));
    if (out.thermal != null) return NextResponse.json({ thermal: out.thermal });
    return NextResponse.json({ error: `planner health gave no thermal block (${res.status})` }, { status: 502 });
  } catch (e) {
    return NextResponse.json({ error: "planner unreachable", detail: String(e) }, { status: 502 });
  }
}
