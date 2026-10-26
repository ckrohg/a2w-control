// @purpose node:assert suite for lib/planner-health.ts: the three exported /health readers share one
// fetcher, so env gating, URL building, the bearer header, non-JSON / unreachable handling and the
// 502/503 status shapes are checked once here. Stubs globalThis.fetch and process.env; no network.
// Run: npx tsx tests/planner-health.test.ts
import assert from "node:assert/strict";
import { fetchPlannerStorm, fetchPlannerPumpHealth, fetchPlannerBackupGate } from "../lib/planner-health";

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log(`  ✓ ${name}`); };

type Call = { url: string; init: RequestInit | undefined };
const calls: Call[] = [];
const realFetch = globalThis.fetch;

/** Make fetch answer with `body` (a string is sent verbatim, anything else JSON-encoded) at `status`. */
function stubResponse(body: unknown, status = 200) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}
function stubThrow(message: string) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    throw new Error(message);
  }) as typeof fetch;
}
function env(url: string | undefined, token: string | undefined) {
  if (url === undefined) delete process.env.PLANNER_URL; else process.env.PLANNER_URL = url;
  if (token === undefined) delete process.env.PLANNER_API_TOKEN; else process.env.PLANNER_API_TOKEN = token;
}

const storm = { state: "armed", trigger: "manual", windowEnd: "2026-10-19T12:00:00Z", enabled: true, startedAt: "2026-10-18T14:00:00Z" };
const pump = { mode: "shadow", pumps: { hp1: { verdict: "ok" } } };
const gate = { mode: "shadow", decision: "open" };

async function main() {
  await t("unset PLANNER_URL → 503 'planner not configured' for all three, and fetch is never called", async () => {
    env(undefined, "tok");
    stubResponse({ storm, pump_health: pump, backup_gate: gate });
    assert.deepEqual(await fetchPlannerStorm(), { storm: null, status: 503, error: "planner not configured" });
    assert.deepEqual(await fetchPlannerPumpHealth(), { pumpHealth: null, status: 503, error: "planner not configured" });
    assert.deepEqual(await fetchPlannerBackupGate(), { backupGate: null, status: 503, error: "planner not configured" });
    assert.equal(calls.length, 0);
  });

  await t("unset PLANNER_API_TOKEN → 503 'planner not configured' for all three", async () => {
    env("https://planner.example", undefined);
    assert.deepEqual(await fetchPlannerStorm(), { storm: null, status: 503, error: "planner not configured" });
    assert.deepEqual(await fetchPlannerPumpHealth(), { pumpHealth: null, status: 503, error: "planner not configured" });
    assert.deepEqual(await fetchPlannerBackupGate(), { backupGate: null, status: 503, error: "planner not configured" });
    assert.equal(calls.length, 0);
  });

  await t("trailing slash on PLANNER_URL is stripped; Authorization carries the bearer token; no-store", async () => {
    env("https://planner.example//", "secret-token");
    stubResponse({ storm });
    const r = await fetchPlannerStorm();
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://planner.example/health");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret-token");
    assert.equal(calls[0].init?.cache, "no-store");
    assert.ok(calls[0].init?.signal instanceof AbortSignal, "a timeout signal is attached");
  });

  await t("a 503 /health body that still carries a well-formed storm block → 200 with the storm", async () => {
    env("https://planner.example", "tok");
    stubResponse({ ok: false, storm }, 503);
    assert.deepEqual(await fetchPlannerStorm(), { storm, status: 200 });
  });

  await t("storm shape validation: missing optional fields normalize to null / false", async () => {
    env("https://planner.example", "tok");
    stubResponse({ storm: { state: "idle", trigger: 7, enabled: "yes" } });
    assert.deepEqual(await fetchPlannerStorm(), {
      storm: { state: "idle", trigger: null, windowEnd: null, enabled: false, startedAt: null },
      status: 200,
    });
  });

  await t("body without the key → 502 with the planner's HTTP status in the message", async () => {
    env("https://planner.example", "tok");
    stubResponse({ ok: true }, 503);
    const s = await fetchPlannerStorm();
    assert.equal(s.storm, null);
    assert.equal(s.status, 502);
    assert.match(s.error ?? "", /\(503\)/);
    const p = await fetchPlannerPumpHealth();
    assert.deepEqual(p, { pumpHealth: null, status: 502, error: "planner health gave no pump_health (503)" });
    const g = await fetchPlannerBackupGate();
    assert.deepEqual(g, { backupGate: null, status: 502, error: "planner health gave no backup_gate (503)" });
  });

  await t("non-JSON body → 502 (treated as an empty body, planner status in the message)", async () => {
    env("https://planner.example", "tok");
    stubResponse("<html>bad gateway</html>", 200);
    const s = await fetchPlannerStorm();
    assert.equal(s.status, 502);
    assert.equal(s.storm, null);
    assert.match(s.error ?? "", /\(200\)/);
    const p = await fetchPlannerPumpHealth();
    assert.equal(p.status, 502);
    assert.equal(p.pumpHealth, null);
  });

  await t("fetch throwing (timeout / DNS) → 502 'planner unreachable' for all three", async () => {
    env("https://planner.example", "tok");
    stubThrow("ECONNREFUSED");
    const s = await fetchPlannerStorm();
    assert.deepEqual([s.storm, s.status], [null, 502]);
    assert.match(s.error ?? "", /^planner unreachable: .*ECONNREFUSED/);
    const p = await fetchPlannerPumpHealth();
    assert.deepEqual([p.pumpHealth, p.status], [null, 502]);
    assert.match(p.error ?? "", /^planner unreachable/);
    const g = await fetchPlannerBackupGate();
    assert.deepEqual([g.backupGate, g.status], [null, 502]);
    assert.match(g.error ?? "", /^planner unreachable/);
  });

  await t("storm block with a non-string state → 502, storm null", async () => {
    env("https://planner.example", "tok");
    stubResponse({ storm: { state: 3, enabled: true } });
    const s = await fetchPlannerStorm();
    assert.equal(s.storm, null);
    assert.equal(s.status, 502);
    assert.match(s.error ?? "", /no storm state/);
  });

  await t("storm block that is a bare string → 502 too", async () => {
    env("https://planner.example", "tok");
    stubResponse({ storm: "armed" });
    assert.equal((await fetchPlannerStorm()).status, 502);
  });

  await t("pump_health block is passed through raw (no normalization here)", async () => {
    env("https://planner.example", "tok");
    stubResponse({ pump_health: pump, backup_gate: gate }, 503);
    assert.deepEqual(await fetchPlannerPumpHealth(), { pumpHealth: pump, status: 200 });
    assert.deepEqual(await fetchPlannerBackupGate(), { backupGate: gate, status: 200 });
  });

  await t("each reader hits /health once per call (no sharing/caching between the three)", async () => {
    env("https://planner.example", "tok");
    calls.length = 0;
    stubResponse({ storm, pump_health: pump, backup_gate: gate });
    await fetchPlannerStorm();
    await fetchPlannerPumpHealth();
    await fetchPlannerBackupGate();
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.url === "https://planner.example/health"));
  });
}

main()
  .then(() => { globalThis.fetch = realFetch; console.log(`planner-health: ${n} passed`); })
  .catch((e) => { globalThis.fetch = realFetch; console.error(e); process.exit(1); });
