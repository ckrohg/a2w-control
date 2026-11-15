/**
 * @purpose The single parsing seam between a raw POST body and the object every planner write route reads fields
 * from. Pure: a string in, either `{ ok: true, body }` (always a plain object, never null / array / primitive) or a
 * client-facing status + message out. Empty → {} (the dashboard's bare POSTs). Non-JSON, `null`, arrays and
 * primitives → 400. The readBody oversize marker → 413. Nothing here throws, so a typo'd or truncated dashboard
 * request can never reach the server's outer catch and read as a 500 "internal error". Pinned by httpbody.test.ts.
 */

/** Byte cap readBody enforces on a POST body; past it the server stops accumulating and hands back the marker. */
export const MAX_BODY_BYTES = 4096;

/**
 * What readBody resolves to once a body has passed MAX_BODY_BYTES. A leading NUL keeps it from ever being valid
 * JSON, so a real client can at worst earn a 413 instead of a 400 by sending it deliberately.
 */
export const BODY_TOO_LARGE = "\u0000a2w:body-too-large";

export type ParsedJsonObject =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string };

export function parseJsonObject(raw: string): ParsedJsonObject {
  if (raw === BODY_TOO_LARGE) {
    return { ok: false, status: 413, error: `body too large (max ${MAX_BODY_BYTES} bytes)` };
  }
  if (raw.trim() === "") return { ok: true, body: {} };
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "body must be valid JSON" };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return { ok: false, status: 400, error: "body must be a JSON object" };
  }
  return { ok: true, body: v as Record<string, unknown> };
}
