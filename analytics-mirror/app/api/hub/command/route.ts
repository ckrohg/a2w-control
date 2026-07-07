// @purpose Server-side proxy to the Railway hub's POST /api/command. Cookie-gated by the
// existing middleware; injects Bearer HUB_CLIENT_TOKEN (kept off the browser) and stamps
// source:"dashboard". Forwards {pump_id, value_c, lease_minutes?} and relays the hub's
// status + body back so the client can surface 503 (no Pi) / 504 (ack timeout) / 502 (nack
// detail). setpoint is the ONLY action the hub relays — power/mode/params stay human-only.
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Re-check the session here, not just in middleware — this is a write path to the house's
  // heat, so a middleware bypass (CVE-2025-29927) must still be stopped cold.
  if (!isAuthed()) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const base = process.env.HUB_URL;
  const token = process.env.HUB_CLIENT_TOKEN;
  if (!base || !token) {
    return NextResponse.json({ ok: false, error: "hub not configured" }, { status: 503 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const pump_id = body?.pump_id;
  const value_c = Number(body?.value_c);
  if (typeof pump_id !== "string" || !pump_id || !Number.isFinite(value_c)) {
    return NextResponse.json(
      { ok: false, error: "pump_id and numeric value_c required" },
      { status: 400 },
    );
  }
  const payload: Record<string, unknown> = { pump_id, value_c, source: "dashboard" };
  if (body?.lease_minutes != null && Number.isFinite(Number(body.lease_minutes))) {
    payload.lease_minutes = Number(body.lease_minutes);
  }

  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/command`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const out = await res.json().catch(() => ({}));
    return NextResponse.json(out, { status: res.status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "hub unreachable", detail: String(e) },
      { status: 502 },
    );
  }
}
