// @purpose Pure decisions for middleware.ts, the only gate in front of the dashboard and every
// control proxy. isOpenPath lists the routes a request may reach without the a2w_view cookie —
// matched EXACTLY, never by prefix, so a future /api/ingest-debug or /api/digest-preview is
// gated by default. viewCookieOk compares the cookie to VIEW_SESSION_SECRET in constant time.
// No Next imports and no node:crypto: this must run on the edge runtime and in plain tsx tests.

/** Routes reachable without the view cookie. Each guards itself or is the way in:
 *  /login + /api/login (password form), /api/webauthn/auth/* (passkey sign-in),
 *  /api/ingest (Pi bearer token), /api/digest (CRON_SECRET bearer/key or view cookie). */
const OPEN_EXACT: ReadonlySet<string> = new Set([
  "/login",
  "/api/login",
  "/api/ingest",
  "/api/digest",
  "/api/webauthn/auth",
  "/api/webauthn/auth/options",
  "/api/webauthn/auth/verify",
]);

/** True only for an exact open path. Trailing slashes, query strings and prefixes do not match. */
export function isOpenPath(pathname: string): boolean {
  return OPEN_EXACT.has(pathname);
}

/** True when the cookie equals the secret. False when either is empty or undefined.
 *  Compares every character of the longer string so timing does not reveal the match prefix. */
export function viewCookieOk(cookie: string | undefined | null, secret: string | undefined | null): boolean {
  if (typeof cookie !== "string" || typeof secret !== "string") return false;
  if (cookie.length === 0 || secret.length === 0) return false;
  const n = Math.max(cookie.length, secret.length);
  let diff = cookie.length ^ secret.length;
  for (let i = 0; i < n; i++) {
    // Out-of-range reads yield NaN → 0 after |0, so the loop body is uniform across lengths.
    const a = cookie.charCodeAt(i) | 0;
    const b = secret.charCodeAt(i) | 0;
    diff |= a ^ b;
  }
  return diff === 0;
}
