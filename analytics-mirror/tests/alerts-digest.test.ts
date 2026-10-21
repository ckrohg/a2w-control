// @purpose Assertions for the digest's alerts block (lib/alerts-digest.ts): what reached the owner vs what was only
// recorded, and repeats grouped by title shape. Run with: npx tsx tests/alerts-digest.test.ts
import assert from "node:assert/strict";
import { summarizeAlerts, alertsHeadline, titleShape } from "../lib/alerts-digest";

assert.equal(titleShape("⚠ Heat Pump 1 offline 12+ min"), "Heat Pump # offline #+ min");
assert.equal(titleShape("Heat Pump 1 offline 47+ min"), titleShape("⚠ Heat Pump 1 offline 12+ min"));

const t = 1_792_000_000;
const s = summarizeAlerts([
  { tier: "page", resolved: false, title: "⚠ Heat Pump 2: E21 for 31 min", ts: t },
  { tier: "page", resolved: true, title: "✓ Heat Pump 2: E21 cleared", ts: t + 60 },
  { tier: "attention", resolved: false, title: "Heat Pump 1: R02 3 times in 7 days", ts: t + 120 },
  { tier: "record", resolved: false, title: "Heat Pump 1 offline 12+ min", ts: t },
  { tier: "record", resolved: false, title: "Heat Pump 1 offline 31+ min", ts: t + 5 },
  { tier: "record", resolved: false, title: "Second planner instance detected — single-writer at risk", ts: t },
  { tier: "record", resolved: true, title: "Planner single-instance restored", ts: t + 600 },
]);
assert.equal(s.pages, 1);
assert.equal(s.emails, 2, "page + attention opens; all-clears are not counted as contacts");
assert.equal(s.recorded, 3);
assert.deepEqual(s.reached.map((r) => r.tier), ["attention", "page"], "newest first");
assert.deepEqual(s.patterns[0], { title: "Heat Pump # offline #+ min", n: 2 }, "repeats grouped");
assert.equal(alertsHeadline(s), "A2W contacted you 2 times (1 urgent); 3 other events recorded and handled.");
assert.equal(alertsHeadline(summarizeAlerts([])), "Nothing needed you this week, and nothing unusual was recorded.");
assert.match(alertsHeadline(summarizeAlerts([{ tier: "record", resolved: false, title: "x", ts: t }])), /^Nothing needed you this week; 1 other event recorded/);

console.log("alerts-digest: all assertions passed");
