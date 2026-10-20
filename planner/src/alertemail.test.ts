/**
 * @purpose Assertions for the alert email layout (alertemail.ts): tier banner in words, the action boxed and first,
 * facts as a table, the technical body last, everything escaped. Run with: npx tsx planner/src/alertemail.test.ts
 */
import assert from "node:assert/strict";
import { renderAlertEmail, cleanTitle } from "./alertemail";

const at = new Date("2026-10-20T11:16:00Z");
const html = renderAlertEmail({
  tier: "page", title: "⚠ Heat call active but NO pump is running", source: "A2W planner", at,
  action: "Check both heat pumps are powered and not showing a fault.",
  facts: [["No heat for", "45 min"], ["Tank", "108 °F (target 120 °F)"]],
  body: "HBX stage call active ~45 min with no pump running.\n\nCauses: <pump off> & friends.",
});
assert.match(html, /URGENT · act now/);
assert.match(html, /<h1[^>]*>Heat call active but NO pump is running<\/h1>/, "title cleaned of the ⚠ prefix");
const order = ["URGENT", "WHAT TO DO", "No heat for", "DETAILS", "Dashboard"].map((s) => html.indexOf(s));
assert.deepEqual([...order].sort((a, b) => a - b), order, "banner → action → facts → details → footer");
assert.ok(!order.includes(-1));
assert.match(html, /&lt;pump off&gt; &amp; friends/, "body escaped");
assert.match(html, /Tue, Oct 20, 7:16 AM ET/, "time in Eastern");

const clear = renderAlertEmail({ tier: "page", resolved: true, title: "Unserved call cleared", body: "", action: "x", source: "A2W planner", at });
assert.match(clear, /RESOLVED · no action needed/);
assert.doesNotMatch(clear, /WHAT TO DO/, "an all-clear has no action box");
assert.doesNotMatch(clear, /DETAILS/, "and no empty details block");

const att = renderAlertEmail({ tier: "attention", title: "A2W: Pi running hot", body: "CPU 81°C", source: "A2W Pi", at });
assert.match(att, /NEEDS A LOOK · this week/);
assert.equal(cleanTitle("✅ A2W: planner back online"), "planner back online");

console.log("alertemail: all assertions passed");
