// @purpose Password sign-in: exchange the view password for the a2w_view session cookie.
// PUBLIC (lib/gate.ts lists it open), so a malformed or oversized body is a 400/413 from
// lib/login-input.ts and never a 500; the compare is constant-time in lib/password.ts.
import { NextResponse } from "next/server";
import { readLoginPassword } from "@/lib/login-input";
import { passwordMatches } from "@/lib/password";

export const runtime = "nodejs";

// Exchange the view password for a session cookie. Read-only dashboard, so a single shared
// password is enough. The cookie value is a separate random secret (VIEW_SESSION_SECRET),
// never the password — middleware compares the cookie to it (no crypto needed on the edge).
export async function POST(req: Request) {
  const expected = process.env.VIEW_PASSWORD;
  const sessionSecret = process.env.VIEW_SESSION_SECRET;
  if (!expected || !sessionSecret) {
    return NextResponse.json({ error: "auth not configured" }, { status: 500 });
  }
  const body = await readLoginPassword(req);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }
  // Constant-time compare so a timer can't recover the password character by character.
  if (!passwordMatches(body.password, expected)) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("a2w_view", sessionSecret, {
    httpOnly: true, sameSite: "strict", secure: true, path: "/",
    maxAge: 30 * 86400,
  });
  return res;
}
