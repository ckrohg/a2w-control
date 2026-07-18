// @purpose Server-side proxy for the autonomy Off/Armed switch (W2-B). Forwards the dashboard's
// mode change to the planner's guarded /api/autonomy endpoint, holding PLANNER_API_TOKEN
// server-side (the browser never sees it) — same auth pattern as boost/target/restore. off → both
// controllers shadow (compute + log, write nothing); arm → both live inside the I4/I1 guardrails.
// The planner returns 501 for the not-yet-implemented set/req modes; we pass that status through.
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const base = process.env.PLANNER_URL;
  const token = process.env.PLANNER_API_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: "planner not configured" }, { status: 503 });
  }
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/autonomy`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: await req.text(),
      cache: "no-store",
    });
    const out = await res.json().catch(() => ({}));
    return NextResponse.json(out, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: "planner unreachable", detail: String(e) }, { status: 502 });
  }
}
