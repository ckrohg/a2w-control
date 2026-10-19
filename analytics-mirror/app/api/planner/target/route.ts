// @purpose Server-side proxy to the planner's guarded HBX write API (GET status /
// POST set-target). Cookie-gated by middleware + isAuthed() defense-in-depth (same
// pattern as the hub proxies) — PLANNER_API_TOKEN never reaches the browser. The
// planner enforces the real guardrails (I4 envelope, I1 cross-check, rate limit,
// read-back, audit); this route only relays — plus, on GET with a boost on record, a read-only
// `boost_superseded_by` from the shared DB (#186; lib/db.ts boostSupersededBy).
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { boostSupersededBy } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function relay(method: "GET" | "POST", body?: string) {
  const base = process.env.PLANNER_URL;
  const token = process.env.PLANNER_API_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: "planner not configured" }, { status: 503 });
  }
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/hbx/target`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
      cache: "no-store",
    });
    const out = await res.json().catch(() => ({}));
    return NextResponse.json(out, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: "planner unreachable", detail: String(e) }, { status: 502 });
  }
}

export async function GET() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const res = await relay("GET");
  if (!res.ok) return res;
  const body = await res.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json(body ?? {}, { status: res.status });
  // #186: with a boost on record, say whether the curve has been written over since (shared DB, read
  // only). Absent = could not tell (the client falls back to the curve check); null = not superseded.
  if (body.active_boost) {
    try { body.boost_superseded_by = await boostSupersededBy(); } catch { /* tables missing / DB down */ }
  }
  return NextResponse.json(body, { status: res.status });
}

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return relay("POST", await req.text());
}
