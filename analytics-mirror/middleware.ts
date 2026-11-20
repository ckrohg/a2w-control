import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isOpenPath, viewCookieOk } from "./lib/gate";

// Gate the dashboard behind the view session cookie. The open-path list and the cookie compare
// live in lib/gate.ts (pure, edge-safe, tested); this file only wires them to Next.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isOpenPath(pathname)) return NextResponse.next();

  const cookie = req.cookies.get("a2w_view")?.value;
  if (viewCookieOk(cookie, process.env.VIEW_SESSION_SECRET)) {
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
