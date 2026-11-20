// @purpose node:assert suite for lib/planner-proxy.ts: the seven planner write proxies share this one
// forwarder, so the env gate, URL building, bearer + Content-Type headers, status passthrough (202 arming),
// non-JSON tolerance, 502 on a thrown fetch and the 504 timeout are checked once here. fetch and env are
// injected through deps — nothing global is touched and no network is used.
// Run: npx tsx tests/planner-proxy.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forwardToPlanner, DEFAULT_PLANNER_TIMEOUT_MS } from "../lib/planner-proxy";

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log(`  ✓ ${name}`); };

type Call = { url: string; init: RequestInit | undefined };

/** A fetch stub answering `body` (a string verbatim, anything else JSON-encoded) at `status`; records calls. */
function stubResponse(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
function stubThrow(message: string) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    throw new Error(message);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
/** A fetch that never settles and ignores its abort signal — the worst case a stalled planner can present. */
function stubHang() {
  const calls: Call[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const configured = { PLANNER_URL: "https://x/", PLANNER_API_TOKEN: "secret-token" };

async function main() {
  await t("PLANNER_URL unset → 503 'planner not configured', fetch never called", async () => {
    const { fetchImpl, calls } = stubResponse({ ok: true });
    const r = await forwardToPlanner("/api/autonomy", { method: "POST", body: "{}" }, {
      fetchImpl, env: { PLANNER_API_TOKEN: "tok" },
    });
    assert.deepEqual(r, { status: 503, body: { error: "planner not configured" } });
    assert.equal(calls.length, 0);
  });

  await t("PLANNER_API_TOKEN unset (or empty) → 503, fetch never called", async () => {
    const { fetchImpl, calls } = stubResponse({ ok: true });
    const a = await forwardToPlanner("/api/autonomy", { method: "POST", body: "{}" }, { fetchImpl, env: { PLANNER_URL: "https://x" } });
    const b = await forwardToPlanner("/api/autonomy", { method: "POST", body: "{}" }, { fetchImpl, env: { PLANNER_URL: "https://x", PLANNER_API_TOKEN: "" } });
    assert.deepEqual(a, { status: 503, body: { error: "planner not configured" } });
    assert.deepEqual(b, { status: 503, body: { error: "planner not configured" } });
    assert.equal(calls.length, 0);
  });

  await t("'https://x/' + '/api/autonomy' → 'https://x/api/autonomy' with the Bearer header, JSON Content-Type, the body, no-store, a signal", async () => {
    const { fetchImpl, calls } = stubResponse({ mode: "armed" });
    const r = await forwardToPlanner("/api/autonomy", { method: "POST", body: '{"mode":"armed"}' }, { fetchImpl, env: configured });
    assert.deepEqual(r, { status: 200, body: { mode: "armed" } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://x/api/autonomy");
    assert.equal(calls[0].init?.method, "POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret-token");
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(calls[0].init?.body, '{"mode":"armed"}');
    assert.equal(calls[0].init?.cache, "no-store");
    assert.ok(calls[0].init?.signal instanceof AbortSignal, "an abort signal is attached");
  });

  await t("several trailing slashes are all stripped; a path without a leading slash still joins cleanly", async () => {
    const { fetchImpl, calls } = stubResponse({});
    await forwardToPlanner("/api/sanitize", { method: "POST", body: "{}" }, { fetchImpl, env: { PLANNER_URL: "https://planner.example///", PLANNER_API_TOKEN: "t" } });
    await forwardToPlanner("api/sanitize", { method: "POST", body: "{}" }, { fetchImpl, env: { PLANNER_URL: "https://planner.example", PLANNER_API_TOKEN: "t" } });
    assert.deepEqual(calls.map((c) => c.url), ["https://planner.example/api/sanitize", "https://planner.example/api/sanitize"]);
  });

  await t("GET without a body → no body and no Content-Type (the target status read / bodiless restore)", async () => {
    const { fetchImpl, calls } = stubResponse({ active_boost: null });
    const r = await forwardToPlanner("/api/hbx/target", { method: "GET" }, { fetchImpl, env: configured });
    assert.deepEqual(r, { status: 200, body: { active_boost: null } });
    assert.equal(calls[0].init?.method, "GET");
    assert.equal(calls[0].init?.body, undefined);
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer secret-token");
    assert.equal("Content-Type" in headers, false);
  });

  await t("202 passes through with its body (boost arming must survive)", async () => {
    const { fetchImpl } = stubResponse({ armed: true, restore_at: "2026-11-11T20:00:00Z" }, 202);
    const r = await forwardToPlanner("/api/hbx/boost", { method: "POST", body: '{"target_f":140,"minutes":60}' }, { fetchImpl, env: configured });
    assert.deepEqual(r, { status: 202, body: { armed: true, restore_at: "2026-11-11T20:00:00Z" } });
  });

  await t("planner refusals pass through too (409, 422, 501) — the forwarder never rewrites a status it received", async () => {
    for (const status of [400, 409, 422, 501]) {
      const { fetchImpl } = stubResponse({ error: `refused ${status}` }, status);
      const r = await forwardToPlanner("/api/autonomy", { method: "POST", body: "{}" }, { fetchImpl, env: configured });
      assert.deepEqual(r, { status, body: { error: `refused ${status}` } });
    }
  });

  await t("non-JSON response → {} with the upstream status kept", async () => {
    const { fetchImpl } = stubResponse("<html>bad gateway</html>", 502);
    const r = await forwardToPlanner("/api/identification", { method: "POST", body: "{}" }, { fetchImpl, env: configured });
    assert.deepEqual(r, { status: 502, body: {} });
    const { fetchImpl: f2 } = stubResponse("", 200);
    const r2 = await forwardToPlanner("/api/identification", { method: "POST", body: "{}" }, { fetchImpl: f2, env: configured });
    assert.deepEqual(r2, { status: 200, body: {} });
  });

  await t("a thrown fetch (DNS / refused / reset) → 502 'planner unreachable' with the detail", async () => {
    const { fetchImpl, calls } = stubThrow("ECONNREFUSED 10.0.0.1:8080");
    const r = await forwardToPlanner("/api/hbx/restore", { method: "POST" }, { fetchImpl, env: configured });
    assert.equal(r.status, 502);
    const body = r.body as { error: string; detail: string };
    assert.equal(body.error, "planner unreachable");
    assert.match(body.detail, /ECONNREFUSED/);
    assert.equal(calls.length, 1);
  });

  await t("a never-resolving fetch with a tiny timeoutMs → 504 'planner timed out', and the signal handed to fetch is aborted", async () => {
    const { fetchImpl, calls } = stubHang();
    const started = Date.now();
    const r = await forwardToPlanner("/api/storm/arm", { method: "POST", body: '{"hours":24}' }, { fetchImpl, env: configured, timeoutMs: 25 });
    assert.deepEqual(r, { status: 504, body: { error: "planner timed out", detail: "no answer in time; the write may still have landed, so re-check status before retrying" } });
    assert.ok(Date.now() - started < 2000, "returned promptly, not after the default budget");
    assert.equal(calls[0].init?.signal?.aborted, true, "the in-flight request was aborted");
  });

  await t("a stall AFTER the headers (body never arrives) is a timeout too", async () => {
    const fetchImpl = (async () => {
      const stream = new ReadableStream<Uint8Array>({ start() { /* never enqueue, never close */ } });
      return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const r = await forwardToPlanner("/api/hbx/target", { method: "POST", body: "{}" }, { fetchImpl, env: configured, timeoutMs: 25 });
    assert.deepEqual(r, { status: 504, body: { error: "planner timed out", detail: "no answer in time; the write may still have landed, so re-check status before retrying" } });
  });

  await t("default timeout sits below every relaying route's maxDuration, and is long enough for a slow target write", async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "api", "planner");
    const routes = readdirSync(dir).map((d) => join(dir, d, "route.ts")).filter((f) => {
      try { return readFileSync(f, "utf8").includes("forwardToPlanner"); } catch { return false; }
    });
    assert.equal(routes.length, 7, `the seven relaying routes (found ${routes.length})`);
    for (const f of routes) {
      const m = readFileSync(f, "utf8").match(/export const maxDuration = (\d+)/);
      assert.ok(m, `${f} exports maxDuration (otherwise the platform default, possibly 10 s, can cut the relay off first)`);
      assert.ok(DEFAULT_PLANNER_TIMEOUT_MS < Number(m![1]) * 1000, `${DEFAULT_PLANNER_TIMEOUT_MS} ms must be < ${f}'s maxDuration`);
    }
    assert.ok(DEFAULT_PLANNER_TIMEOUT_MS >= 15_000, "not so short that a slow-but-successful SensorLinx write reads as timed out");
  });

  await t("deps default to process.env: with the real env unset the answer is 503 and fetch is untouched", async () => {
    const savedUrl = process.env.PLANNER_URL, savedTok = process.env.PLANNER_API_TOKEN;
    delete process.env.PLANNER_URL; delete process.env.PLANNER_API_TOKEN;
    try {
      const r = await forwardToPlanner("/api/autonomy", { method: "POST", body: "{}" });
      assert.deepEqual(r, { status: 503, body: { error: "planner not configured" } });
    } finally {
      if (savedUrl !== undefined) process.env.PLANNER_URL = savedUrl;
      if (savedTok !== undefined) process.env.PLANNER_API_TOKEN = savedTok;
    }
  });
}

main()
  .then(() => { console.log(`planner-proxy: ${n} passed`); })
  .catch((e) => { console.error(e); process.exit(1); });
