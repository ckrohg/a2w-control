// @purpose Gate 2 relay of the remote write-mode toggle: requires the session cookie AND
// the short-lived armed cookie (fresh password re-entry), then calls the hub's
// double-gated /api/write-enable with both the client bearer and the separate
// HUB_ARM_TOKEN — neither token ever reaches the browser. The Pi applies its own loud
// ceremony (audit + high-priority push on enable) and its ack is relayed back verbatim.
import { NextResponse } from "next/server";
import { isAuthed, isArmed } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isArmed()) return NextResponse.json({ error: "not armed — re-enter the password" }, { status: 403 });
  const base = process.env.HUB_URL;
  const token = process.env.HUB_CLIENT_TOKEN;
  const arm = process.env.HUB_ARM_TOKEN;
  if (!base || !token || !arm) {
    return NextResponse.json({ error: "write-enable relay not configured" }, { status: 503 });
  }
  const body = await req.text();
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/write-enable`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Arm-Token": arm,
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
    });
    const out = await res.json().catch(() => ({}));
    return NextResponse.json(out, { status: res.status });
  } catch (e) {
    return NextResponse.json({ error: "hub unreachable", detail: String(e) }, { status: 502 });
  }
}
