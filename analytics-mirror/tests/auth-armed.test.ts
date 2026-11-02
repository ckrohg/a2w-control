// @purpose node:assert suite for lib/armed.ts — the 5-minute armed cookie must expire on the
// SERVER: round trip ok, expired rejected, tampered HMAC or exp rejected, wrong secret rejected,
// garbage rejected, far-future exp rejected, empty secret rejected. No next/headers import.
// Run: npx tsx tests/auth-armed.test.ts
import assert from "node:assert/strict";
import { ARMED_TTL_S, mintArmed, verifyArmed } from "../lib/armed";

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

console.log(`auth-armed: ${n} passed`);
