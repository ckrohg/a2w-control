/**
 * @purpose hub/src/alertemail.ts must stay a byte-for-byte copy of planner/src/alertemail.ts (where its layout is tested),
 * so every A2W alert email looks the same. Run with: npx tsx hub/src/alertemail.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = readFileSync(join(__dirname, "alertemail.ts"), "utf8");
const planner = readFileSync(join(__dirname, "..", "..", "planner", "src", "alertemail.ts"), "utf8");
assert.equal(here, planner, "hub/src/alertemail.ts drifted from planner/src/alertemail.ts — copy the planner's over it");
console.log("alertemail.test.ts: hub copy matches the planner");
