// @purpose node:assert suite for lib/breaker-state.ts — the SPAN breaker card's states: which
// buttons each circuit gets and why one is disabled (Pi offline, stale data, not controllable,
// busy, not armed, never two heat pumps off, pending re-close), and that a success line appears
// ONLY for a verified read-back matching the request. Run: npx tsx tests/breaker-state.test.ts
import assert from "node:assert/strict";
import { circuitRows, confirmText, outcomeMessage, type SpanCircuit, type SpanSnapshot } from "../lib/breaker-state";

const NOW = 1_800_000_000;
const hp = (name: string, relay = "CLOSED", w = 2400): SpanCircuit => ({
  name, found: true, circuit_id: `c-${name}`, relay_state: relay, controllable: true, power_w: w,
  allow_cycle: true, allow_open: false, heat_pump: true,
});
const tank: SpanCircuit = { ...hp("Buffer Tank", "CLOSED", 0), allow_cycle: false, heat_pump: false };
const snap = (over: Partial<SpanSnapshot> = {}): SpanSnapshot => ({
  ts: NOW - 10, circuits: [hp("Air-Water 1"), hp("Air-Water 2", "CLOSED", 108), tank],
  busy: null, pending_close: [], last: null, min_off_s: 60, max_off_s: 600, ...over,
});
const ok = { connected: true, armed: true, nowSec: NOW };
const btn = (rows: ReturnType<typeof circuitRows>, name: string, action: string) =>
  rows.find((r) => r.name === name)!.buttons.find((b) => b.action === action);
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };

t("armed + fresh + both pumps ON: heat pumps get Power cycle 60 s (enabled) and On (disabled: already ON)", () => {
  const rows = circuitRows(snap(), ok);
  assert.equal(rows.length, 3);
  const aw2 = rows[1];
  assert.equal(aw2.stateLabel, "ON");
  assert.equal(aw2.watts, "108 W");
  assert.deepEqual(aw2.buttons.map((b) => b.label), ["Power cycle 60 s", "On"]);
  assert.equal(btn(rows, "Air-Water 2", "power_cycle")!.enabled, true);
  assert.equal(btn(rows, "Air-Water 2", "close")!.reason, "already ON");
});

t("bridge min_off_s above 60: the dashboard's 60 s cycle is disabled with the reason", () => {
  const rows = circuitRows(snap({ min_off_s: 90 }), ok);
  const b = btn(rows, "Air-Water 2", "power_cycle")!;
  assert.equal(b.enabled, false);
  assert.match(b.reason!, /minimum off time is 90 s/);
});

t("backup element: On only — no power cycle, no Off", () => {
  const rows = circuitRows(snap(), ok);
  assert.deepEqual(rows[2].buttons.map((b) => b.action), ["close"]);
});

t("an allow_open circuit gets an Off button", () => {
  const kitchen = { ...hp("Kitchen", "CLOSED", 40), allow_cycle: false, allow_open: true, heat_pump: false };
  const rows = circuitRows(snap({ circuits: [kitchen] }), ok);
  assert.deepEqual(rows[0].buttons.map((b) => b.label), ["On", "Off"]);
  assert.equal(rows[0].buttons[1].enabled, true);
});

t("not armed: every button disabled with the password hint", () => {
  const rows = circuitRows(snap(), { ...ok, armed: false });
  for (const r of rows) for (const b of r.buttons) {
    assert.equal(b.enabled, false);
  }
  assert.match(btn(rows, "Air-Water 2", "power_cycle")!.reason!, /arm write-mode/);
});

t("Pi offline / stale data: disabled with the reason", () => {
  assert.equal(btn(circuitRows(snap(), { ...ok, connected: false }), "Air-Water 1", "power_cycle")!.reason, "Pi offline");
  const stale = circuitRows(snap({ ts: NOW - 300 }), ok);
  assert.match(btn(stale, "Air-Water 1", "power_cycle")!.reason!, /stale/);
  assert.match(btn(circuitRows(snap({ ts: null }), ok), "Air-Water 1", "close")!.reason!, /stale/);
});

t("one heat pump OFF: the other cannot be cycled; the OFF one offers On", () => {
  const rows = circuitRows(snap({ circuits: [hp("Air-Water 1", "OPEN", 0), hp("Air-Water 2"), tank] }), ok);
  assert.match(btn(rows, "Air-Water 2", "power_cycle")!.reason!, /never two heat pumps off/);
  assert.equal(btn(rows, "Air-Water 1", "close")!.enabled, true);
  assert.equal(btn(rows, "Air-Water 1", "power_cycle")!.reason, "circuit is not ON");
  assert.equal(rows[0].stateLabel, "OFF");
});

t("a cycle in flight: everything disabled, the circuit shows a countdown", () => {
  const busy = { circuit: "Air-Water 2", action: "power_cycle", started: NOW - 20, off_s: 60 };
  const rows = circuitRows(snap({ busy, circuits: [hp("Air-Water 1"), hp("Air-Water 2", "OPEN", 0), tank] }), ok);
  assert.match(rows[1].note!, /back ON in ~40 s/);
  assert.match(btn(rows, "Air-Water 1", "power_cycle")!.reason!, /another action is running/);
  assert.equal(btn(rows, "Air-Water 2", "close")!.enabled, false);
});

t("pending re-close: only On stays possible, with the manual hint on that circuit", () => {
  const rows = circuitRows(snap({ pending_close: ["Air-Water 2"], circuits: [hp("Air-Water 1"), hp("Air-Water 2", "OPEN", 0), tank] }), ok);
  assert.match(rows[1].note!, /COULD NOT/);
  assert.equal(btn(rows, "Air-Water 2", "close")!.enabled, true);
  assert.match(btn(rows, "Air-Water 1", "power_cycle")!.reason!, /not verified back ON/);
});

t("not controllable / not found", () => {
  const rows = circuitRows(snap({ circuits: [{ ...hp("Air-Water 1"), controllable: false },
    { ...hp("Air-Water 2"), found: false, relay_state: null, power_w: null }] }), ok);
  assert.match(rows[0].buttons[0].reason!, /not user-controllable/);
  assert.equal(rows[1].stateLabel, "not found on panel");
  assert.equal(rows[1].watts, "—");
});

t("no span data (old bridge / not configured) → no rows", () => {
  assert.deepEqual(circuitRows(null, ok), []);
  assert.deepEqual(circuitRows(undefined, ok), []);
});

const REQ = { circuit: "Air-Water 2", action: "power_cycle" as const };

t("success line ONLY for a verified read-back matching the request", () => {
  const good = { ok: true, result: { ok: true, circuit: "Air-Water 2", action: "power_cycle",
                                     verified: true, relay_state: "CLOSED", off_s: 61.2 } };
  const m = outcomeMessage(200, good, REQ);
  assert.equal(m.tone, "ok");
  assert.match(m.text, /off 61 s, back ON — confirmed by the panel read-back/);
  // 200 without a read-back, or a read-back that doesn't match, is never a confirmation
  assert.equal(outcomeMessage(200, { ok: true }, REQ).tone, "warn");
  assert.equal(outcomeMessage(200, { ok: true, result: { verified: false, relay_state: "CLOSED" } }, REQ).tone, "warn");
  assert.equal(outcomeMessage(200, { ok: true, result: { verified: true, relay_state: "OPEN" } }, REQ).tone, "warn");
  assert.equal(outcomeMessage(200, { ok: true, result: { circuit: "Kitchen", action: "open", verified: true, relay_state: "OPEN" } },
    { circuit: "Kitchen", action: "open" }).tone, "ok");
  // a read-back for a different circuit / action, or with no identity, never confirms
  assert.equal(outcomeMessage(200, { ok: true, result: { ...good.result, circuit: "Air-Water 1" } }, REQ).tone, "warn");
  assert.equal(outcomeMessage(200, { ok: true, result: { ...good.result, action: "close" } }, REQ).tone, "warn");
  assert.equal(outcomeMessage(200, { ok: true, result: { verified: true, relay_state: "CLOSED" } }, REQ).tone, "warn");
});

t("refused / still OFF / unconfirmed / old bridge / timeout / offline map to plain lines", () => {
  assert.match(outcomeMessage(502, { detail: "refused: x", result: { refused: true, detail: "close-only" } }, REQ).text, /Refused — nothing was switched: close-only/);
  const stuck = outcomeMessage(502, { result: { relay_state: "OPEN", detail: "COULD NOT switch back ON" } }, REQ);
  assert.equal(stuck.tone, "bad");
  assert.match(stuck.text, /may still be OFF/);
  assert.equal(outcomeMessage(502, { detail: "read-back unavailable", result: { relay_state: null } }, REQ).tone, "warn");
  assert.match(outcomeMessage(501, {}, REQ).text, /next bridge release/);
  assert.match(outcomeMessage(504, {}, REQ).text, /may still complete/);
  assert.match(outcomeMessage(503, { detail: "no Pi connected" }, REQ).text, /no Pi connected. Nothing was switched/);
  assert.match(outcomeMessage(403, { error: "not armed — re-enter the password" }, REQ).text, /re-enter the password/);
});

t("confirm text names the circuit and the 60 s", () => {
  const c = confirmText("Air-Water 2", "power_cycle");
  assert.equal(c.title, "Power cycle Air-Water 2");
  assert.match(c.body, /OFF for 60 seconds/);
});

console.log(`breaker-state.test.ts: ${n} passed`);
