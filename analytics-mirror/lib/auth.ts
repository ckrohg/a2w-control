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

/** The armed-state cookie value: derived from the session secret, never the secret
 *  itself. Short-lived (5 min) — set by /api/hub/arm after a fresh password re-entry. */
export function armedValue(): string {
  const secret = process.env.VIEW_SESSION_SECRET ?? "";
  return crypto.createHash("sha256").update(`${secret}:armed`).digest("hex");
}

/** Gate 1 of the write-mode toggle: a valid session alone is NOT enough — the caller
 *  must also hold the short-lived armed cookie from a fresh password re-entry. */
export function isArmed(): boolean {
  const cookie = cookies().get("a2w_armed")?.value ?? "";
  if (!cookie) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(armedValue());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
