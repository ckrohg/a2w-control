// @purpose Defense-in-depth auth check run INSIDE sensitive route handlers, not only in
// middleware. CVE-2025-29927 showed Next middleware can be skipped with a crafted
// x-middleware-subrequest header, so the hub control/state proxies re-verify the
// view-session cookie here too — a bypassed middleware then still hits a locked door.
// Constant-time compare; node runtime only (uses crypto + next/headers cookies()).
import { cookies } from "next/headers";
import crypto from "crypto";

export function isAuthed(): boolean {
  const secret = process.env.VIEW_SESSION_SECRET ?? "";
  const cookie = cookies().get("a2w_view")?.value ?? "";
  if (!secret || !cookie) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
