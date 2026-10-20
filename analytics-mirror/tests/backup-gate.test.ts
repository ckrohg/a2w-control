// @purpose node:assert suite for lib/backup-gate.ts: the card's view of the planner's /health.backup_gate. The sample is
// the shape planner/src/backupgate.ts serves (BackupGate.status() + index.ts's relay / pi_fallback), with values from
// the incident replay (Oct 15 13:30 ET: pump2 E21, tank 102 °F vs 119.5, 90 min not recovering → would close). Pins:
// shadow never reads as the real breaker; the real relay line is separate; blind → "not judged"; a planner without the
// block → unavailable; the Pi fallback passes through; junk is tolerated. Run: npx tsx tests/backup-gate.test.ts
import assert from "node:assert/strict";
import { backupGateView, gateChip, relayLine } from "../lib/backup-gate";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };
const sample = {
  mode: "shadow", reopen_enabled: false,
  thresholds: { deficit_f: 10, rise_f: 3, rise_window_min: 20, fail_hold_min: 90, floor_f: 100, floor_hold_min: 30, open_margin_f: 5, open_hold_min: 60, min_dwell_min: 120 },
  gate_state: "closed", gate_state_virtual: true, closed_by_gate: true, relay: "OPEN", pending: null,
  last_action_at: "2026-10-15T17:30:00.000Z", retry_at: null, override_until: null,
  clocks: { failed_not_recovering_min: 0, floor_min: 0, recovered_min: 0 },
  conditions: { called: true, tank_f: 102.1, target_f: 119.5, deficit_f: 17.4, rise_f: -1.5, failed: [{ id: "pump2", why: "fault" }], available: ["pump1"], all_available_engaged: false, failed_not_recovering: true, floor: false, recovered: false },
  last_event: { at: "2026-10-15T17:30:00.000Z", kind: "close", rule: "failed_not_recovering", title: "Backup element gate (shadow): WOULD close the breaker" },
  circuit: "Buffer Tank", blind: null, error: null, element_w: 0, episodes_7d: 1, config_errors: [], live_ready: true,
  pi_fallback: { enabled: true, live: false, mode: "shadow", hold_min: 30, circuit: "Buffer Tank", breaker_control: true, down: { pump1: null, pump2: "is faulted (E21)" }, all_down_min: null, all_down_since: null, relay: "OPEN", last: null },
};

t("a shadow would-close reads as shadow, and the real breaker stays OFF on its own line", () => {
  const v = backupGateView(sample);
  assert.equal(v.available, true);
  assert.equal(v.mode, "shadow");
  assert.equal(v.gateState, "closed");
  assert.equal(v.virtual, true);
  assert.deepEqual(gateChip(v), { cls: "warn", text: "would be ON (shadow)" });
  assert.equal(relayLine(v), "Breaker: OFF (open) · element 0 W");
  assert.deepEqual(v.conditions.failed, ["pump2 fault"]);
  assert.equal(v.rules.failedNotRecovering, true);
  assert.equal(v.lastEvent?.kind, "close");
  assert.equal(v.clocks.length, 3, "a closed gate shows its recovery clock too");
  assert.equal(v.deficitF, 10); assert.equal(v.failHoldMin, 90);
  assert.deepEqual(v.piFallback?.down, ["pump2 is faulted (E21)"]);
});

t("normal shadow day: chip says shadow · normal; a running clock says watching", () => {
  const quiet = { ...sample, gate_state: "open", closed_by_gate: false, last_event: null };
  assert.deepEqual(gateChip(backupGateView(quiet)), { cls: "ok", text: "shadow · normal" });
  const watching = { ...quiet, clocks: { failed_not_recovering_min: 35, floor_min: 0, recovered_min: 0 } };
  assert.deepEqual(gateChip(backupGateView(watching)), { cls: "warn", text: "watching" });
  assert.equal(backupGateView(quiet).clocks.length, 2);
});

t("live: a closed gate is the real thing", () => {
  const v = backupGateView({ ...sample, mode: "live", gate_state_virtual: false, relay: "CLOSED", element_w: 16420 });
  assert.deepEqual(gateChip(v), { cls: "warn", text: "element available" });
  assert.equal(relayLine(v), "Breaker: ON (closed) · element 16420 W");
});

t("blind poll → not judged; missing block → unavailable; off → off", () => {
  assert.deepEqual(gateChip(backupGateView({ ...sample, gate_state: "open", blind: "Pi disconnected from the hub" })), { cls: "offline", text: "not judged" });
  assert.deepEqual(gateChip(backupGateView(null)), { cls: "offline", text: "unavailable" });
  assert.deepEqual(gateChip(backupGateView({ ...sample, mode: "off" })), { cls: "off", text: "off" });
});

t("junk is tolerated", () => {
  const v = backupGateView({ mode: 7, clocks: "x", conditions: { failed: [null, 3, { id: "p" }] }, pi_fallback: [], relay: 5 });
  assert.equal(v.available, true);
  assert.equal(v.mode, "unknown");
  assert.equal(v.relay, null);
  assert.deepEqual(v.conditions.failed, ["p"]);
  assert.equal(v.piFallback, null);
  assert.equal(relayLine(v), "Breaker: unknown");
});

console.log(`backup-gate.test.ts: ${n} passed`);
