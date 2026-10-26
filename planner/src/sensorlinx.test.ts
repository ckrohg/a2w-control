/**
 * SensorLinxClient against a recording `globalThis.fetch` stub: one login, token reused; a single 401/403 re-logs in
 * exactly once and retries; a second consecutive 401 throws instead of looping; error messages carry method + path;
 * PATCH sends a JSON body with Content-Type, GET sends neither; getDevice rejects a non-list response clearly.
 * SLX_BASE_URL is read at module load, so it is set BEFORE the dynamic import.
 */
import assert from "node:assert/strict";

process.env.SLX_BASE_URL = "https://slx.test";

type Call = { method: string; path: string; headers: Record<string, string>; body: string | undefined };
type Handler = (c: Call, n: number) => Response;

const realFetch = globalThis.fetch;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** `login` answers /account/login (n = the login's 1-based count); `api` answers everything else (n = 1-based count). */
async function withFetch(login: Handler, api: Handler, fn: (calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  let logins = 0;
  let apis = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    assert.equal(url.origin, "https://slx.test", "SLX_BASE_URL honoured");
    const c: Call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: init?.body === undefined ? undefined : String(init.body),
    };
    calls.push(c);
    return c.path === "/account/login" ? login(c, ++logins) : api(c, ++apis);
  }) as typeof fetch;
  try { await fn(calls); } finally { globalThis.fetch = realFetch; }
}
const tokenN: Handler = (_c, n) => json(200, { token: `tok${n}` });
const logins = (calls: Call[]) => calls.filter((c) => c.path === "/account/login");
const apiCalls = (calls: Call[]) => calls.filter((c) => c.path !== "/account/login");
const devices = [{ syncCode: "S1", temp1: { target: 120 } }, { syncCode: "S2" }];

(async () => {
  const { SensorLinxClient } = await import("./sensorlinx");

  // 1. login happens once (JSON credentials), the token is reused across requests
  await withFetch(tokenN, () => json(200, devices), async (calls) => {
    const slx = new SensorLinxClient("me@example.test", "pw");
    assert.deepEqual(await slx.getDevice("b1", "S1"), devices[0]);
    assert.deepEqual(await slx.getDevice("b1", "S2"), devices[1]);
    const l = logins(calls);
    assert.equal(l.length, 1, "one login for two requests");
    assert.equal(l[0].method, "POST");
    assert.equal(l[0].headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(l[0].body ?? ""), { email: "me@example.test", password: "pw" });
    const a = apiCalls(calls);
    assert.equal(a.length, 2);
    for (const c of a) {
      assert.equal(c.path, "/buildings/b1/devices");
      assert.equal(c.headers.Authorization, "Bearer tok1");
    }
  });

  // 2. a single 401 or 403 → exactly one re-login, then a retry with the new token
  for (const status of [401, 403]) {
    await withFetch(tokenN, (_c, n) => (n === 1 ? json(status, {}) : json(200, devices)), async (calls) => {
      const slx = new SensorLinxClient("me@example.test", "pw");
      assert.deepEqual(await slx.getDevice("b1", "S1"), devices[0]);
      assert.equal(logins(calls).length, 2, `HTTP ${status}: initial login + one re-login`);
      const a = apiCalls(calls);
      assert.equal(a.length, 2, `HTTP ${status}: one retry`);
      assert.equal(a[0].headers.Authorization, "Bearer tok1");
      assert.equal(a[1].headers.Authorization, "Bearer tok2");
      assert.deepEqual(calls.map((c) => c.path), ["/account/login", "/buildings/b1/devices", "/account/login", "/buildings/b1/devices"]);
    });
  }

  // 3. a second consecutive 401 throws instead of looping (and does not log in a third time)
  await withFetch(tokenN, () => json(401, {}), async (calls) => {
    const slx = new SensorLinxClient("me@example.test", "pw");
    await assert.rejects(slx.getDevice("b1", "S1"), (e: Error) => {
      assert.equal(e.message, "sensorlinx GET /buildings/b1/devices: HTTP 401");
      return true;
    });
    assert.equal(logins(calls).length, 2);
    assert.equal(apiCalls(calls).length, 2);
  });
  // ...and the next request still works off the re-login token (no stale loop state)
  await withFetch(tokenN, (_c, n) => (n <= 2 ? json(403, {}) : json(200, devices)), async (calls) => {
    const slx = new SensorLinxClient("me@example.test", "pw");
    await assert.rejects(slx.getDevice("b1", "S1"), /HTTP 403/);
    assert.deepEqual(await slx.getDevice("b1", "S1"), devices[0]);
    assert.equal(logins(calls).length, 2, "the second request reuses tok2");
    assert.equal(apiCalls(calls)[2].headers.Authorization, "Bearer tok2");
  });

  // 4. non-2xx error messages include method and path
  await withFetch(tokenN, () => json(500, { error: "boom" }), async () => {
    const slx = new SensorLinxClient("me@example.test", "pw");
    await assert.rejects(slx.getDevice("b1", "S1"), { message: "sensorlinx GET /buildings/b1/devices: HTTP 500" });
    await assert.rejects(slx.patchDevice("b1", "S1", { dhwT: 120 }), { message: "sensorlinx PATCH /buildings/b1/devices/S1: HTTP 500" });
  });
  // a 404 is not a re-login trigger
  await withFetch(tokenN, () => json(404, {}), async (calls) => {
    const slx = new SensorLinxClient("me@example.test", "pw");
    await assert.rejects(slx.patchDevice("b1", "S9", { dhwT: 120 }), { message: "sensorlinx PATCH /buildings/b1/devices/S9: HTTP 404" });
    assert.equal(logins(calls).length, 1);
    assert.equal(apiCalls(calls).length, 1);
  });

  // 5. PATCH: JSON body + Content-Type, response echoed; GET: no body, no Content-Type
  {
    const echoed = { syncCode: "S1", dhwT: 125, hbxT: 140 };
    await withFetch(tokenN, (c) => (c.method === "PATCH" ? json(200, echoed) : json(200, devices)), async (calls) => {
      const slx = new SensorLinxClient("me@example.test", "pw");
      assert.deepEqual(await slx.patchDevice("b1", "S1", { dhwT: 125, hbxT: 140 }), echoed);
      await slx.getDevice("b1", "S1");
      const [patch, get] = apiCalls(calls);
      assert.equal(patch.method, "PATCH");
      assert.equal(patch.path, "/buildings/b1/devices/S1");
      assert.equal(patch.headers["Content-Type"], "application/json");
      assert.equal(patch.headers.Authorization, "Bearer tok1");
      assert.deepEqual(JSON.parse(patch.body ?? ""), { dhwT: 125, hbxT: 140 });
      assert.equal(get.method, "GET");
      assert.equal(get.body, undefined);
      assert.ok(!("Content-Type" in get.headers), "GET carries no Content-Type");
      assert.equal(get.headers.Authorization, "Bearer tok1");
    });
  }

  // 6. login failures throw (bad status, no token) and no API request is made
  await withFetch(() => json(401, {}), () => json(200, devices), async (calls) => {
    const slx = new SensorLinxClient("me@example.test", "bad");
    await assert.rejects(slx.getDevice("b1", "S1"), { message: "sensorlinx login failed: HTTP 401" });
    assert.equal(apiCalls(calls).length, 0);
  });
  await withFetch(() => json(200, {}), () => json(200, devices), async () => {
    const slx = new SensorLinxClient("me@example.test", "pw");
    await assert.rejects(slx.getDevice("b1", "S1"), { message: "sensorlinx login: no token in response" });
  });

  // 7. getDevice: a non-list response is a clear Error, not a TypeError from `.find`
  for (const body of [{ devices }, null, "maintenance", 42]) {
    await withFetch(tokenN, () => json(200, body), async () => {
      const slx = new SensorLinxClient("me@example.test", "pw");
      await assert.rejects(slx.getDevice("b7", "S1"), (e: Error) => {
        assert.ok(!(e instanceof TypeError), `not a TypeError for ${JSON.stringify(body)}`);
        assert.equal(e.message, "sensorlinx: /buildings/b7/devices did not return a list");
        return true;
      });
    });
  }
  // ...and a list without the device names what it did get
  await withFetch(tokenN, () => json(200, devices), async () => {
    const slx = new SensorLinxClient("me@example.test", "pw");
    await assert.rejects(slx.getDevice("b1", "S9"), { message: "device S9 not found in building b1 (got: S1, S2)" });
  });

  console.log("ok sensorlinx (login reuse, single re-login, error messages, PATCH/GET headers, getDevice list guard)");
})().catch((e) => { console.error(e); process.exit(1); });
