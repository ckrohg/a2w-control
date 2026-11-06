// @purpose node:assert suite for lib/ingest-parse.ts: the pure parsing behind /api/ingest.
// A pump with no id is dropped and its siblings kept (before: a 500 the Pi retried forever);
// events/span/arm rows need a numeric ts (+ pump_id / name) and are capped at 500/1000/500;
// detail becomes JSON text; a null source_id stays null; a malformed system block is null.
// Run: npx tsx tests/ingest-parse.test.ts
import assert from "node:assert/strict";
import {
  parseSnapshotTs, parsePumps, parseEvents, parseSpanRows, parseSpanArmEvents, parseSystem,
  EVENTS_CAP, SPAN_CAP, SPAN_ARM_EVENTS_CAP,
} from "../lib/ingest-parse";

const TS = 1_761_500_000; // 2026-10-26T17:33:20Z
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ✓ ${name}`); };

// ── snapshot ts ───────────────────────────────────────────────────────────────────────────

t("snapshot ts: numeric or numeric string is accepted; missing, zero, NaN, non-numeric → null", () => {
  assert.equal(parseSnapshotTs({ ts: TS }), TS);
  assert.equal(parseSnapshotTs({ ts: String(TS) }), TS);
  assert.equal(parseSnapshotTs({}), null);
  assert.equal(parseSnapshotTs({ ts: 0 }), null);
  assert.equal(parseSnapshotTs({ ts: "abc" }), null);
  assert.equal(parseSnapshotTs({ ts: NaN }), null);
  assert.equal(parseSnapshotTs({ ts: {} }), null);
  assert.equal(parseSnapshotTs(null), null);
  assert.equal(parseSnapshotTs("not an object"), null);
});

// ── pumps ─────────────────────────────────────────────────────────────────────────────────

t("a pump with no id is dropped; its siblings are kept (the retried-forever 500)", () => {
  const rows = parsePumps({ ts: TS, pumps: [
    { id: "pump1", name: "HP1", online: true, state: "heating" },
    { name: "ghost", online: true },            // no id at all
    { id: null, name: "ghost2" },               // null id
    { id: { nested: true }, name: "ghost3" },   // object id
    { id: "", name: "ghost4" },                 // empty id
    { id: "pump2", name: "HP2", online: false },
  ] });
  assert.deepEqual(rows.map((r) => r.id), ["pump1", "pump2"]);
  assert.equal(rows[0].name, "HP1");
  assert.equal(rows[0].online, true);
  assert.equal(rows[0].state, "heating");
  assert.equal(rows[1].online, false);
});

t("a snapshot whose only pump has no id leaves no valid pump (route answers 400, not 500)", () => {
  assert.deepEqual(parsePumps({ ts: TS, pumps: [{ name: "ghost" }] }), []);
  assert.deepEqual(parsePumps({ ts: TS, pumps: [] }), []);
  assert.deepEqual(parsePumps({ ts: TS }), []);
  assert.deepEqual(parsePumps({ ts: TS, pumps: "pump1" }), []);
  assert.deepEqual(parsePumps({ ts: TS, pumps: [null, 42, "pump1"] }), []);
});

t("numeric pump id is stringified; numeric fields normalised, junk → null; online coerced", () => {
  const [r] = parsePumps({ ts: TS, pumps: [{
    id: 7, mode_kind: "dhw", setpoint_c: 52, inlet_c: "41.5", outlet_c: "warm", ambient_c: null,
    power_w: 1234.5, active_faults: 0, error_rate: NaN, online: "yes",
  }] });
  assert.equal(r.id, "7");
  assert.equal(r.modeKind, "dhw");
  assert.equal(r.setpointC, 52);
  assert.equal(r.inletC, 41.5);
  assert.equal(r.outletC, null);
  assert.equal(r.ambientC, null);
  assert.equal(r.powerW, 1234.5);
  assert.equal(r.activeFaults, 0);
  assert.equal(r.errorRate, null);
  assert.equal(r.online, true);
  assert.equal(r.name, null);
  assert.equal(r.state, null);
});

t("full snapshot becomes JSON text only when it is an object", () => {
  const full = { params: { P1: 1 }, status: "ok" };
  const [a, b, c, d] = parsePumps({ ts: TS, pumps: [
    { id: "pump1", full }, { id: "pump2" }, { id: "pump3", full: "str" }, { id: "pump4", full: [1, 2] },
  ] });
  assert.equal(a.full, JSON.stringify(full));
  assert.equal(b.full, null);
  assert.equal(c.full, null);
  assert.equal(d.full, null);
});

// ── events ────────────────────────────────────────────────────────────────────────────────

t("events: pump_id + numeric ts required; missing or non-numeric ts dropped", () => {
  const rows = parseEvents({ events: [
    { pump_id: "pump1", ts: TS, type: "fault", code: "E21" },
    { pump_id: "pump1" },                       // no ts
    { pump_id: "pump1", ts: "soon" },           // non-numeric ts
    { pump_id: "pump1", ts: 0 },                // zero ts
    { ts: TS, type: "orphan" },                 // no pump_id
    { pump_id: "", ts: TS },                    // empty pump_id
    { pump_id: "pump2", ts: String(TS + 1) },   // numeric string ts is fine
    "garbage",
  ] });
  assert.deepEqual(rows.map((r) => [r.pumpId, r.evTs]), [["pump1", TS], ["pump2", TS + 1]]);
  assert.equal(rows[0].type, "fault");
  assert.equal(rows[0].code, "E21");
  assert.equal(rows[0].severity, null);
  assert.equal(rows[0].message, null);
});

t("events: detail is JSON text (object stringified, string untouched, null stays null)", () => {
  const rows = parseEvents({ events: [
    { pump_id: "p", ts: TS, detail: { a: 1, b: [2, 3] } },
    { pump_id: "p", ts: TS, detail: "{\"pre\":true}" },
    { pump_id: "p", ts: TS, detail: null },
    { pump_id: "p", ts: TS },
    { pump_id: "p", ts: TS, detail: 5 },
  ] });
  assert.equal(rows[0].detail, "{\"a\":1,\"b\":[2,3]}");
  assert.equal(rows[1].detail, "{\"pre\":true}");
  assert.equal(rows[2].detail, null);
  assert.equal(rows[3].detail, null);
  assert.equal(rows[4].detail, "5");
});

t("events: source_id null stays null; numeric / numeric string → number", () => {
  const rows = parseEvents({ events: [
    { pump_id: "p", ts: TS, source_id: null },
    { pump_id: "p", ts: TS },
    { pump_id: "p", ts: TS, source_id: 123 },
    { pump_id: "p", ts: TS, source_id: "456" },
  ] });
  assert.deepEqual(rows.map((r) => r.sourceId), [null, null, 123, 456]);
});

t("events: capped at 500, counted before validation (cap bounds the push, not the stored rows)", () => {
  const events = Array.from({ length: EVENTS_CAP + 50 }, (_, i) => ({ pump_id: "p", ts: TS + i }));
  assert.equal(parseEvents({ events }).length, EVENTS_CAP);
  assert.equal(EVENTS_CAP, 500);
  // an invalid row inside the cap window is dropped, and nothing beyond the cap replaces it
  const withHole = [...events];
  withHole[10] = { pump_id: "p", ts: NaN };
  assert.equal(parseEvents({ events: withHole }).length, EVENTS_CAP - 1);
});

t("events: absent or non-array feed → []", () => {
  assert.deepEqual(parseEvents({}), []);
  assert.deepEqual(parseEvents({ events: { pump_id: "p", ts: TS } }), []);
  assert.deepEqual(parseEvents(null), []);
});

// ── span ──────────────────────────────────────────────────────────────────────────────────

t("span: ts and name required; capped at 1000", () => {
  const rows = parseSpanRows({ span: [
    { source_id: 1, ts: TS, circuit_id: "c1", name: "Buffer Tank", power_w: 4500 },
    { source_id: 2, name: "Buffer Tank", power_w: 1 },        // no ts
    { source_id: 3, ts: "x", name: "Buffer Tank" },           // non-numeric ts
    { source_id: 4, ts: TS },                                 // no name
    { source_id: 5, ts: TS, name: "" },                       // empty name
    { source_id: null, ts: TS, name: "Air-Water", power_w: "12.5" },
  ] });
  assert.deepEqual(rows.map((r) => r.sourceId), [1, null]);
  assert.equal(rows[0].sTs, TS);
  assert.equal(rows[0].circuitId, "c1");
  assert.equal(rows[0].name, "Buffer Tank");
  assert.equal(rows[0].powerW, 4500);
  assert.equal(rows[1].powerW, 12.5);
  assert.equal(rows[1].circuitId, null);
  const span = Array.from({ length: SPAN_CAP + 10 }, (_, i) => ({ ts: TS + i, name: "Buffer Tank" }));
  assert.equal(parseSpanRows({ span }).length, SPAN_CAP);
  assert.equal(SPAN_CAP, 1000);
  assert.deepEqual(parseSpanRows({}), []);
});

// ── span_arm_events ───────────────────────────────────────────────────────────────────────

t("span_arm_events: ts required; armed/live are booleans; detail text; capped at 500", () => {
  const rows = parseSpanArmEvents({ span_arm_events: [
    { source_id: 9, ts: TS, circuit_id: "bt", relay_state: "CLOSED", armed: 1, live: "yes", action: "close", detail: { why: "cold" } },
    { source_id: 10, relay_state: "OPEN" },         // no ts
    { source_id: 11, ts: "later" },                 // non-numeric ts
    { ts: TS + 1 },                                 // bare — everything else defaults
  ] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sourceId, 9);
  assert.equal(rows[0].eTs, TS);
  assert.equal(rows[0].circuitId, "bt");
  assert.equal(rows[0].relayState, "CLOSED");
  assert.equal(rows[0].armed, true);
  assert.equal(rows[0].live, true);
  assert.equal(rows[0].action, "close");
  assert.equal(rows[0].detail, "{\"why\":\"cold\"}");
  assert.deepEqual(rows[1], {
    sourceId: null, eTs: TS + 1, circuitId: null, relayState: null,
    armed: false, live: false, action: null, detail: null,
  });
  const span_arm_events = Array.from({ length: SPAN_ARM_EVENTS_CAP + 5 }, (_, i) => ({ ts: TS + i }));
  assert.equal(parseSpanArmEvents({ span_arm_events }).length, SPAN_ARM_EVENTS_CAP);
  assert.equal(SPAN_ARM_EVENTS_CAP, 500);
  assert.deepEqual(parseSpanArmEvents({}), []);
});

// ── system ────────────────────────────────────────────────────────────────────────────────

t("system: null unless an object with a numeric ts", () => {
  assert.equal(parseSystem({}), null);
  assert.equal(parseSystem({ system: null }), null);
  assert.equal(parseSystem({ system: "cpu 40%" }), null);
  assert.equal(parseSystem({ system: [TS] }), null);
  assert.equal(parseSystem({ system: { cpu_pct: 40 } }), null);
  assert.equal(parseSystem({ system: { ts: "n/a", cpu_pct: 40 } }), null);
  assert.equal(parseSystem({ system: { ts: 0 } }), null);
});

t("system: a good block keeps its numbers, junk fields → null", () => {
  const sys = parseSystem({ system: {
    ts: TS, cpu_pct: 12.5, load1: 0.4, load5: 0.3, load15: 0.2, ncpu: 4, mem_used_pct: 55,
    mem_total_mb: 3794, mem_avail_mb: 1700, disk_used_pct: 31, disk_free_gb: 20.1,
    disk_total_gb: "29.5", cpu_temp_c: "hot", uptime_s: 86400,
  } });
  assert.ok(sys);
  assert.equal(sys.ts, TS);
  assert.equal(sys.cpuPct, 12.5);
  assert.equal(sys.ncpu, 4);
  assert.equal(sys.memTotalMb, 3794);
  assert.equal(sys.diskTotalGb, 29.5);
  assert.equal(sys.cpuTempC, null);
  assert.equal(sys.uptimeS, 86400);
  const sparse = parseSystem({ system: { ts: String(TS) } });
  assert.ok(sparse);
  assert.equal(sparse.ts, TS);
  assert.equal(sparse.load1, null);
});

console.log(`ingest-parse: ${n} passed`);
