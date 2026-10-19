// @purpose Server-side proxy to the planner's storm-mode API (GET status / POST
// arm|disarm). Cookie-gated by middleware + isAuthed() defense-in-depth, same pattern
// as the /api/planner/target proxy — PLANNER_API_TOKEN never reaches the browser. GET
// returns just the planner's /health `storm` field (lib/planner-health.ts, shared with the
// storm banner so both read the same authority, #183); POST relays
// {action: "arm"|"disarm", hours?} to /api/storm/arm or /api/storm/disarm.
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { fetchPlannerStorm } from "@/lib/planner-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

function plannerEnv() {
  const base = process.env.PLANNER_URL;
  const token = process.env.PLANNER_API_TOKEN;
  if (!base || !token) return null;
  return { base: base.replace(/\/+$/, ""), token };
}

export async function GET() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { storm, status, error } = await fetchPlannerStorm();
  if (storm) return NextResponse.json({ storm });
  return NextResponse.json({ error }, { status });
}

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const env = plannerEnv();
  if (!env) return NextResponse.json({ error: "planner not configured" }, { status: 503 });
  let action: unknown, hours: unknown;
  try {
    const body = await req.json();
    action = body?.action;
    hours = body?.hours;
  } catch { /* falls through to the action check */ }
  if (action !== "arm" && action !== "disarm") {
    return NextResponse.json({ error: 'action must be "arm" or "disarm"' }, { status: 400 });
  }
  try {
    const res = await fetch(`${env.base}/api/storm/${action}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(action === "arm" ? { hours: Number(hours) || 24 } : {}),
      cache: "no-store",
    });
    const out = await res.json().catch(() => ({}));
    return NextResponse.json(out, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: "planner unreachable", detail: String(e) }, { status: 502 });
  }
}
