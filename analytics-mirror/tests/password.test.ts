// @purpose node:assert suite for lib/password.ts: non-string inputs on either side are a mismatch
// (not a throw), a length mismatch is a mismatch without throwing, an exact string matches
// (including non-ASCII), and an empty value on either side never matches — the check fails closed.
// Run: npx tsx tests/password.test.ts
import assert from "node:assert/strict";
import { passwordMatches } from "../lib/password";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };

const PW = "hunter2";

t("non-string given → false, never a throw", () => {
  for (const bad of [123, 0, NaN, {}, [], [PW], null, undefined, true, { length: 7 }, Symbol("s"), 1n] as unknown[]) {
    assert.doesNotThrow(() => passwordMatches(bad, PW));
    assert.equal(passwordMatches(bad, PW), false, String(typeof bad));
  }
});

t("non-string expected → false, never a throw", () => {
  for (const bad of [undefined, null, 0, {}, [PW]] as unknown[]) {
    assert.doesNotThrow(() => passwordMatches(PW, bad));
    assert.equal(passwordMatches(PW, bad), false);
  }
});

t("length mismatch → false, no throw (timingSafeEqual would throw on raw unequal buffers)", () => {
  assert.equal(passwordMatches("hunter", PW), false);
  assert.equal(passwordMatches("hunter22", PW), false);
  assert.equal(passwordMatches(PW + "\0", PW), false);
  assert.equal(passwordMatches("x".repeat(1024), PW), false);
  assert.equal(passwordMatches(PW, PW + PW), false);
});

t("same length, different content → false at every position", () => {
  for (let i = 0; i < PW.length; i++) {
    const v = PW.slice(0, i) + (PW[i] === "x" ? "y" : "x") + PW.slice(i + 1);
    assert.equal(passwordMatches(v, PW), false, `pos ${i}`);
  }
  assert.equal(passwordMatches("HUNTER2", PW), false);
});

t("exact match → true, including non-ASCII", () => {
  assert.equal(passwordMatches(PW, PW), true);
  assert.equal(passwordMatches("pässwörd", "pässwörd"), true);
  assert.equal(passwordMatches("密码🔑", "密码🔑"), true);
  // Same UTF-16 length, different UTF-8 bytes.
  assert.equal(passwordMatches("pässwörd", "passwörd"), false);
});

t("empty on either side → false (fails closed)", () => {
  assert.equal(passwordMatches("", PW), false);
  assert.equal(passwordMatches(PW, ""), false);
  assert.equal(passwordMatches("", ""), false);
  assert.equal(passwordMatches(0, ""), false);
});

console.log(`password: ${n} passed`);
