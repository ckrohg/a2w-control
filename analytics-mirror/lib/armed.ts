// @purpose Pure mint/verify for the 5-minute "armed" cookie (Gate 1 of remote write-enable
// and breaker control). The value carries its own expiry — `${expMs}.${hmacHex}`, HMAC-SHA256
// keyed by VIEW_SESSION_SECRET over `armed:${expMs}` — and the server checks that expiry on
// every use. No next/headers here so tests can import it; lib/auth.ts wraps it.
import crypto from "crypto";

export const ARMED_TTL_S = 300;
/** Slack beyond now + ttl a value may claim before it is treated as forged. */
const FUTURE_SLACK_S = 60;

function sign(secret: string, expMs: number): string {
  return crypto.createHmac("sha256", secret).update(`armed:${expMs}`).digest("hex");
}

/** Mint an armed value expiring at nowMs + ttlS*1000. Throws on an empty secret — a cookie
 *  signed with "" would be minted by anyone. */
export function mintArmed(secret: string, nowMs: number, ttlS: number = ARMED_TTL_S): string {
  if (!secret) throw new Error("mintArmed: empty secret");
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlS) || ttlS <= 0) throw new Error("mintArmed: bad time");
  const expMs = Math.floor(nowMs + ttlS * 1000);
  return `${expMs}.${sign(secret, expMs)}`;
}

/** True only for a well-formed, unexpired, correctly signed value. Constant-time on the HMAC;
 *  rejects an expiry at/before now or further out than now + ttl + 60 s (a forged far-future
 *  claim would otherwise be accepted if the attacker could sign it). */
export function verifyArmed(secret: string, value: unknown, nowMs: number, ttlS: number = ARMED_TTL_S): boolean {
  if (!secret || typeof value !== "string" || value.length === 0) return false;
  if (!Number.isFinite(nowMs)) return false;
  const m = /^(\d{1,16})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  const expMs = Number(m[1]);
  if (!Number.isSafeInteger(expMs)) return false;
  if (expMs <= nowMs) return false;
  if (expMs > nowMs + (ttlS + FUTURE_SLACK_S) * 1000) return false;
  const a = Buffer.from(m[2], "hex");
  const b = Buffer.from(sign(secret, expMs), "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
