// @purpose Server-side proxy to the planner's HBX restore endpoint — re-applies the
// as-found curve (never rate-limited planner-side; reverting to baseline is always
// allowed). Cookie-gated + isAuthed() like every control proxy.
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const base = process.env.PLANNER_URL;
  const token = process.env.PLANNER_API_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: "planner not configured" }, { status: 503 });
  }
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/hbx/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const out = await res.json().catch(() => ({}));
    return NextResponse.json(out, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: "planner unreachable", detail: String(e) }, { status: 502 });
  }
}
