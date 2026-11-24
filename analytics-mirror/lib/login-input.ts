// @purpose Pure request-body parsing for the two PUBLIC sign-in routes (app/api/login and
// app/api/webauthn/auth/verify). Anyone on the internet can POST to them, so a malformed body
// must end in a clean 4xx, never a throw: oversized → 413, not JSON / not an object / wrong
// field types → 400. Next's App Router handlers do not cap req.json() (the 1 MB bodyParser
// limit is pages/api only), so readJsonBody reads at most BODY_MAX_BYTES itself. Error strings
// are fixed and generic — nothing from the request is ever echoed back. No Next imports and no
// node:crypto, so the suites can drive it with plain constructed Requests.
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";

/** Largest body either route reads. A passkey assertion is ~1-2 KB; a password body far less. */
export const BODY_MAX_BYTES = 16 * 1024;
/** Longest password the login route accepts; anything longer is a 400 before any compare. */
export const PASSWORD_MAX_LEN = 1024;
/** A WebAuthn credential id is at most 1023 bytes, ~1364 base64url chars; 2048 leaves headroom. */
export const CRED_ID_MAX_LEN = 2048;

export type BodyFail = { ok: false; status: 400 | 413; error: string };
export const BAD_REQUEST: BodyFail = { ok: false, status: 400, error: "bad request" };
export const TOO_LARGE: BodyFail = { ok: false, status: 413, error: "request too large" };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown, max = Infinity): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

/** Read and JSON-parse the body, never more than `maxBytes`. A declared Content-Length over the
 *  cap is refused unread; an undeclared or understated one is cut off while streaming. */
export async function readJsonBody(
  req: Request,
  maxBytes: number = BODY_MAX_BYTES,
): Promise<{ ok: true; value: unknown } | BodyFail> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) return TOO_LARGE;
  if (!req.body) return BAD_REQUEST;

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } catch {
    return BAD_REQUEST;
  }

  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return BAD_REQUEST;
  }
}

/** `{ "password": "<1..PASSWORD_MAX_LEN chars>" }` → the password; anything else → null. */
export function parseLoginBody(v: unknown): string | null {
  if (!isObject(v)) return null;
  return isNonEmptyString(v.password, PASSWORD_MAX_LEN) ? v.password : null;
}

/** `{ "response": AuthenticationResponseJSON }` → the response object itself (unchanged, so the
 *  library sees exactly what the browser sent); a missing or mistyped field → null. Only shape is
 *  checked here; signatures, challenge, origin and id/rawId agreement are the library's job. */
export function parsePasskeyBody(v: unknown): AuthenticationResponseJSON | null {
  if (!isObject(v)) return null;
  const r = v.response;
  if (!isObject(r)) return null;
  if (!isNonEmptyString(r.id, CRED_ID_MAX_LEN) || !isNonEmptyString(r.rawId, CRED_ID_MAX_LEN)) return null;
  if (r.type !== "public-key") return null;
  const a = r.response;
  if (!isObject(a)) return null;
  if (!isNonEmptyString(a.clientDataJSON) || !isNonEmptyString(a.authenticatorData) || !isNonEmptyString(a.signature)) {
    return null;
  }
  if (a.userHandle !== undefined && typeof a.userHandle !== "string") return null;
  if (r.authenticatorAttachment !== undefined && typeof r.authenticatorAttachment !== "string") return null;
  if (r.clientExtensionResults !== undefined && !isObject(r.clientExtensionResults)) return null;
  return r as unknown as AuthenticationResponseJSON;
}

/** What app/api/login does with its body: the password string, or the 4xx to answer. */
export async function readLoginPassword(req: Request): Promise<{ ok: true; password: string } | BodyFail> {
  const body = await readJsonBody(req);
  if (!body.ok) return body;
  const password = parseLoginBody(body.value);
  return password === null ? BAD_REQUEST : { ok: true, password };
}

/** What app/api/webauthn/auth/verify does with its body: the assertion, or the 4xx to answer. */
export async function readPasskeyResponse(
  req: Request,
): Promise<{ ok: true; response: AuthenticationResponseJSON } | BodyFail> {
  const body = await readJsonBody(req);
  if (!body.ok) return body;
  const response = parsePasskeyBody(body.value);
  return response === null ? BAD_REQUEST : { ok: true, response };
}
