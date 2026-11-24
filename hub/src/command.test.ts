/**
 * @purpose node:assert suite for src/command.ts — the hub-side rules of POST /api/command: body
 * validation (every 400 message verbatim), the lease/source defaults, and settling the pending
 * map exactly once (one ack, or every setpoint entry's onLinkLost — the route's 504 — when the Pi
 * drops or is replaced mid-command, whichever comes first; a nack stays on the resolve/502 path;
 * breaker / write-enable entries are left to their own timeout).
 * Run: npx tsx src/command.test.ts
 */
import assert from "node:assert/strict";
import {
  DEFAULT_COMMAND_SOURCE, failPendingOnDisconnect, parseCommandBody, PI_DISCONNECTED_DETAIL, settlePending,
  type PendingEntry,
} from "./command";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok   ${name}`); };

const fail = (body: unknown) => {
  const v = parseCommandBody(body);
  assert.equal(v.ok, false, `expected a 400 for ${JSON.stringify(body)}`);
  return (v as { ok: false; detail: string }).detail;
};

t("pump_id missing, empty or not a string is a 400 with the route's message", () => {
  for (const body of [{ value_c: 40 }, { pump_id: "", value_c: 40 }, { pump_id: 7, value_c: 40 }, null, undefined]) {
    assert.equal(fail(body), "pump_id is required (string)");
  }
});

t("value_c missing, NaN, Infinity or a string is a 400", () => {
  for (const value_c of [undefined, NaN, Infinity, -Infinity, "40", null]) {
    assert.equal(fail({ pump_id: "aw1", value_c }), "value_c is required (number)", `value_c ${String(value_c)}`);
  }
});

t("lease_minutes that is not a finite number is a 400", () => {
  for (const lease_minutes of ["30", true, NaN, Infinity, {}]) {
    assert.equal(fail({ pump_id: "aw1", value_c: 40, lease_minutes }), "lease_minutes must be a number when provided");
  }
});

t("source that is not a string is a 400", () => {
  for (const source of [7, true, {}, ["optimizer"]]) {
    assert.equal(fail({ pump_id: "aw1", value_c: 40, source }), "source must be a string when provided");
  }
});

t("checks run in the route's order: pump_id, value_c, lease_minutes, source", () => {
  assert.equal(fail({ value_c: "x", lease_minutes: "x", source: 1 }), "pump_id is required (string)");
  assert.equal(fail({ pump_id: "aw1", lease_minutes: "x", source: 1 }), "value_c is required (number)");
  assert.equal(fail({ pump_id: "aw1", value_c: 40, lease_minutes: "x", source: 1 }), "lease_minutes must be a number when provided");
});

t("null or absent lease_minutes / source take the defaults (null, 'optimizer')", () => {
  for (const extra of [{}, { lease_minutes: null, source: null }]) {
    assert.deepEqual(parseCommandBody({ pump_id: "aw1", value_c: 40, ...extra }),
      { ok: true, cmd: { pump_id: "aw1", value_c: 40, lease_minutes: null, source: DEFAULT_COMMAND_SOURCE } });
  }
  assert.equal(DEFAULT_COMMAND_SOURCE, "optimizer");
});

t("a valid body round-trips; unknown fields are dropped", () => {
  const cmd = { pump_id: "aw2", value_c: 42.5, lease_minutes: 30, source: "planner" };
  assert.deepEqual(parseCommandBody({ ...cmd, extra: "x" }), { ok: true, cmd });
  assert.deepEqual(parseCommandBody({ pump_id: "aw2", value_c: -3, lease_minutes: 0, source: "" }),
    { ok: true, cmd: { pump_id: "aw2", value_c: -3, lease_minutes: 0, source: "" } });
});

type Ack = { id: string; ok: boolean; detail: string };
/** What the /api/command route answers from onLinkLost: never the resolve (nack → 502) path. */
type Lost = { status: 504; detail: string };
const LOST: Lost = { status: 504, detail: PI_DISCONNECTED_DETAIL };

/** `ids` are /api/command setpoints (onLinkLost); `others` stand for breaker / write-enable entries. */
function makePending(ids: string[], others: string[] = []) {
  const pending = new Map<string, PendingEntry<Ack>>();
  const got: Record<string, (Ack | Lost)[]> = {};
  const timedOut: string[] = [];
  for (const id of [...ids, ...others]) {
    got[id] = [];
    // a real timer, so the test also proves settling clears it (a leak would fire and record)
    const timer = setTimeout(() => { if (pending.delete(id)) timedOut.push(id); }, 50);
    pending.set(id, { timer, resolve: (ack) => { got[id].push(ack); },
                      ...(ids.includes(id) ? { onLinkLost: () => { got[id].push(LOST); } } : {}) });
  }
  return { pending, got, timedOut };
}

t("the disconnect detail begins with 'no Pi connected' (planner/src/owneralerts.ts classifies on it)", () => {
  assert.match(PI_DISCONNECTED_DETAIL, /^no Pi connected/);
  assert.ok(/no Pi connected/i.test(PI_DISCONNECTED_DETAIL));
  assert.equal(PI_DISCONNECTED_DETAIL, "no Pi connected: the link dropped before the ack, so the write may or may not have been applied");
});

t("a real nack from the Pi goes through resolve (→ 502), never onLinkLost (→ 504)", () => {
  const { pending, got } = makePending(["a"]);
  assert.equal(settlePending(pending, "a", { id: "a", ok: false, detail: "rate limited" }), true);
  assert.equal(failPendingOnDisconnect(pending), 0);
  assert.deepEqual(got.a, [{ id: "a", ok: false, detail: "rate limited" }]);
});

t("settlePending resolves once; a duplicate ack is a no-op", () => {
  const { pending, got } = makePending(["a"]);
  assert.equal(settlePending(pending, "a", { id: "a", ok: true, detail: "" }), true);
  assert.equal(settlePending(pending, "a", { id: "a", ok: false, detail: "late" }), false);
  assert.equal(settlePending(pending, "nope", { id: "nope", ok: true, detail: "" }), false);
  assert.deepEqual(got.a, [{ id: "a", ok: true, detail: "" }]);
  assert.equal(pending.size, 0);
});

t("ack then disconnect: the ack wins, the disconnect sweep does not touch it", () => {
  const { pending, got } = makePending(["a"]);
  assert.equal(settlePending(pending, "a", { id: "a", ok: true, detail: "ok" }), true);
  assert.equal(failPendingOnDisconnect(pending), 0);
  assert.deepEqual(got.a, [{ id: "a", ok: true, detail: "ok" }]);
});

t("disconnect then late ack: the 504 wins, the late ack is a no-op", () => {
  const { pending, got } = makePending(["a"]);
  assert.equal(failPendingOnDisconnect(pending), 1);
  assert.equal(settlePending(pending, "a", { id: "a", ok: true, detail: "late" }), false);
  assert.deepEqual(got.a, [LOST]);
});

t("failPendingOnDisconnect fails every pending setpoint exactly once with the 504, then is a no-op", () => {
  const { pending, got } = makePending(["a", "b", "c"]);
  settlePending(pending, "b", { id: "b", ok: true, detail: "acked" }); // b acked before the drop
  assert.equal(failPendingOnDisconnect(pending), 2);
  assert.equal(failPendingOnDisconnect(pending), 0);
  assert.equal(pending.size, 0);
  assert.deepEqual(got.a, [LOST]);
  assert.deepEqual(got.b, [{ id: "b", ok: true, detail: "acked" }]);
  assert.deepEqual(got.c, [LOST]);
});

t("breaker / write-enable entries (no onLinkLost) stay pending for their own ack or timeout", () => {
  const { pending, got } = makePending(["set"], ["brk"]);
  assert.equal(failPendingOnDisconnect(pending), 1);
  assert.deepEqual([...pending.keys()], ["brk"]);
  assert.deepEqual(got.brk, []);
  assert.equal(settlePending(pending, "brk", { id: "brk", ok: true, detail: "verified" }), true);
  assert.deepEqual(got.brk, [{ id: "brk", ok: true, detail: "verified" }]);
});

t("failPendingOnDisconnect survives an onLinkLost that mutates the map mid-sweep", () => {
  const { pending, got } = makePending(["a", "b"]);
  // a's callback settles b itself (as a racing ack would); b must still be settled only once
  const aEntry = pending.get("a")!;
  pending.set("a", { ...aEntry, onLinkLost: () => { aEntry.onLinkLost!(); settlePending(pending, "b", { id: "b", ok: true, detail: "race" }); } });
  assert.equal(failPendingOnDisconnect(pending), 1);
  assert.deepEqual(got.a, [LOST]);
  assert.deepEqual(got.b, [{ id: "b", ok: true, detail: "race" }]);
});

// settled entries' timers must have been cleared, and an unswept entry's must still run:
// wait past their 50 ms and check that only the breaker-like one fired
const probe = makePending(["x"], ["y"]);
failPendingOnDisconnect(probe.pending);
setTimeout(() => {
  assert.deepEqual(probe.timedOut, ["y"], "a settled entry's timeout fired, or an unswept one's did not");
  n++; console.log("  ok   settling clears the ack timeout; unswept entries still time out");
  console.log(`command: ${n} passed`);
}, 120);
