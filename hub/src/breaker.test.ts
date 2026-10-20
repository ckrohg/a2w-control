/**
 * @purpose node:assert suite for src/breaker.ts — the hub-side rules of POST /api/breaker: body
 * validation (the 60 s floor mirrored from the owner decision), the ack deadline, the capability
 * check that turns an old bridge into a clean 501, and the env grace parser.
 * Run: npx tsx src/breaker.test.ts
 */
import assert from "node:assert/strict";
import { breakerAckTimeoutMs, bridgeSupportsBreaker, parseGraceMs, validateBreakerBody } from "./breaker";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok   ${name}`); };

t("valid power_cycle defaults off_s to the 60 s floor and trims the circuit", () => {
  assert.deepEqual(validateBreakerBody({ circuit: " Air-Water 2 ", action: "power_cycle" }),
    { ok: true, cmd: { circuit: "Air-Water 2", op: "power_cycle", off_s: 60, source: "armed-dashboard" } });
});

t("source: an audit label — defaults to the dashboard, the backup gate names itself, junk is refused", () => {
  const v = validateBreakerBody({ circuit: "Buffer Tank", action: "close", source: "backup-gate" });
  assert.ok(v.ok && v.cmd.source === "backup-gate");
  for (const source of ["", "Backup", "a b", "x".repeat(33), 7, "hub:x"]) {
    assert.equal(validateBreakerBody({ circuit: "Buffer Tank", action: "close", source }).ok, false, `source ${String(source)}`);
  }
});

t("off_s below 60, above 600, or non-numeric is refused", () => {
  for (const off_s of [59, 0, -1, 601, "60", NaN, Infinity]) {
    const v = validateBreakerBody({ circuit: "Air-Water 2", action: "power_cycle", off_s });
    assert.equal(v.ok, false, `off_s ${String(off_s)}`);
  }
  assert.equal(validateBreakerBody({ circuit: "Air-Water 2", action: "power_cycle", off_s: 180 }).ok, true);
});

t("unknown action / missing or empty circuit is refused", () => {
  assert.equal(validateBreakerBody({ circuit: "Air-Water 1", action: "toggle" }).ok, false);
  assert.equal(validateBreakerBody({ action: "close" }).ok, false);
  assert.equal(validateBreakerBody({ circuit: "   ", action: "close" }).ok, false);
  assert.equal(validateBreakerBody({ circuit: "x".repeat(81), action: "close" }).ok, false);
  assert.equal(validateBreakerBody(null).ok, false);
  assert.equal(validateBreakerBody({ circuit: "Kitchen", action: "open" }).ok, true);
});

t("ack deadline: power_cycle waits off_s + grace; close/open only the grace", () => {
  const pc = { circuit: "Air-Water 2", op: "power_cycle" as const, off_s: 60, source: "armed-dashboard" };
  assert.equal(breakerAckTimeoutMs(pc, 30_000), 90_000);
  assert.equal(breakerAckTimeoutMs({ ...pc, off_s: 180 }, 30_000), 210_000);
  assert.equal(breakerAckTimeoutMs({ ...pc, op: "close" }, 30_000), 30_000);
});

t("capability: only a state frame advertising 'breaker' counts", () => {
  assert.equal(bridgeSupportsBreaker(null), false);
  assert.equal(bridgeSupportsBreaker({}), false);                       // pre-breaker bridge
  assert.equal(bridgeSupportsBreaker({ capabilities: "breaker" }), false);
  assert.equal(bridgeSupportsBreaker({ capabilities: [] }), false);
  assert.equal(bridgeSupportsBreaker({ capabilities: ["breaker"] }), true);
});

t("grace parser: default when unset or malformed", () => {
  assert.equal(parseGraceMs(undefined), 30_000);
  assert.equal(parseGraceMs("abc"), 30_000);
  assert.equal(parseGraceMs("5"), 30_000);
  assert.equal(parseGraceMs("500"), 500);
});

console.log(`breaker.test.ts: ${n} passed`);
