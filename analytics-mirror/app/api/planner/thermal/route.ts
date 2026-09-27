// @purpose Server-side proxy for the planner's /health.thermal block (tank °F, target, outdoor,
// tank_ua, dhw_floor_f, coast_h) — live since #120. Same cookie-gated pattern as /api/planner/storm;
// PLANNER_API_TOKEN never reaches the browser. Read-only. Used by the Control page's custom Boost
// to project "≈ N h of coast above the DHW floor" for a chosen target (#126).
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
    });
    const out: { thermal?: unknown } = await res.json().catch(() => ({}));
    if (out.thermal != null) return NextResponse.json({ thermal: out.thermal });
    return NextResponse.json({ error: `planner health gave no thermal block (${res.status})` }, { status: 502 });
  } catch (e) {
    return NextResponse.json({ error: "planner unreachable", detail: String(e) }, { status: 502 });
  }
}
