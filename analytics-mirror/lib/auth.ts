// @purpose Defense-in-depth auth check run INSIDE sensitive route handlers, not only in
// middleware. CVE-2025-29927 showed Next middleware can be skipped with a crafted
// x-middleware-subrequest header, so the hub control/state proxies re-verify the
// view-session cookie here too — a bypassed middleware then still hits a locked door.
// Constant-time compare; node runtime only (uses crypto + next/headers cookies()).
// The armed cookie's mint/verify live in lib/armed.ts (pure, testable); these are wrappers.
import { cookies } from "next/headers";
import crypto from "crypto";
import { ARMED_TTL_S, armedKeyFrom, mintArmed, verifyArmed } from "./armed";

export function isAuthed(): boolean {
  const secret = process.env.VIEW_SESSION_SECRET ?? "";
  const cookie = cookies().get("a2w_view")?.value ?? "";
  if (!secret || !cookie) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Key for the armed cookie, derived from VIEW_PASSWORD and VIEW_SESSION_SECRET so the
 *  a2w_view cookie (which is the raw session secret) cannot sign it. "" if either is unset. */
export function armedKey(): string {
  return armedKeyFrom(process.env);
}

/** The armed-state cookie value: `${expMs}.${hmac}` signed by armedKey(). Expires server-side
 *  after ARMED_TTL_S — set by /api/hub/arm after a fresh password re-entry. Throws if either
 *  auth env var is unset. */
export function armedValue(nowMs: number = Date.now()): string {
  return mintArmed(armedKey(), nowMs, ARMED_TTL_S);
}

/** Gate 1 of the write-mode toggle: a valid session alone is NOT enough — the caller
 *  must also hold the short-lived armed cookie from a fresh password re-entry. */
export function isArmed(nowMs: number = Date.now()): boolean {
  const cookie = cookies().get("a2w_armed")?.value ?? "";
  return verifyArmed(armedKey(), cookie, nowMs, ARMED_TTL_S);
}
