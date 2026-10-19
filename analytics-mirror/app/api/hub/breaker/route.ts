// @purpose Relay of a SPAN breaker action (remote breaker control, owner decision 2026-10-18) —
// same two gates as write-enable: the session cookie AND the short-lived armed cookie (fresh
// password re-entry). Calls the hub's double-gated /api/breaker with the client bearer and the
// separate HUB_ARM_TOKEN (neither reaches the browser) and returns its answer verbatim, including
// the bridge's panel read-back. A power cycle answers after its 60 s hold, hence maxDuration.
import { NextResponse } from "next/server";
import { isAuthed, isArmed } from "@/lib/auth";
import { DASHBOARD_OFF_S } from "@/lib/breaker-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;   // 60 s hold + read-back + the hub's grace

const ACTIONS = new Set(["power_cycle", "close", "open"]);

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!isArmed()) return NextResponse.json({ error: "not armed — re-enter the password" }, { status: 403 });
  const base = process.env.HUB_URL;
  const token = process.env.HUB_CLIENT_TOKEN;
  const arm = process.env.HUB_ARM_TOKEN;
  if (!base || !token || !arm) {
    return NextResponse.json({ error: "breaker relay not configured" }, { status: 503 });
  }
  let input: { circuit?: unknown; action?: unknown } = {};
  try { input = await req.json(); } catch { /* empty */ }
  if (typeof input.circuit !== "string" || typeof input.action !== "string" || !ACTIONS.has(input.action)) {
    return NextResponse.json({ error: "circuit and action are required" }, { status: 400 });
  }
  // Only the fields we mean, and only the 60 s cycle: a longer hold would outlive this function.
  const body = JSON.stringify({
    circuit: input.circuit,
    action: input.action,
    ...(input.action === "power_cycle" ? { off_s: DASHBOARD_OFF_S } : {}),
  });
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/api/breaker`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Arm-Token": arm,
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(110_000),
    });
    const out = await res.json().catch(() => ({}));
    return NextResponse.json(out, { status: res.status });
  } catch (e) {
    const timedOut = (e as Error)?.name === "TimeoutError";
    return NextResponse.json(
      timedOut
        ? { error: "no answer in time — the action may still complete on the Pi" }
        : { error: "hub unreachable", detail: String(e) },
      { status: timedOut ? 504 : 502 },
    );
  }
}
