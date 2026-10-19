// @purpose #165: assertions for lib/pi-tile.ts — malformed / partial / hostile /health bodies render as unavailable,
// never throw or inject markup. Run with: npx tsx analytics-mirror/lib/pi-tile.test.ts (the mirror has no test job;
// planner CI does not run it — local check, recorded in the PR).
import assert from "node:assert/strict";
import { normalizePi, normalizeHub, esc, PI_TILE_MAX_AGE_MS } from "./pi-tile";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const fresh = new Date(NOW - 4 * 60_000).toISOString();
const good = { ok: false, pi: { computed_at: fresh, reboots_7d: 3, summary: { count: 5, longest_min: 130, verdicts: { "gap+reboot": 2, gap_only: 1, socket_only: 2, unknown: 0 } } } };
assert.deepEqual(normalizePi(good, NOW), { count: 5, longestMin: 130, gapReboot: 2, gapOnly: 1, socketOnly: 2, unknown: 0, reboots7d: 3 },
  "a 503 body (ok:false) with a fresh pi block still renders");
// codex pass 6: a cached computation from long ago (refreshes failing for a week) is NOT this week's numbers
const old = { ...good, pi: { ...good.pi, computed_at: new Date(NOW - 7 * 86_400_000).toISOString(), refresh_error: "connection terminated" } };
assert.equal(normalizePi(old, NOW), null, "a week-old computation renders as unavailable");
assert.equal(normalizePi({ ...good, pi: { ...good.pi, computed_at: new Date(NOW - PI_TILE_MAX_AGE_MS - 1).toISOString() } }, NOW), null, "just past the limit");
assert.ok(normalizePi({ ...good, pi: { ...good.pi, computed_at: new Date(NOW - PI_TILE_MAX_AGE_MS + 60_000).toISOString(), refresh_error: "blip" } }, NOW),
  "one failed refresh after a recent success still renders");
assert.equal(normalizePi({ ...good, pi: { ...good.pi, computed_at: "yesterday" } }, NOW), null, "unparseable computed_at");
assert.equal(normalizePi({ ...good, pi: { ...good.pi, computed_at: undefined } }, NOW), null, "missing computed_at");
assert.equal(normalizePi({ ...good, pi: { ...good.pi, computed_at: new Date(NOW + 3_600_000).toISOString() } }, NOW), null, "from the future");
for (const bad of [
  null, undefined, "x", 7, {}, { pi: null }, { pi: { pending: true } },
  { pi: { summary: { count: 1 } } },                                         // verdicts missing (the codex case)
  { pi: { summary: { count: "1<script>", verdicts: { "gap+reboot": 0, gap_only: 0, socket_only: 0 } } } },
  { pi: { summary: { count: 1, verdicts: { "gap+reboot": "<b>2</b>", gap_only: 0, socket_only: 0 } } } },
  { pi: { summary: { count: -1, verdicts: { "gap+reboot": 0, gap_only: 0, socket_only: 0 } } } },
  { pi: { summary: { count: 1.5, verdicts: { "gap+reboot": 0, gap_only: 0, socket_only: 0 } } } },
  { pi: { summary: { count: Infinity, verdicts: { "gap+reboot": 0, gap_only: 0, socket_only: 0 } } } },
]) assert.equal(normalizePi(bad && typeof bad === "object" && "pi" in bad && bad.pi && typeof bad.pi === "object" ? { ...bad, pi: { computed_at: fresh, ...bad.pi } } : bad, NOW), null, `malformed → unavailable: ${JSON.stringify(bad)}`);
// tolerated optional fields: hostile values become null, never strings
assert.equal(normalizePi({ pi: { computed_at: fresh, reboots_7d: "<img>", summary: { count: 0, longest_min: "x", verdicts: { "gap+reboot": 0, gap_only: 0, socket_only: 0 } } } }, NOW)?.reboots7d, null);
assert.equal(normalizePi({ pi: { computed_at: fresh, summary: { count: 0, longest_min: "x", verdicts: { "gap+reboot": 0, gap_only: 0, socket_only: 0 } } } }, NOW)?.longestMin, null);

assert.deepEqual(normalizeHub({ ok: true, pi_dropouts_24h: 1, pi_dropouts_7d: 4, longest_dropout_min: 131.2, tracking_since: "2026-10-18T20:00:00Z" }),
  { d7: 4, d24: 1, longest24Min: 131.2, since: "2026-10-18T20:00:00.000Z" });
assert.equal(normalizeHub({ ok: true, pi_connected: true }), null, "a hub before #178 has no counters");
assert.equal(normalizeHub({ pi_dropouts_24h: "1", pi_dropouts_7d: 4 }), null);
assert.equal(normalizeHub(null), null);
assert.equal(normalizeHub({ pi_dropouts_24h: 1, pi_dropouts_7d: 4, tracking_since: "<script>alert(1)</script>" })?.since, null, "a non-date string never reaches the page");
assert.equal(esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
console.log("pi-tile.test.ts: all assertions passed");
