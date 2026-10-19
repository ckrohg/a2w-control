// @purpose node:assert suite for lib/storm-state.ts (#183 mirror half): the banner follows
// /health.storm, not storm_events; hidden when idle, shows the start DATE, says notify-only when
// shaping is off; Tank-page open rows say "open (planner idle)". Run: npx tsx tests/storm-state.test.ts
import assert from "node:assert/strict";
import { stormBanner, stormRowStatus, type HealthStorm } from "../lib/storm-state";

const NOW = Date.parse("2026-10-18T16:00:00Z");
const idle: HealthStorm = { state: "idle", trigger: null, windowEnd: null, enabled: true };
const armed: HealthStorm = { state: "armed", trigger: "manual", windowEnd: "2026-10-19T12:00:00Z", enabled: true };
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };

t("the incident: idle planner + an orphaned open row from Sep 27 → no banner", () => {
  const orphan = { t: Date.parse("2026-09-27T12:33:00Z") / 1000, trigger: "NWS High Wind Warning", ceiling_f: 135 };
  assert.deepEqual(stormBanner(idle, orphan, NOW), { show: false });
});

t("planner unreachable (null) → no banner, even with an open row", () => {
  assert.deepEqual(stormBanner(null, { t: NOW / 1000 - 600, trigger: "manual", ceiling_f: 135 }, NOW), { show: false });
});

t("unknown state string → no banner", () => {
  assert.deepEqual(stormBanner({ ...armed, state: "weird" }, null, NOW), { show: false });
});

t("armed + enabled → banner with start DATE, window end and ceiling", () => {
  const b = stormBanner(armed, { t: Date.parse("2026-10-18T12:33:00Z") / 1000, trigger: "manual", ceiling_f: 135 }, NOW);
  assert.equal(b.show, true);
  if (!b.show) return;
  assert.equal(b.notifyOnly, false);
  assert.equal(b.text, "Storm mode armed — banking heat ahead of manual · since Oct 18, 8:33 AM · window ends Oct 19, 8:00 AM · up to 135 °F");
});

t("STORM_MODE_ENABLED off → notify-only, says the plan is not banking", () => {
  const b = stormBanner({ ...armed, enabled: false }, null, NOW);
  assert.equal(b.show, true);
  if (!b.show) return;
  assert.equal(b.notifyOnly, true);
  assert.match(b.text, /^Storm watch armed \(notify-only\) — manual/);
  assert.match(b.text, /NOT banking extra heat/);
  assert.ok(!/up to/.test(b.text));
});

t("active state says active", () => {
  const b = stormBanner({ state: "active", trigger: "outage", windowEnd: null, enabled: true }, null, NOW);
  assert.ok(b.show && b.text.startsWith("Storm mode active — banking heat ahead of outage"));
});

t("an orphan row with a different trigger is not used for the start date", () => {
  const b = stormBanner(armed, { t: NOW / 1000 - 3600, trigger: "NWS Winter Storm Warning", ceiling_f: 140 }, NOW);
  assert.ok(b.show && !/since/.test(b.text) && !/up to/.test(b.text));
});

t("a matching-trigger row older than 4 days is not used either", () => {
  const b = stormBanner(armed, { t: NOW / 1000 - 5 * 86400, trigger: "manual", ceiling_f: 135 }, NOW);
  assert.ok(b.show && !/since/.test(b.text));
});

t("a planner startedAt beats the table", () => {
  const b = stormBanner({ ...armed, startedAt: "2026-10-18T14:00:00Z" }, { t: NOW / 1000 - 600, trigger: "manual", ceiling_f: null }, NOW);
  assert.ok(b.show && /since Oct 18, 10:00 AM/.test(b.text));
});

t("Tank page rows: closed shows duration; open says what the planner says", () => {
  const s = 1_790_000_000;
  assert.equal(stormRowStatus({ s, e: s + 5400 }, idle), "1.5 h");
  assert.equal(stormRowStatus({ s, e: null }, idle), "open (planner idle)");
  assert.equal(stormRowStatus({ s, e: null }, armed), "open (planner armed)");
  assert.equal(stormRowStatus({ s, e: null }, null), "open (planner state unknown)");
});

console.log(`storm-state: ${n} passed`);
