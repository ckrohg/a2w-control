import { NextResponse } from "next/server";

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
  let password = "";
  try {
    password = (await req.json())?.password ?? "";
  } catch {
    /* empty */
  }
  if (password !== expected) {
    return NextResponse.json({ error: "incorrect password" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set("a2w_view", sessionSecret, {
    httpOnly: true, sameSite: "strict", secure: true, path: "/",
    maxAge: 30 * 86400,
  });
  return res;
}
