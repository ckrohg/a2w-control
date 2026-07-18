// @purpose Owner control for the backup-element ARM (spec: knowledge/reference/span-backup-arm-spec.md).
// Writes desired_armed to Neon; the bridge applies it via the ingest response. CLOSE-ONLY on the
// bridge, so this can only make the failsafe AVAILABLE, never disable it. Phase 1 = SHADOW (the bridge
// logs would-arm; it toggles nothing on SPAN). Session-gated, same as the other control routes.
import { NextResponse } from "next/server";
import { isAuthed } from "@/lib/auth";
import { setSpanArmDesired, getSpanArmState } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { armed?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (typeof body?.armed !== "boolean") {
    return NextResponse.json({ error: "armed must be a boolean" }, { status: 400 });
  }
  await setSpanArmDesired(body.armed);
  return NextResponse.json({ ok: true, desired_armed: body.armed });
}

export async function GET() {
  return NextResponse.json((await getSpanArmState()) ?? {});
}
