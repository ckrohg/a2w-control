import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Gate the dashboard behind the view session cookie. /api/ingest (bearer-token, from the
// Pi) and /login + /api/login are open. Everything else needs the cookie. Compares the
// cookie to VIEW_SESSION_SECRET directly — no crypto, so it runs fine on the edge runtime.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const open =
    pathname.startsWith("/api/ingest") ||
    pathname.startsWith("/api/login") ||
    pathname.startsWith("/api/webauthn/auth") ||
    pathname === "/login";
  if (open) return NextResponse.next();

  const cookie = req.cookies.get("a2w_view")?.value;
  if (cookie && cookie === process.env.VIEW_SESSION_SECRET) {
    return NextResponse.next();
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  // run on everything except Next internals and static assets
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
