// @purpose node:assert suite for lib/command-message.ts — the one line the Control page shows after
// a setpoint send: 200 ✓, 503 not sent, 502 refused, fallback, and 504 "no answer, outcome unknown"
// for an ack timeout and for a link that dropped or was replaced before the ack (the hub's reason
// shown as given, never matched on wording). Run: npx tsx tests/command-message.test.ts
import assert from "node:assert/strict";
import { commandMessage } from "../lib/command-message";

let n = 0;
const all: string[] = [];
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };
const m = (...a: Parameters<typeof commandMessage>) => { const s = commandMessage(...a); all.push(s); return s; };

const TIMEOUT =
  "No answer from the pump within 10 s. The change may still have been applied; check the setpoint before sending again.";
const DROP = "no Pi connected: the link dropped before the ack, so the write may or may not have been applied";
const RECONNECT =
  "Pi reconnected before the ack: the command went out on the old connection, so the write may or may not have been applied";

t("200 with ok and setpoint_c: the read-back °F, rounded", () => {
  assert.equal(m(200, { ok: true, setpoint_c: 21 }, 70), "Set to 70°F ✓");
  assert.equal(m(200, { ok: true, setpoint_c: 45 }, 99), "Set to 113°F ✓");
});

t("200 with ok but no setpoint_c: falls back to the requested °F", () => {
  assert.equal(m(200, { ok: true }, 68), "Set to 68°F ✓");
});

t("200 without ok: not a success, falls to the fallback", () => {
  assert.equal(m(200, {}, 68), "Failed (200).");
});

t("503: Pi offline, not sent (detail ignored)", () => {
  assert.equal(m(503, {}, 68), "Pi offline — command not sent.");
  assert.equal(m(503, { detail: "no Pi connected" }, 68), "Pi offline — command not sent.");
});

t("504 with no detail: the 10 s no-answer line", () => {
  assert.equal(m(504, {}, 68), TIMEOUT);
  assert.equal(m(504, { detail: "" }, 68), TIMEOUT);
});

t("504 ack timeout: the 10 s no-answer line", () => {
  assert.equal(m(504, { ok: false, detail: "ack timeout" }, 68), TIMEOUT);
});

t("504 link dropped before the ack: the hub's reason, nothing about timing out", () => {
  assert.equal(m(504, { ok: false, detail: DROP }, 68), `No answer: ${DROP}. Check the setpoint before sending again.`);
});

t("504 Pi reconnected before the ack: the hub's reason", () => {
  assert.equal(m(504, { ok: false, detail: RECONNECT }, 68), `No answer: ${RECONNECT}. Check the setpoint before sending again.`);
});

t("504 with an unknown (reworded) reason: still shown as given", () => {
  assert.equal(m(504, { detail: "socket replaced mid-write" }, 68), "No answer: socket replaced mid-write. Check the setpoint before sending again.");
  assert.doesNotMatch(m(504, { detail: "socket replaced mid-write" }, 68), /Timed out/);
});

t("502: Rejected with detail, then error, then guardrail nack", () => {
  assert.equal(m(502, { detail: "setpoint above max" }, 68), "Rejected: setpoint above max");
  assert.equal(m(502, { error: "hub unreachable" }, 68), "Rejected: hub unreachable");
  assert.equal(m(502, {}, 68), "Rejected: guardrail nack");
});

t("other statuses: detail, then error, then Failed (status).", () => {
  assert.equal(m(400, { error: "pump_id and numeric value_c required" }, 68), "pump_id and numeric value_c required");
  assert.equal(m(409, { detail: "writes disabled" }, 68), "writes disabled");
  assert.equal(m(500, {}, 68), "Failed (500).");
});

t("non-JSON body (client passes {}): each status still gets a line", () => {
  assert.equal(m(200, {}, 68), "Failed (200).");
  assert.equal(m(504, {}, 68), TIMEOUT);
  assert.equal(m(502, {}, 68), "Rejected: guardrail nack");
  assert.equal(m(401, {}, 68), "Failed (401).");
});

t("a multi-line hub detail is folded onto one line", () => {
  assert.equal(m(504, { detail: "link dropped\nmid-command" }, 68), "No answer: link dropped mid-command. Check the setpoint before sending again.");
  assert.equal(m(502, { detail: "nack\r\nout of range" }, 68), "Rejected: nack out of range");
});

t("no message contains a newline", () => {
  assert.ok(all.length > 0);
  for (const s of all) assert.doesNotMatch(s, /[\r\n]/, s);
});

console.log(`command-message: ${n} passed`);
