/**
 * HubClient against a recording `globalThis.fetch` stub (tempiq-read.test.ts idiom): getState's defaults and its throw on
 * non-2xx; sendSetpoint never throws and acks only a 2xx with body.ok; sendBreaker's `refused` matrix — the backup gate
 * retries a breaker command only when `refused` is false, so this classification decides whether a guard refusal is
 * hammered or a transient Pi outage is given up on.
 */
import assert from "node:assert/strict";
import { HubClient } from "./hub";

type Call = { url: string; init: RequestInit };
type Reply = Response | (() => Response) | Error;

const realFetch = globalThis.fetch;
async function withFetch(reply: Reply, fn: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), init: init ?? {} });
    if (reply instanceof Error) throw reply;
    return typeof reply === "function" ? reply() : reply.clone();
  }) as typeof fetch;
  try { await fn(calls); } finally { globalThis.fetch = realFetch; }
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/html" } });
const headersOf = (c: Call) => c.init.headers as Record<string, string>;

(async () => {
  const hub = new HubClient("https://hub.test", "hub-tok");

  // 1. getState: an empty body gets every default
  await withFetch(json(200, {}), async (calls) => {
    const s = await hub.getState();
    assert.deepEqual(s, { pi_connected: false, ts: null, pumps: [], span: null });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://hub.test/api/state");
    assert.equal(headersOf(calls[0]).Authorization, "Bearer hub-tok");
  });
  // 2. getState: pumps not an array → []; span not an object → null; ts/pi_connected null → defaults
  await withFetch(json(200, { pi_connected: null, ts: null, pumps: { p1: {} }, span: "nope" }), async () => {
    const s = await hub.getState();
    assert.equal(s.pi_connected, false);
    assert.equal(s.ts, null);
    assert.deepEqual(s.pumps, []);
    assert.equal(s.span, null);
  });
  await withFetch(json(200, { pumps: "x", span: 5 }), async () => {
    const s = await hub.getState();
    assert.deepEqual(s.pumps, []);
    assert.equal(s.span, null);
  });
  // 3. getState: a well-formed frame passes through unchanged
  {
    const pumps = [{ id: "p1", name: "Pump 1", online: true, setpoint_c: 50 }];
    const span = { ts: 1_700_000_000, circuits: [{ name: "Buffer Tank", relay_state: "OPEN" }] };
    await withFetch(json(200, { pi_connected: true, ts: 1_700_000_001, pumps, span }), async () => {
      const s = await hub.getState();
      assert.equal(s.pi_connected, true);
      assert.equal(s.ts, 1_700_000_001);
      assert.deepEqual(s.pumps, pumps);
      assert.deepEqual(s.span, span);
    });
  }
  // 4. getState: non-2xx throws with the status
  await withFetch(json(500, { error: "boom" }), async () => {
    await assert.rejects(hub.getState(), /hub GET \/api\/state: HTTP 500/);
  });
  await withFetch(json(401, {}), async () => {
    await assert.rejects(hub.getState(), /HTTP 401/);
  });

  // 5. sendSetpoint: 2xx + body.ok → ok; the request is a JSON POST with the lease
  await withFetch(json(200, { ok: true }), async (calls) => {
    const r = await hub.sendSetpoint("p1", 48.5, 90, "phaseb");
    assert.deepEqual(r, { ok: true, detail: "acked 48.5°C" });
    assert.equal(calls[0].url, "https://hub.test/api/command");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(headersOf(calls[0]).Authorization, "Bearer hub-tok");
    assert.equal(headersOf(calls[0])["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { pump_id: "p1", value_c: 48.5, lease_minutes: 90, source: "phaseb" });
  });
  // 6. sendSetpoint: 2xx without body.ok is a nack (the Pi's guardrails said no), detail passed through
  await withFetch(json(200, { ok: false, detail: "rate limited" }), async () => {
    assert.deepEqual(await hub.sendSetpoint("p1", 50, 90, "phaseb"), { ok: false, detail: "rate limited" });
  });
  await withFetch(json(200, {}), async () => {
    assert.deepEqual(await hub.sendSetpoint("p1", 50, 90, "phaseb"), { ok: false, detail: "HTTP 200" });
  });
  // 7. sendSetpoint: non-2xx even with body.ok true is not ok
  await withFetch(json(503, { ok: true }), async () => {
    const r = await hub.sendSetpoint("p1", 50, 90, "phaseb");
    assert.equal(r.ok, false);
    assert.equal(r.detail, "HTTP 503");
  });
  // 8. sendSetpoint never throws: non-JSON body, network error
  await withFetch(text(200, "<html>bad gateway</html>"), async () => {
    assert.deepEqual(await hub.sendSetpoint("p1", 50, 90, "phaseb"), { ok: false, detail: "HTTP 200" });
  });
  await withFetch(text(502, "<html>bad gateway</html>"), async () => {
    assert.deepEqual(await hub.sendSetpoint("p1", 50, 90, "phaseb"), { ok: false, detail: "HTTP 502" });
  });
  await withFetch(new TypeError("fetch failed"), async () => {
    assert.deepEqual(await hub.sendSetpoint("p1", 50, 90, "phaseb"), { ok: false, detail: "fetch failed" });
  });

  // 9. sendBreaker: verified ok; X-Arm-Token and the JSON body are sent
  await withFetch(json(200, { ok: true, detail: "closed, verified" }), async (calls) => {
    const r = await hub.sendBreaker("Buffer Tank", "close", "arm-tok", "backupgate");
    assert.deepEqual(r, { ok: true, refused: false, detail: "closed, verified" });
    assert.equal(calls[0].url, "https://hub.test/api/breaker");
    assert.equal(calls[0].init.method, "POST");
    const h = headersOf(calls[0]);
    assert.equal(h["X-Arm-Token"], "arm-tok");
    assert.equal(h.Authorization, "Bearer hub-tok");
    assert.equal(h["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { circuit: "Buffer Tank", action: "close", source: "backupgate" });
  });
  // 10. a bridge guard refusal (result.refused) is refused, whatever the status
  for (const status of [200, 409, 502, 503]) {
    await withFetch(json(status, { ok: false, detail: "guard: cooldown", result: { refused: true } }), async () => {
      const r = await hub.sendBreaker("Buffer Tank", "close", "arm-tok", "backupgate");
      assert.deepEqual(r, { ok: false, refused: true, detail: "guard: cooldown" }, `result.refused at HTTP ${status}`);
    });
  }
  // 11. the hub rejecting the request itself is refused
  for (const status of [400, 401, 403, 404, 422, 501]) {
    await withFetch(json(status, {}), async () => {
      const r = await hub.sendBreaker("Buffer Tank", "close", "arm-tok", "backupgate");
      assert.deepEqual(r, { ok: false, refused: true, detail: `HTTP ${status}` }, `HTTP ${status} is refused`);
    });
  }
  // 12. 502 without refused (switched, not verified), 503 (no Pi), 504 (no answer) retry — not refused
  for (const status of [502, 503, 504]) {
    await withFetch(json(status, { ok: false, result: { refused: false } }), async () => {
      const r = await hub.sendBreaker("Buffer Tank", "close", "arm-tok", "backupgate");
      assert.deepEqual(r, { ok: false, refused: false, detail: `HTTP ${status}` }, `HTTP ${status} is not refused`);
    });
    await withFetch(text(status, "<html>gateway</html>"), async () => {
      const r = await hub.sendBreaker("Buffer Tank", "close", "arm-tok", "backupgate");
      assert.equal(r.refused, false, `non-JSON HTTP ${status} is not refused`);
      assert.equal(r.ok, false);
    });
  }
  // 13. a 2xx without ok:true is neither ok nor refused (unverified — retry)
  await withFetch(json(200, { ok: false, detail: "read-back mismatch" }), async () => {
    assert.deepEqual(await hub.sendBreaker("Buffer Tank", "open", "arm-tok", "backupgate"), { ok: false, refused: false, detail: "read-back mismatch" });
  });
  // 14. ok wins over a stray refused flag
  await withFetch(json(200, { ok: true, result: { refused: true } }), async () => {
    const r = await hub.sendBreaker("Buffer Tank", "open", "arm-tok", "backupgate");
    assert.equal(r.ok, true);
    assert.equal(r.refused, false);
  });
  // 15. a thrown fetch (network error / timeout) never throws: ok false, refused false
  await withFetch(new Error("The operation was aborted due to timeout"), async () => {
    assert.deepEqual(await hub.sendBreaker("Buffer Tank", "close", "arm-tok", "backupgate"), {
      ok: false, refused: false, detail: "The operation was aborted due to timeout",
    });
  });

  console.log("ok hub-client (getState defaults, sendSetpoint, sendBreaker refused matrix)");
})().catch((e) => { console.error(e); process.exit(1); });
