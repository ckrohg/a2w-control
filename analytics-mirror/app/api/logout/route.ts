import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Clear the session and bounce back to the login page (this is hit by a plain form POST).
export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/login", req.url), { status: 303 });
  res.cookies.delete("a2w_view");
  return res;
}
