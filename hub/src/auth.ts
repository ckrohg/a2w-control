/**
 * @purpose Pure bearer-token rules for the hub's HTTP API, kept out of index.ts (which starts a
 * server on import) so they have unit tests. Two roles: the client token (optimizer + dashboard,
 * full API) and the optional READ-ONLY token (#190: the 6bb home app shows heat-pump status and
 * must never control anything). The wiring is covered by readonly.e2e.test.ts.
 */
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison. Hashes both sides to fixed-length buffers so
 * timingSafeEqual never throws on length mismatch and length is not leaked.
 * Returns false when the expected secret is empty (unconfigured).
 */
export function constantTimeEqual(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Extract a bearer token from an Authorization header value, or "" if absent. */
export function extractBearer(headerValue: string | undefined): string {
  if (!headerValue) return "";
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1].trim() : "";
}

export type BearerRole = "client" | "readonly" | "none";

/** Which role a presented bearer holds. The read-only token is matched FIRST, so even if it
 *  somehow equals the client token it can only ever read (startup refuses that config anyway). */
export function bearerRole(token: string, clientToken: string, readonlyToken: string): BearerRole {
  if (constantTimeEqual(token, readonlyToken)) return "readonly";
  if (constantTimeEqual(token, clientToken)) return "client";
  return "none";
}

/** Name of the other secret the read-only token equals (a copy-paste mistake that would hand
 *  the 6bb app control), or null. The hub refuses to start when this is non-null. Both sides are
 *  trimmed: a pasted trailing newline must not hide a clash. */
export function readonlyTokenClash(readonlyToken: string, others: Record<string, string>): string | null {
  const token = readonlyToken.trim();
  if (!token) return null;
  for (const [name, value] of Object.entries(others)) {
    if (constantTimeEqual(token, value.trim())) return name;
  }
  return null;
}
