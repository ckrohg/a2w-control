/**
 * TempiqPusher: per-pump POSTs are independent (one pump's failure never blanks the other's telemetry), the body
 * shape TempIQ's readings ingest expects, and the skip paths. Fakes `globalThis.fetch` (tempiq-read.test.ts idiom)
 * and a HubClient exposing only getState().
 */
import assert from "node:assert/strict";
import { TempiqPusher } from "./tempiq";
import type { HubClient, HubPump, HubState } from "./hub";

type Call = { url: string; auth: string | null; body: { equipment: string; metrics: Array<Record<string, unknown>> } };
type Reply = { status: number; body?: unknown } | "throw";

function fakeHub(state: HubState): HubClient {
  return { getState: async () => state } as unknown as HubClient;
}
function pump(id: string, over: Partial<HubPump> = {}): HubPump {
  return { id, name: id, online: true, setpoint_c: 50, outlet_c: 48.5, inlet_c: 44, ...over };
}

const realFetch = globalThis.fetch;
/** `replies` keyed by equipment ("a2w-pump1"); unlisted equipment gets 200 {inserted:3, deduped:0}. */
async function withFetch(replies: Record<string, Reply>, fn: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body)) as Call["body"];
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization"), body });
    const r = replies[body.equipment] ?? { status: 200, body: { inserted: 3, deduped: 0 } };
    if (r === "throw") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try { await fn(calls); } finally { globalThis.fetch = realFetch; }
}

const nowSec = () => Math.floor(Date.now() / 1000);

(async () => {
  // 1. both pumps pushed; body shape; ISO ts derived from state.ts in SECONDS
  {
    const tsSec = nowSec() - 60;
    const p = new TempiqPusher(fakeHub({ pi_connected: true, ts: tsSec, pumps: [pump("pump1"), pump("pump2", { setpoint_c: 45 })] }), "https://tempiq.test", "tok");
    await withFetch({}, async (calls) => {
      await p.tick();
      assert.equal(calls.length, 2);
      assert.equal(calls[0].url, "https://tempiq.test/api/insights/readings");
      assert.equal(calls[0].auth, "Bearer tok");
      assert.equal(calls[0].body.equipment, "a2w-pump1");
      assert.equal(calls[1].body.equipment, "a2w-pump2");
      const iso = new Date(tsSec * 1000).toISOString();
      assert.deepEqual(calls[0].body.metrics, [
        { metric: "setpoint_c", value: 50, unit: "C", ts: iso },
        { metric: "outlet_c", value: 48.5, unit: "C", ts: iso },
        { metric: "inlet_c", value: 44, unit: "C", ts: iso },
      ]);
      assert.equal(calls[1].body.metrics[0].value, 45);
    });
    const st = p.status();
    assert.equal(st.consecutiveFailures, 0);
    assert.ok(st.lastPushAt != null);
    assert.equal(st.lastResult, "pump1: +3/0dup, pump2: +3/0dup");
  }
  // 2. state.ts given in MILLISECONDS is handled (not treated as seconds → year 50000 / never stale)
  {
    const tsMs = Date.now() - 120_000;
    const p = new TempiqPusher(fakeHub({ pi_connected: true, ts: tsMs, pumps: [pump("pump1")] }), "https://tempiq.test", "tok");
    await withFetch({}, async (calls) => {
      await p.tick();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.metrics[0].ts, new Date(tsMs).toISOString());
    });
    assert.equal(p.status().consecutiveFailures, 0);
  }
  // 3. stale state (older than 15 min) skips without a fetch
  {
    const p = new TempiqPusher(fakeHub({ pi_connected: true, ts: nowSec() - 20 * 60, pumps: [pump("pump1")] }), "https://tempiq.test", "tok");
    await withFetch({}, async (calls) => {
      await p.tick();
      assert.equal(calls.length, 0);
    });
    assert.match(p.status().lastResult ?? "", /^skipped: state stale \(20 min\)$/);
    assert.equal(p.status().lastPushAt, null);
    assert.equal(p.status().consecutiveFailures, 0);
  }
  // 3b. pi offline skips without a fetch
  {
    const p = new TempiqPusher(fakeHub({ pi_connected: false, ts: nowSec(), pumps: [pump("pump1")] }), "https://tempiq.test", "tok");
    await withFetch({}, async (calls) => {
      await p.tick();
      assert.equal(calls.length, 0);
    });
    assert.equal(p.status().lastResult, "skipped: pi offline / no state");
  }
  // 4. an offline pump is skipped; the online one is still pushed
  {
    const p = new TempiqPusher(fakeHub({ pi_connected: true, ts: nowSec(), pumps: [pump("pump1", { online: false }), pump("pump2")] }), "https://tempiq.test", "tok");
    await withFetch({}, async (calls) => {
      await p.tick();
      assert.deepEqual(calls.map((c) => c.body.equipment), ["a2w-pump2"]);
    });
    assert.equal(p.status().lastResult, "pump2: +3/0dup");
  }
  // 5. a pump with no finite fields is skipped; with nothing left the tick is the "no online pumps" skip
  {
    const blank = pump("pump1", { setpoint_c: null, outlet_c: NaN, inlet_c: undefined });
    const p = new TempiqPusher(fakeHub({ pi_connected: true, ts: nowSec(), pumps: [blank] }), "https://tempiq.test", "tok");
    await withFetch({}, async (calls) => {
      await p.tick();
      assert.equal(calls.length, 0);
    });
    assert.equal(p.status().lastResult, "skipped: no online pumps with data");
    assert.equal(p.status().consecutiveFailures, 0);
  }
  // 5b. partial fields: only the finite metrics are sent
  {
    const p = new TempiqPusher(fakeHub({ pi_connected: true, ts: nowSec(), pumps: [pump("pump1", { setpoint_c: null, inlet_c: Infinity })] }), "https://tempiq.test", "tok");
    await withFetch({}, async (calls) => {
      await p.tick();
      assert.deepEqual(calls[0].body.metrics.map((m) => m.metric), ["outlet_c"]);
    });
  }
  // 6. pump1 503 + pump2 200: pump2 still pushed, lastPushAt advances, the streak grows by exactly one per tick
  {
    const p = new TempiqPusher(fakeHub({ pi_connected: true, ts: nowSec(), pumps: [pump("pump1"), pump("pump2")] }), "https://tempiq.test", "tok");
    await withFetch({ "a2w-pump1": { status: 503, body: { error: "unavailable" } } }, async (calls) => {
      await p.tick();
      assert.deepEqual(calls.map((c) => c.body.equipment), ["a2w-pump1", "a2w-pump2"]);
    });
    const st = p.status();
    assert.ok(st.lastPushAt != null, "pump2 pushed → lastPushAt advanced");
    assert.equal(st.consecutiveFailures, 1);
    assert.equal(st.lastResult, "pump1: error: HTTP 503, pump2: +3/0dup");
    await withFetch({ "a2w-pump1": { status: 503 } }, async () => { await p.tick(); });
    assert.equal(p.status().consecutiveFailures, 2);
    // a fully successful tick resets the streak
    await withFetch({}, async () => { await p.tick(); });
    assert.equal(p.status().consecutiveFailures, 0);
  }
  // 7. fetch throws for every pump: tick() resolves, no lastPushAt, one failure counted
  {
    const p = new TempiqPusher(fakeHub({ pi_connected: true, ts: nowSec(), pumps: [pump("pump1"), pump("pump2")] }), "https://tempiq.test", "tok");
    await withFetch({ "a2w-pump1": "throw", "a2w-pump2": "throw" }, async (calls) => {
      await p.tick();
      assert.equal(calls.length, 2, "pump2 still attempted after pump1 threw");
    });
    const st = p.status();
    assert.equal(st.lastPushAt, null);
    assert.equal(st.consecutiveFailures, 1);
    assert.equal(st.lastResult, "pump1: error: fetch failed, pump2: error: fetch failed");
  }
  // 8. getState itself throwing does not escape tick()
  {
    const hub = { getState: async () => { throw new Error("hub GET /api/state: HTTP 502"); } } as unknown as HubClient;
    const p = new TempiqPusher(hub, "https://tempiq.test", "tok");
    await p.tick();
    assert.equal(p.status().consecutiveFailures, 1);
    assert.equal(p.status().lastResult, "error: hub GET /api/state: HTTP 502");
  }
  console.log("ok tempiq (per-pump push isolation)");
})().catch((e) => { console.error(e); process.exit(1); });
