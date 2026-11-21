// @purpose Constant-time view-password check for app/api/login. Takes whatever the request JSON
// held, so a non-string password ({"password": 123}, {}, null) is a plain mismatch, never a
// Buffer.from throw (→ 500). Both sides are SHA-256'd first so timingSafeEqual always compares
// two 32-byte buffers: the compare costs the same whatever the given length, and the length of
// VIEW_PASSWORD never shows up in timing. Fails closed when either side is empty.
import crypto from "crypto";

const digest = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest();

export function passwordMatches(given: unknown, expected: unknown): boolean {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  // Hash and compare before the emptiness check so an empty guess costs the same as any other.
  const same = crypto.timingSafeEqual(digest(given), digest(expected));
  return same && given.length > 0 && expected.length > 0;
}
