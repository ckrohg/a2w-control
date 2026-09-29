// @purpose Server-side proxy for the identification-driver mode (off | shadow | armed). Forwards the
// dashboard's choice to the planner's guarded /api/identification, holding PLANNER_API_TOKEN
// server-side (the browser never sees it) — same auth pattern as autonomy/sanitize/boost/target.
// Independent of the Off/Armed autonomy mode: it flips controller_flags.identification_mode, which
// governs whether identify.ts draws and writes randomised supply-water probes (gtm#1616 / #137).
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
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/identification`, {
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
