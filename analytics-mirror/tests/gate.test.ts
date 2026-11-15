// @purpose node:assert suite for lib/gate.ts — the middleware gate. Every route open today stays
// open; prefix cousins (/api/ingestX, /api/digest-preview, /api/loginfoo) and everything else
// (/api/hub/command, /, webauthn register) are gated; viewCookieOk is exact and fails closed on
// an empty or unset cookie or secret. No Next import.
// Run: npx tsx tests/gate.test.ts
import assert from "node:assert/strict";
import { isOpenPath, viewCookieOk } from "../lib/gate";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };

// --- isOpenPath ---

t("every route that is open today is open", () => {
  for (const p of [
    "/login",
    "/api/login",
    "/api/ingest",
    "/api/digest",
    "/api/webauthn/auth",
    "/api/webauthn/auth/options",
    "/api/webauthn/auth/verify",
  ]) assert.equal(isOpenPath(p), true, p);
});

t("prefix cousins of open routes are NOT open", () => {
  for (const p of [
    "/api/ingestX",
    "/api/ingest-debug",
    "/api/ingest/",
    "/api/ingest/foo",
    "/api/digest-preview",
    "/api/digest/",
    "/api/loginfoo",
    "/api/login/",
    "/api/login/x",
    "/login/",
    "/loginx",
    "/api/webauthn/auth/",
    "/api/webauthn/authx",
    "/api/webauthn/auth/other",
    "/api/webauthn/auth/options/",
  ]) assert.equal(isOpenPath(p), false, p);
});

t("control proxies, the root, and webauthn register are gated", () => {
  for (const p of [
    "/",
    "/api/hub/command",
    "/api/hub/arm",
    "/api/hub/breaker",
    "/api/hub/state",
    "/api/hub/write-enable",
    "/api/planner/boost",
    "/api/planner/target",
    "/api/span-arm",
    "/api/logout",
    "/api/webauthn/register/options",
    "/api/webauthn/register/verify",
    "/api",
    "/api/",
    "",
  ]) assert.equal(isOpenPath(p), false, JSON.stringify(p));
});

t("matching is case-sensitive and ignores nothing", () => {
  assert.equal(isOpenPath("/Login"), false);
  assert.equal(isOpenPath("/API/ingest"), false);
  assert.equal(isOpenPath(" /login"), false);
  assert.equal(isOpenPath("/login?next=/"), false);
});

// --- viewCookieOk ---
const SECRET = "test-view-session-secret-0123456789";

t("cookie equal to secret → true", () => {
  assert.equal(viewCookieOk(SECRET, SECRET), true);
  assert.equal(viewCookieOk("a", "a"), true);
});

t("cookie differing by one char → false", () => {
  for (let i = 0; i < SECRET.length; i++) {
    const c = SECRET[i] === "x" ? "y" : "x";
    const v = SECRET.slice(0, i) + c + SECRET.slice(i + 1);
    assert.equal(viewCookieOk(v, SECRET), false, `pos ${i}`);
  }
});

t("cookie differing in length → false (prefix, extension, single char)", () => {
  assert.equal(viewCookieOk(SECRET.slice(0, -1), SECRET), false);
  assert.equal(viewCookieOk(SECRET + "x", SECRET), false);
  assert.equal(viewCookieOk(SECRET + "\0", SECRET), false);
  assert.equal(viewCookieOk(SECRET, SECRET + "x"), false);
  assert.equal(viewCookieOk("a", "ab"), false);
  assert.equal(viewCookieOk("ab", "a"), false);
});

t("secret unset and cookie '' → false; any empty/undefined side → false", () => {
  assert.equal(viewCookieOk("", undefined), false);
  assert.equal(viewCookieOk("", ""), false);
  assert.equal(viewCookieOk(undefined, undefined), false);
  assert.equal(viewCookieOk(undefined, SECRET), false);
  assert.equal(viewCookieOk(null, SECRET), false);
  assert.equal(viewCookieOk(SECRET, undefined), false);
  assert.equal(viewCookieOk(SECRET, ""), false);
  assert.equal(viewCookieOk("", SECRET), false);
});

t("non-string inputs never throw and are refused", () => {
  for (const v of [0, 1, {}, [], true, Symbol("s")] as unknown[]) {
    assert.doesNotThrow(() => viewCookieOk(v as string, SECRET));
    assert.equal(viewCookieOk(v as string, SECRET), false);
    assert.equal(viewCookieOk(SECRET, v as string), false);
  }
});

console.log(`gate: ${n} passed`);
