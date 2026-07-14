// @purpose Gate 1 of the remote write-mode toggle: exchange a FRESH password re-entry
// for a 5-minute armed cookie. A stolen session cookie alone can never arm — the
// password is required again here, verified constant-time server-side. The cookie value
// is derived from the session secret (never the secret or password itself).
import { NextResponse } from "next/server";
import crypto from "crypto";
import { isAuthed, armedValue } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARM_SECONDS = 300;

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const expected = process.env.VIEW_PASSWORD;
  if (!expected) return NextResponse.json({ error: "auth not configured" }, { status: 500 });
  let password = "";
  try {
    password = (await req.json())?.password ?? "";
  } catch { /* empty */ }
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, armed_seconds: ARM_SECONDS });
  res.cookies.set("a2w_armed", armedValue(), {
    httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: ARM_SECONDS,
  });
  return res;
}
