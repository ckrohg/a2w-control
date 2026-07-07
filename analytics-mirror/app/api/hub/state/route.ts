// @purpose Server-side proxy to the Railway hub's GET /api/state. Cookie-gated by the
// existing middleware; injects the Bearer HUB_CLIENT_TOKEN so the token never reaches the
// browser. Returns the hub's latest Pi state snapshot verbatim. NOT in the control path to
// the Pi — the hub owns the Pi WS; this only reads what the Pi last pushed.
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // Defense in depth alongside middleware — the hub state snapshot is not public.
  if (!isAuthed()) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const base = process.env.HUB_URL;
  const token = process.env.HUB_CLIENT_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ error: "hub not configured" }, { status: 503 });
  }
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/state`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    return NextResponse.json(body, { status: res.status });
  } catch (e) {
    return NextResponse.json(
      { error: "hub unreachable", detail: String(e) },
      { status: 502 },
    );
  }
}
