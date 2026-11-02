// @purpose Gate 1 of the remote write-mode toggle: exchange a FRESH password re-entry
// for a 5-minute armed cookie. A stolen session cookie alone can never arm — the
// password is required again here, verified constant-time server-side. The cookie value
// is `${expMs}.${hmac}` signed by the session secret (lib/armed.ts), and the server checks
// that expiry on every use.
import { NextResponse } from "next/server";
import crypto from "crypto";
import { isAuthed } from "@/lib/auth";
import { ARMED_TTL_S, mintArmed } from "@/lib/armed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARM_SECONDS = ARMED_TTL_S;

export async function POST(req: Request) {
  if (!isAuthed()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const expected = process.env.VIEW_PASSWORD;
  const secret = process.env.VIEW_SESSION_SECRET;
  if (!expected || !secret) return NextResponse.json({ error: "auth not configured" }, { status: 500 });
  let password: unknown = "";
  try {
    password = (await req.json())?.password;
  } catch { /* empty */ }
  // A non-string body field (number, object, null) is simply an incorrect password — never
  // let it reach Buffer.from and throw a 500.
  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }
  const a = Buffer.from(password);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true, armed_seconds: ARM_SECONDS });
  res.cookies.set("a2w_armed", mintArmed(secret, Date.now(), ARM_SECONDS), {
    httpOnly: true, sameSite: "strict", secure: true, path: "/", maxAge: ARM_SECONDS,
  });
  return res;
}
