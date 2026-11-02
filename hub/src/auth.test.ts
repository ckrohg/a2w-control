/**
 * @purpose node:assert suite for src/auth.ts — the bearer roles behind #190's read-only token:
 * client vs read-only vs none, read-only never resolving to client (even when equal), nothing
 * matching an unset secret, and the startup clash check against the other hub secrets.
 * Run: npx tsx src/auth.test.ts
 */
import assert from "node:assert/strict";
import { bearerRole, extractBearer, readonlyTokenClash } from "./auth";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok   ${name}`); };

t("client token → client; read-only token → readonly; anything else → none", () => {
  assert.equal(bearerRole("c", "c", "r"), "client");
  assert.equal(bearerRole("r", "c", "r"), "readonly");
  assert.equal(bearerRole("x", "c", "r"), "none");
  assert.equal(bearerRole("", "c", "r"), "none");
});

t("read-only token unset: behaviour unchanged — client still client, empty bearer is not read-only", () => {
  assert.equal(bearerRole("c", "c", ""), "client");
  assert.equal(bearerRole("", "c", ""), "none");
  assert.equal(bearerRole("", "", ""), "none");
});

t("equal tokens by mistake: the bearer resolves to readonly, never client (no escalation)", () => {
  assert.equal(bearerRole("same", "same", "same"), "readonly");
});

t("startup clash check names the secret the read-only token equals", () => {
  const others = { HUB_CLIENT_TOKEN: "c", HUB_ARM_TOKEN: "a", HUB_PI_TOKEN: "p" };
  assert.equal(readonlyTokenClash("r", others), null);
  assert.equal(readonlyTokenClash("", others), null);
  assert.equal(readonlyTokenClash("c", others), "HUB_CLIENT_TOKEN");
  assert.equal(readonlyTokenClash("a", others), "HUB_ARM_TOKEN");
  assert.equal(readonlyTokenClash("p", others), "HUB_PI_TOKEN");
  assert.equal(readonlyTokenClash("r", { HUB_ARM_TOKEN: "" }), null, "an unset secret is no clash");
  assert.equal(readonlyTokenClash("c\n", others), "HUB_CLIENT_TOKEN", "a trailing newline hides no clash");
  assert.equal(readonlyTokenClash("r", { HUB_ARM_TOKEN: "r\n" }), "HUB_ARM_TOKEN", "nor on the other secret");
  assert.equal(readonlyTokenClash(" \n", others), null, "blank is unset");
});

t("extractBearer: case-insensitive scheme, trimmed, empty when absent", () => {
  assert.equal(extractBearer("bearer  tok "), "tok");
  assert.equal(extractBearer(undefined), "");
  assert.equal(extractBearer("Basic tok"), "");
});

console.log(`auth.test.ts: ${n} passed`);
