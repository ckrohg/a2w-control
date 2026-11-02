// @purpose node:assert suite for lib/armed.ts — the 5-minute armed cookie must expire on the
// SERVER: round trip ok, expired rejected, tampered HMAC or exp rejected, wrong secret rejected,
// garbage rejected, far-future exp rejected, empty secret rejected; armedKeyFrom refuses a
// cookie signed with the session secret alone and fails closed on missing env. No next/headers import.
// Run: npx tsx tests/auth-armed.test.ts
import assert from "node:assert/strict";
import { ARMED_TTL_S, armedKeyFrom, mintArmed, verifyArmed } from "../lib/armed";

const SECRET = "test-view-session-secret-0123456789";
const NOW = 1_800_000_000_000;
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };

t("mint produces `${expMs}.${64 hex}` with expMs = now + ttl", () => {
  const v = mintArmed(SECRET, NOW, 300);
  const m = /^(\d+)\.([0-9a-f]{64})$/.exec(v);
  assert.ok(m, v);
  assert.equal(Number(m![1]), NOW + 300_000);
  assert.equal(ARMED_TTL_S, 300);
});

t("round trip: verifies at mint time and just before expiry", () => {
  const v = mintArmed(SECRET, NOW, 300);
  assert.equal(verifyArmed(SECRET, v, NOW), true);
  assert.equal(verifyArmed(SECRET, v, NOW + 299_999), true);
});

t("expired: rejected at and after expMs", () => {
  const v = mintArmed(SECRET, NOW, 300);
  assert.equal(verifyArmed(SECRET, v, NOW + 300_000), false);
  assert.equal(verifyArmed(SECRET, v, NOW + 300_001), false);
  assert.equal(verifyArmed(SECRET, v, NOW + 86_400_000), false);
});

t("tampered HMAC rejected (one hex char flipped)", () => {
  const v = mintArmed(SECRET, NOW, 300);
  const [exp, mac] = v.split(".");
  const flipped = (mac[0] === "0" ? "1" : "0") + mac.slice(1);
  assert.equal(verifyArmed(SECRET, `${exp}.${flipped}`, NOW), false);
});

t("tampered exp rejected (pushed later without re-signing)", () => {
  const v = mintArmed(SECRET, NOW, 300);
  const [exp, mac] = v.split(".");
  assert.equal(verifyArmed(SECRET, `${Number(exp) + 1}.${mac}`, NOW), false);
  assert.equal(verifyArmed(SECRET, `${Number(exp) + 60_000}.${mac}`, NOW), false);
});

t("wrong secret rejected", () => {
  const v = mintArmed(SECRET, NOW, 300);
  assert.equal(verifyArmed("some-other-secret", v, NOW), false);
  assert.equal(verifyArmed(SECRET + "x", v, NOW), false);
});

t("empty secret rejected by verify and refused by mint", () => {
  const v = mintArmed(SECRET, NOW, 300);
  assert.equal(verifyArmed("", v, NOW), false);
  assert.throws(() => mintArmed("", NOW, 300));
});

t("far-future exp rejected even when correctly signed (> now + ttl + 60 s)", () => {
  // A value minted with a huge ttl is signed correctly, but a verifier using the 300 s ttl
  // must refuse it: a 5-minute gate cannot accept a day-long claim.
  const v = mintArmed(SECRET, NOW, 86_400);
  assert.equal(verifyArmed(SECRET, v, NOW), false);
  // Exactly at the slack boundary is allowed; one ms past is not.
  const edge = mintArmed(SECRET, NOW, 360);
  assert.equal(verifyArmed(SECRET, edge, NOW), true);
  assert.equal(verifyArmed(SECRET, edge, NOW - 1), false);
});

t("garbage strings and non-strings rejected", () => {
  const bad: unknown[] = [
    "", ".", "abc", "123", "123.", ".abc", "123.zz", "1.2.3",
    `${NOW + 1000}.${"g".repeat(64)}`,          // non-hex mac
    `${NOW + 1000}.${"a".repeat(63)}`,          // short mac
    `${NOW + 1000}.${"a".repeat(65)}`,          // long mac
    `-${NOW + 1000}.${"a".repeat(64)}`,         // negative exp
    `1e20.${"a".repeat(64)}`,                   // exponent form
    "9".repeat(17) + "." + "a".repeat(64),      // beyond 16 digits
    // bare 64-hex value with no expiry field
    "7d8e5f3a".repeat(8),
    null, undefined, 12345, {}, [], true,
  ];
  for (const v of bad) assert.equal(verifyArmed(SECRET, v, NOW), false, JSON.stringify(v));
});

t("mint refuses non-finite or non-positive ttl/now", () => {
  assert.throws(() => mintArmed(SECRET, NaN, 300));
  assert.throws(() => mintArmed(SECRET, NOW, 0));
  assert.throws(() => mintArmed(SECRET, NOW, -5));
});

// --- armedKeyFrom: the signing key must not be derivable from the a2w_view session cookie ---
const ENV = { VIEW_PASSWORD: "test-view-password", VIEW_SESSION_SECRET: SECRET };

t("key: a cookie signed with VIEW_SESSION_SECRET alone (the session cookie) is refused", () => {
  const key = armedKeyFrom(ENV);
  assert.notEqual(key, SECRET);
  const forged = mintArmed(SECRET, NOW, 300);
  assert.equal(verifyArmed(key, forged, NOW), false);
});

t("key: a correctly signed unexpired cookie passes; an expired one is refused", () => {
  const key = armedKeyFrom(ENV);
  const v = mintArmed(key, NOW, 300);
  assert.equal(verifyArmed(armedKeyFrom({ ...ENV }), v, NOW), true);
  assert.equal(verifyArmed(key, v, NOW + 300_000), false);
});

t("key: depends on both the password and the session secret", () => {
  const v = mintArmed(armedKeyFrom(ENV), NOW, 300);
  assert.equal(verifyArmed(armedKeyFrom({ ...ENV, VIEW_PASSWORD: "other" }), v, NOW), false);
  assert.equal(verifyArmed(armedKeyFrom({ ...ENV, VIEW_SESSION_SECRET: "other" }), v, NOW), false);
});

t("key: missing VIEW_PASSWORD or VIEW_SESSION_SECRET yields \"\" and refuses, never throws", () => {
  const v = mintArmed(armedKeyFrom(ENV), NOW, 300);
  const missing = [
    {},
    { VIEW_SESSION_SECRET: SECRET },
    { VIEW_PASSWORD: ENV.VIEW_PASSWORD },
    { VIEW_PASSWORD: "", VIEW_SESSION_SECRET: SECRET },
    { VIEW_PASSWORD: ENV.VIEW_PASSWORD, VIEW_SESSION_SECRET: "" },
  ];
  for (const env of missing) {
    assert.doesNotThrow(() => armedKeyFrom(env));
    const key = armedKeyFrom(env);
    assert.equal(key, "", JSON.stringify(Object.keys(env)));
    assert.doesNotThrow(() => verifyArmed(key, v, NOW));
    assert.equal(verifyArmed(key, v, NOW), false);
    assert.equal(verifyArmed(key, mintArmed(SECRET, NOW, 300), NOW), false);
  }
});

console.log(`auth-armed: ${n} passed`);
