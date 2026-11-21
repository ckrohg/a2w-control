// @purpose node:assert suite for lib/login-input.ts — the body parsing behind the two public
// sign-in routes. Drives readLoginPassword / readPasskeyResponse (exactly what app/api/login and
// app/api/webauthn/auth/verify call) with constructed Requests: not JSON, JSON that isn't an
// object, wrong field types, empty and over-long passwords, incomplete WebAuthn assertions, and
// bodies over BODY_MAX_BYTES (declared, undeclared and streamed) all come back as a fixed 400/413
// that never echoes the input; well-formed bodies pass through untouched. No Next import.
// Run: npx tsx tests/login-input.test.ts
import assert from "node:assert/strict";
import {
  BODY_MAX_BYTES, PASSWORD_MAX_LEN, CRED_ID_MAX_LEN,
  readJsonBody, readLoginPassword, readPasskeyResponse,
} from "../lib/login-input";

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log(`  ✓ ${name}`); };

const URL_ = "https://mirror.test/api/x";
const post = (body: BodyInit | null, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
  new Request(URL_, { method: "POST", body, headers });
const postJson = (v: unknown) => post(JSON.stringify(v));
/** A body streamed in `chunks` pieces with no Content-Length, the way a chunked upload arrives. */
const postStream = (chunk: string, chunks: number) => {
  const enc = new TextEncoder().encode(chunk);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) { if (sent++ < chunks) c.enqueue(enc); else c.close(); },
  });
  return new Request(URL_, { method: "POST", body: stream, duplex: "half" } as RequestInit);
};

const MARK = "ECHO_CANARY_7f3a";
function assertFail(r: { ok: boolean }, status: 400 | 413, label: string) {
  assert.equal(r.ok, false, label);
  const f = r as { ok: false; status: number; error: string };
  assert.equal(f.status, status, label);
  assert.equal(f.error, status === 413 ? "request too large" : "bad request", label);
  assert.ok(!JSON.stringify(f).includes(MARK), `${label}: input echoed`);
}

/** A well-formed assertion in the shape @simplewebauthn/browser v13 sends. */
const goodAssertion = () => ({
  id: "AbCd-_12",
  rawId: "AbCd-_12",
  type: "public-key",
  response: {
    clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0",
    authenticatorData: "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAQ",
    signature: "MEUCIQ",
    userHandle: "YTJ3LW93bmVy",
  },
  clientExtensionResults: {},
  authenticatorAttachment: "platform",
});

async function main() {
  // --- readJsonBody ---

  await t("valid JSON under the cap parses", async () => {
    const r = await readJsonBody(postJson({ a: 1 }));
    assert.deepEqual(r, { ok: true, value: { a: 1 } });
  });

  await t("no body, empty body, not-JSON, truncated JSON, invalid UTF-8 → 400", async () => {
    assertFail(await readJsonBody(new Request(URL_, { method: "POST" })), 400, "no body");
    assertFail(await readJsonBody(post("")), 400, "empty");
    assertFail(await readJsonBody(post(`password=${MARK}`)), 400, "form-encoded");
    assertFail(await readJsonBody(post(`{"password":"${MARK}"`)), 400, "truncated");
    assertFail(await readJsonBody(post(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))), 400, "bad utf-8");
  });

  await t("declared Content-Length over the cap → 413 without reading", async () => {
    const r = post("{}", { "Content-Type": "application/json", "Content-Length": String(BODY_MAX_BYTES + 1) });
    assertFail(await readJsonBody(r), 413, "declared");
  });

  await t("body over the cap with an honest length → 413; exactly at the cap → parses", async () => {
    const over = JSON.stringify({ password: "x".repeat(BODY_MAX_BYTES) });
    assertFail(await readJsonBody(post(over)), 413, "over");
    const pad = BODY_MAX_BYTES - JSON.stringify({ p: "" }).length;
    const at = JSON.stringify({ p: "y".repeat(pad) });
    assert.equal(new TextEncoder().encode(at).byteLength, BODY_MAX_BYTES);
    assert.equal((await readJsonBody(post(at))).ok, true);
  });

  await t("streamed body with no Content-Length is cut off past the cap → 413", async () => {
    const req = postStream("x".repeat(4096), 64); // 256 KB if read to the end
    assert.equal(req.headers.get("content-length"), null);
    assertFail(await readJsonBody(req), 413, "stream");
  });

  // --- readLoginPassword (app/api/login) ---

  await t("login: a well-formed password passes through verbatim", async () => {
    assert.deepEqual(await readLoginPassword(postJson({ password: "hunter2" })), { ok: true, password: "hunter2" });
    const max = "p".repeat(PASSWORD_MAX_LEN);
    assert.deepEqual(await readLoginPassword(postJson({ password: max })), { ok: true, password: max });
    // Extra fields are ignored, as before.
    assert.deepEqual(await readLoginPassword(postJson({ password: "a", extra: 1 })), { ok: true, password: "a" });
  });

  await t("login: JSON that is not an object → 400", async () => {
    for (const v of [null, 0, 123, "hunter2", MARK, true, [], [{ password: MARK }]]) {
      assertFail(await readLoginPassword(postJson(v)), 400, JSON.stringify(v));
    }
  });

  await t("login: password missing, wrong type, empty or over-long → 400", async () => {
    for (const v of [
      {}, { pass: MARK }, { password: null }, { password: 123 }, { password: 0 }, { password: true },
      { password: {} }, { password: { toString: MARK } }, { password: [MARK] }, { password: "" },
      { password: MARK + "x".repeat(PASSWORD_MAX_LEN) },
    ]) assertFail(await readLoginPassword(postJson(v)), 400, JSON.stringify(v).slice(0, 60));
  });

  await t("login: not JSON → 400; oversized → 413", async () => {
    assertFail(await readLoginPassword(post(MARK)), 400, "not json");
    assertFail(await readLoginPassword(post(JSON.stringify({ password: MARK.repeat(2000) }))), 413, "oversized");
  });

  // --- readPasskeyResponse (app/api/webauthn/auth/verify) ---

  await t("passkey: a well-formed assertion is returned as the same object, unchanged", async () => {
    const a = goodAssertion();
    const r = await readPasskeyResponse(postJson({ response: a }));
    assert.equal(r.ok, true);
    assert.deepEqual((r as { response: unknown }).response, a);
    // Optional fields may be absent.
    const { userHandle: _u, ...bare } = a.response;
    const { authenticatorAttachment: _a, clientExtensionResults: _c, ...min } = { ...a, response: bare };
    assert.equal((await readPasskeyResponse(postJson({ response: min }))).ok, true);
  });

  await t("passkey: body not an object, or response missing / not an object → 400", async () => {
    for (const v of [null, 1, MARK, [], {}, { response: null }, { response: MARK }, { response: [] }, { response: 1 }]) {
      assertFail(await readPasskeyResponse(postJson(v)), 400, JSON.stringify(v));
    }
  });

  await t("passkey: id/rawId/type/response missing or mistyped → 400", async () => {
    const cases: Array<[string, (a: any) => void]> = [
      ["no id", (a) => delete a.id],
      ["id number", (a) => (a.id = 42)],
      ["id object", (a) => (a.id = { MARK })],
      ["id empty", (a) => (a.id = "")],
      ["id too long", (a) => (a.id = MARK + "A".repeat(CRED_ID_MAX_LEN))],
      ["no rawId", (a) => delete a.rawId],
      ["rawId array", (a) => (a.rawId = [MARK])],
      ["no type", (a) => delete a.type],
      ["type wrong", (a) => (a.type = MARK)],
      ["no response", (a) => delete a.response],
      ["response string", (a) => (a.response = MARK)],
      ["response array", (a) => (a.response = [])],
      ["no clientDataJSON", (a) => delete a.response.clientDataJSON],
      ["clientDataJSON number", (a) => (a.response.clientDataJSON = 1)],
      ["no authenticatorData", (a) => delete a.response.authenticatorData],
      ["no signature", (a) => delete a.response.signature],
      ["signature empty", (a) => (a.response.signature = "")],
      ["userHandle number", (a) => (a.response.userHandle = 7)],
      ["clientExtensionResults string", (a) => (a.clientExtensionResults = MARK)],
      ["authenticatorAttachment object", (a) => (a.authenticatorAttachment = {})],
    ];
    for (const [label, mutate] of cases) {
      const a = goodAssertion();
      mutate(a);
      assertFail(await readPasskeyResponse(postJson({ response: a })), 400, label);
    }
  });

  await t("passkey: not JSON → 400; oversized → 413", async () => {
    assertFail(await readPasskeyResponse(post(`{"response":`)), 400, "not json");
    const big = goodAssertion();
    big.response.signature = "A".repeat(BODY_MAX_BYTES);
    assertFail(await readPasskeyResponse(postJson({ response: big })), 413, "oversized");
  });

  console.log(`login-input: ${n} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
