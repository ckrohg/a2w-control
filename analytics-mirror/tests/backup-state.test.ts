// @purpose node:assert suite for lib/backup-state.ts (#184): the Home backup line reads the element
// breaker; red when OPEN, amber when CLOSED, unknown with the age when SPAN data is > 15 min old, the
// 7-day HBX call count as its own line, and never a ✓. Run: npx tsx tests/backup-state.test.ts
import assert from "node:assert/strict";
import { backupView, type BackupInputs } from "../lib/backup-state";

const NOW = 1_792_000_000; // unix s
const base: BackupInputs = { nowS: NOW, relay: null, latestPower: null, episodes7d: 0, lastCalled: null, calledNow: false };
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };

t("breaker OPEN, fresh → red with the reason", () => {
  const v = backupView({ ...base, relay: { relay_state: "OPEN", ts: NOW - 60 } });
  assert.equal(v.tone, "red");
  assert.match(v.headline, /^Backup unavailable — element breaker OPEN/);
  assert.equal(v.calledLine, "HBX would have called it 0× in 7 d");
});

t("the incident: breaker OPEN, never called → still red (was a green ✓)", () => {
  const v = backupView({ ...base, relay: { relay_state: "OPEN", ts: NOW - 120 }, episodes7d: 0 });
  assert.equal(v.tone, "red");
  assert.ok(!/✓/.test(v.headline + v.calledLine + v.chip));
});

t("breaker OPEN while the HBX calls it now → red, says it cannot run", () => {
  const v = backupView({ ...base, relay: { relay_state: "OPEN", ts: NOW - 30 }, calledNow: true, episodes7d: 2, lastCalled: NOW - 300 });
  assert.equal(v.tone, "red");
  assert.match(v.calledLine, /calling the backup NOW and it cannot run · 2× in 7 d · last /);
});

t("breaker CLOSED, not called → amber 'available, not called in 7 d'", () => {
  const v = backupView({ ...base, relay: { relay_state: "CLOSED", ts: NOW - 60 } });
  assert.equal(v.tone, "amber");
  assert.match(v.headline, /^Backup available, not called in 7 d — element breaker CLOSED/);
  assert.equal(v.calledLine, "HBX called it 0× in 7 d");
});

t("breaker CLOSED, called 3× → amber, count kept as its own line", () => {
  const v = backupView({ ...base, relay: { relay_state: "CLOSED", ts: NOW - 60 }, episodes7d: 3, lastCalled: NOW - 3600 });
  assert.equal(v.tone, "amber");
  assert.match(v.headline, /^Backup available — element breaker CLOSED/);
  assert.match(v.calledLine, /^HBX called it 3× in 7 d · last /);
});

t("relay row 16 min old → unknown with the age, not a state", () => {
  const v = backupView({ ...base, relay: { relay_state: "CLOSED", ts: NOW - 16 * 60 } });
  assert.equal(v.tone, "unknown");
  assert.equal(v.headline, "Backup element state unknown (SPAN data 16 min old).");
});

t("stale OPEN is unknown too — never red or amber from old data", () => {
  const v = backupView({ ...base, relay: { relay_state: "OPEN", ts: NOW - 3 * 3600 } });
  assert.equal(v.tone, "unknown");
  assert.match(v.headline, /SPAN data 180 min old/);
});

t("exactly 15 min old is still fresh", () => {
  assert.equal(backupView({ ...base, relay: { relay_state: "OPEN", ts: NOW - 15 * 60 } }).tone, "red");
});

t("no SPAN data at all → unknown 'no SPAN data'", () => {
  const v = backupView(base);
  assert.equal(v.tone, "unknown");
  assert.equal(v.headline, "Backup element state unknown (no SPAN data).");
});

t("stale relay but a fresh Buffer Tank draw proves CLOSED", () => {
  const v = backupView({ ...base, relay: { relay_state: "OPEN", ts: NOW - 3600 }, latestPower: { ts: NOW - 60, power_w: 16000 } });
  assert.equal(v.tone, "amber");
  assert.match(v.headline, /element drawing 16000 W/);
});

t("a fresh 0 W reading does not prove anything", () => {
  const v = backupView({ ...base, latestPower: { ts: NOW - 60, power_w: 0 } });
  assert.equal(v.tone, "unknown");
  assert.equal(v.headline, "Backup element state unknown (SPAN data 1 min old).");
});

t("unrecognised relay value → unknown, quoted", () => {
  const v = backupView({ ...base, relay: { relay_state: "UNKNOWN", ts: NOW - 60 } });
  assert.equal(v.tone, "unknown");
  assert.match(v.headline, /relay state "UNKNOWN" not recognised/);
});

t("a millisecond stamp is read as seconds", () => {
  assert.equal(backupView({ ...base, relay: { relay_state: "OPEN", ts: (NOW - 60) * 1000 } }).tone, "red");
});

t("no tone renders a ✓ anywhere", () => {
  for (const relay_state of ["OPEN", "CLOSED", null]) {
    const v = backupView({ ...base, relay: { relay_state, ts: NOW - 60 } });
    assert.ok(!/✓/.test(JSON.stringify(v)));
  }
});

console.log(`backup-state: ${n} passed`);
