/**
 * @purpose Assertions for httpbody.ts: the raw POST body → object seam in front of every planner write route. A
 * malformed, null, array, primitive or oversize body must come back as a 400 / 413 result, never a throw (which the
 * server's outer catch would turn into a 500 "internal error").
 * Run with: npx tsx planner/src/httpbody.test.ts
 */
import assert from "node:assert/strict";
import { parseJsonObject, BODY_TOO_LARGE, MAX_BODY_BYTES } from "./httpbody";

// 1. an empty body is an empty object (the dashboard's bare POSTs, e.g. /api/hbx/restore)
assert.deepEqual(parseJsonObject(""), { ok: true, body: {} });
assert.deepEqual(parseJsonObject("  \n"), { ok: true, body: {} });

// 2. a valid object comes through untouched
assert.deepEqual(parseJsonObject('{"target_f": 128, "minutes": 90, "to": "as-found"}'), {
  ok: true, body: { target_f: 128, minutes: 90, to: "as-found" },
});
assert.deepEqual(parseJsonObject("{}"), { ok: true, body: {} });

// 3. null is valid JSON but not an object → 400 (previously `body.to` threw a TypeError → 500)
{
  const r = parseJsonObject("null");
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.status, 400); assert.match(r.error, /object/); }
}

// 4. an array is not an object → 400
{
  const r = parseJsonObject("[]");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.status, 400);
  const r2 = parseJsonObject('[{"mode":"arm"}]');
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.status, 400);
}

// 5. a primitive is not an object → 400
for (const raw of ["42", "true", '"arm"']) {
  const r = parseJsonObject(raw);
  assert.equal(r.ok, false, raw);
  if (!r.ok) assert.equal(r.status, 400, raw);
}

// 6. truncated / non-JSON → 400 with a message that names JSON, not an internal error
for (const raw of ['{"a":', "{mode: arm}", "not json at all", "{"]) {
  const r = parseJsonObject(raw);
  assert.equal(r.ok, false, raw);
  if (!r.ok) { assert.equal(r.status, 400, raw); assert.match(r.error, /JSON/); }
}

// 7. the readBody oversize marker → 413, with the cap in the message
{
  const r = parseJsonObject(BODY_TOO_LARGE);
  assert.equal(r.ok, false);
  if (!r.ok) { assert.equal(r.status, 413); assert.match(r.error, new RegExp(String(MAX_BODY_BYTES))); }
}

// 8. the marker can never be mistaken for valid JSON (so a legitimate body can't collide with it)
assert.throws(() => JSON.parse(BODY_TOO_LARGE));

// 9. nothing throws, whatever the input
for (const raw of ["", "null", "[]", "42", '{"a":', BODY_TOO_LARGE, "\u0000", "{}}"]) {
  assert.doesNotThrow(() => parseJsonObject(raw), raw);
}

console.log("httpbody.test.ts: all assertions passed");
