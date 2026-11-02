/**
 * @purpose End-to-end coverage of #190's HUB_READONLY_TOKEN on the real hub (spawned as a child,
 * like breaker.e2e.test.ts): the read-only bearer may GET /api/state, never its `span` block (the
 * client still gets it), and nothing else — every
 * POST/PUT/DELETE on /api (real routes, arm routes even with a valid X-Arm-Token, and routes that
 * do not exist) answers 403, and the Pi WebSocket refuses it with 403. The client token keeps
 * full access, no token is 401, and a read-only token equal to another secret, even with a trailing
 * newline, stops the hub from starting; the token is trimmed before matching too. Also: a client-only GET (test-only route) and HEAD /api/state, write-enable still
 * reaching its handler for the client, a wrong /pi token closing 4401, and active_faults relayed
 * in both the old count and the new list shape. Run: npx tsx src/readonly.e2e.test.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";

const HUB_DIR = path.resolve(__dirname, "..");
const PI = "e2e-pi-token";
const CLIENT = "e2e-client-token";
const ARM = "e2e-arm-token";
const RO = "e2e-readonly-token";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(25);
  }
  return pred();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

class Hub {
  readonly log: string[] = [];
  proc?: ChildProcess;
  constructor(readonly port: number) {}

  /** Spawn only; `start` also waits for /health. */
  static async spawn(env: Record<string, string>): Promise<Hub> {
    const hub = new Hub(await freePort());
    const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: HUB_DIR,
      env: { ...process.env, PORT: String(hub.port), HUB_PI_TOKEN: PI, HUB_CLIENT_TOKEN: CLIENT,
             HUB_ARM_TOKEN: ARM, NTFY_TOPIC: "", PLANNER_HEALTH_URL: "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sink = (d: Buffer) => { for (const l of d.toString().split("\n")) if (l.trim()) hub.log.push(l); };
    p.stdout!.on("data", sink);
    p.stderr!.on("data", sink);
    hub.proc = p;
    return hub;
  }

  static async start(env: Record<string, string>): Promise<Hub> {
    const hub = await Hub.spawn(env);
    const up = await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${hub.port}/health`)).ok; } catch { return false; }
    }, 20_000);
    if (!up) throw new Error(`hub did not come up\n${hub.log.join("\n")}`);
    return hub;
  }

  req(method: string, route: string, headers: Record<string, string> = {}, body?: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${route}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    p.kill("SIGTERM");
    if (!(await waitFor(() => p.exitCode !== null || p.signalCode !== null, 8_000))) p.kill("SIGKILL");
  }
}

/** HTTP status the hub answers a /pi upgrade with, or "open" if the upgrade was accepted. */
function piUpgrade(hub: Hub, token: string): Promise<number | "open"> {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${hub.port}/pi`, { headers: { Authorization: `Bearer ${token}` } });
    w.on("unexpected-response", (_req, res) => { resolve(res.statusCode ?? 0); w.terminate(); });
    w.on("open", () => { resolve("open"); w.close(); });
    w.on("error", reject);
  });
}

const SPAN = { ts: 1_800_000_000, serial: "nj-2316-secret", broker: "192.168.1.50:8883", last_error: "tls handshake failed", circuits: [] };
const ROH = { Authorization: `Bearer ${RO}` };
const CLH = { Authorization: `Bearer ${CLIENT}` };
/** Close code the hub sends a /pi socket it upgraded, e.g. 4401 for a wrong token. */
function piClose(hub: Hub, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${hub.port}/pi`, { headers: { Authorization: `Bearer ${token}` } });
    w.on("close", (code) => resolve(code));
    w.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}, not an upgrade`)));
    w.on("error", reject);
  });
}

/** Every mutating call, each with a body that would otherwise pass validation. */
const MUTATING: [string, string, unknown][] = [
  ["POST", "/api/command", { pump_id: "pump1", value_c: 45 }],
  ["POST", "/api/write-enable", { pump_id: "pump1", enabled: true }],
  ["POST", "/api/breaker", { circuit: "Air-Water 2", action: "power_cycle", off_s: 60 }],
  ["POST", "/api/state", {}],
  ["PUT", "/api/state", {}],
  ["DELETE", "/api/state", undefined],
  ["PATCH", "/api/command", {}],
  ["POST", "/api/not-a-route-yet", {}],
];
const hubs: Hub[] = [];
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok   ${name}`);
}

(async () => {
  try {
    for (const [clash, value] of [["HUB_CLIENT_TOKEN", CLIENT], ["HUB_ARM_TOKEN", ARM], ["HUB_PI_TOKEN", PI], ["HUB_CLIENT_TOKEN", `${CLIENT}\n`]]) {
      await test(`read-only token ${JSON.stringify(value)} equal to ${clash} → the hub refuses to start`, async () => {
        const bad = await Hub.spawn({ HUB_READONLY_TOKEN: value });
        hubs.push(bad);
        assert.ok(await waitFor(() => bad.proc!.exitCode !== null, 20_000), "hub exited");
        assert.equal(bad.proc!.exitCode, 1);
        assert.ok(bad.log.some((l) => l.includes(`FATAL: HUB_READONLY_TOKEN equals ${clash}`)), bad.log.join("\n"));
      });
    }

    const plain = await Hub.start({});
    hubs.push(plain);
    await test("HUB_READONLY_TOKEN unset: client works, no/unknown bearer 401, unknown route 404 as before", async () => {
      assert.equal((await plain.req("GET", "/api/state", CLH)).status, 200);
      assert.equal((await plain.req("GET", "/api/state")).status, 401);
      assert.equal((await plain.req("GET", "/api/state", ROH)).status, 401);
      assert.equal((await plain.req("POST", "/api/command", ROH, MUTATING[0][2])).status, 401);
      assert.equal((await plain.req("POST", "/api/not-a-route-yet", CLH, {})).status, 404);
    });
    await plain.stop();

    const hub = await Hub.start({ HUB_READONLY_TOKEN: `${RO}\n`, HUB_E2E_CLIENT_ONLY_GET: "1" }); // trimmed at startup
    hubs.push(hub);

    await test("read-only token on a client-only GET → 403 (requireClientAuth), client 200, none 401", async () => {
      const r = await hub.req("GET", "/api/e2e-client-only", ROH);
      assert.equal(r.status, 403);
      assert.equal(((await r.json()) as { detail?: string }).detail, "read-only token");
      assert.equal((await hub.req("HEAD", "/api/e2e-client-only", ROH)).status, 403);
      assert.equal((await hub.req("GET", "/api/e2e-client-only", CLH)).status, 200);
      assert.equal((await hub.req("GET", "/api/e2e-client-only")).status, 401);
    });

    await test("HEAD /api/state: read-only 200 with no body, client 200, none/wrong 401", async () => {
      const r = await hub.req("HEAD", "/api/state", ROH);
      assert.equal(r.status, 200);
      assert.equal(await r.text(), "");
      assert.equal((await hub.req("HEAD", "/api/state", CLH)).status, 200);
      assert.equal((await hub.req("HEAD", "/api/state")).status, 401);
      assert.equal((await hub.req("HEAD", "/api/state", { Authorization: "Bearer nope" })).status, 401);
    });

    await test("client token: POST /api/write-enable still reaches its handler (arm check, then 503 no Pi)", async () => {
      const body = MUTATING[1][2];
      const noArm = await hub.req("POST", "/api/write-enable", CLH, body);
      assert.equal(noArm.status, 401);
      assert.equal(((await noArm.json()) as { detail?: string }).detail, "bad arm token");
      const armed = await hub.req("POST", "/api/write-enable", { ...CLH, "X-Arm-Token": ARM }, body);
      assert.equal(armed.status, 503);
      assert.equal(((await armed.json()) as { detail?: string }).detail, "no Pi connected");
    });

    await test("a wrong token on /pi still gets close code 4401", async () => {
      assert.equal(await piClose(hub, "nope"), 4401);
      assert.equal(await piClose(hub, CLIENT), 4401);
    });

    await test("read-only GET /api/state relays active_faults as the Pi sent it: old COUNT and new LIST", async () => {
      const pi = new WebSocket(`ws://127.0.0.1:${hub.port}/pi`, { headers: { Authorization: `Bearer ${PI}` } });
      await new Promise<void>((res, rej) => { pi.on("open", () => res()); pi.on("error", rej); });
      const list = [{ code: "P17", message: "Stage 1 anti-freeze protection — NORMAL in cold weather, do not cut power", severity: "info" },
                    { code: "E21", message: "Display controller lost communication with the heat pump", severity: "warning" }];
      const pump = (id: string, active_faults: unknown) => ({ id, name: id, online: true, state: "heating", mode_kind: "heating",
        setpoint_c: 45, inlet_c: 40, outlet_c: 45, ambient_c: 0, power_w: 3000, active_faults, error_rate: 0,
        remote_lease_until: null, write_enabled: false });
      pi.send(JSON.stringify({ type: "state", ts: 1_800_000_000, pumps: [pump("pump1", 2), pump("pump2", list)], span: SPAN }));
      let s: { pumps: { id: string; active_faults: unknown; write_enabled?: boolean }[] } = { pumps: [] };
      assert.ok(await waitFor(async () => {
        s = (await (await hub.req("GET", "/api/state", ROH)).json()) as typeof s;
        return s.pumps.length === 2;
      }), "state relayed");
      assert.equal(s.pumps[0].active_faults, 2);
      assert.deepEqual(s.pumps[1].active_faults, list);
      assert.equal(s.pumps[1].write_enabled, false);
      pi.close();
      assert.ok(await waitFor(async () => !((await (await fetch(`http://127.0.0.1:${hub.port}/health`)).json()) as { pi_connected: boolean }).pi_connected));
    });

    await test("read-only token: GET /api/state → 200 with the state shape and no span block", async () => {
      const r = await hub.req("GET", "/api/state", ROH);
      assert.equal(r.status, 200);
      const raw = await r.text();
      assert.deepEqual(Object.keys(JSON.parse(raw) as object).sort(), ["pi_connected", "pumps", "ts"]);
      for (const leak of ["span", "nj-2316-secret", "192.168.1.50", "tls handshake"]) assert.ok(!raw.includes(leak), leak);
    });

    await test("client token: GET /api/state keeps the full frame, span included, same key order", async () => {
      const s = (await (await hub.req("GET", "/api/state", CLH)).json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(s), ["pi_connected", "ts", "pumps", "span"]);
      assert.deepEqual(s.span, SPAN);
    });

    await test("read-only token: every POST/PUT/DELETE/PATCH on /api → 403, even with a valid X-Arm-Token", async () => {
      for (const [method, route, body] of MUTATING) {
        for (const extra of [{}, { "X-Arm-Token": ARM }] as Record<string, string>[]) {
          const r = await hub.req(method, route, { ...ROH, ...extra }, body);
          assert.equal(r.status, 403, `${method} ${route} ${JSON.stringify(extra)}`);
        }
      }
    });

    await test("read-only token on the Pi WebSocket → 403, never upgraded", async () => {
      assert.equal(await piUpgrade(hub, RO), 403);
    });

    await test("client token still works: GET 200, writes reach their handlers (503 no Pi, not 401/403)", async () => {
      assert.equal((await hub.req("GET", "/api/state", CLH)).status, 200);
      assert.equal((await hub.req("POST", "/api/command", CLH, MUTATING[0][2])).status, 503);
      assert.equal((await hub.req("POST", "/api/breaker", { ...CLH, "X-Arm-Token": ARM }, MUTATING[2][2])).status, 503);
      assert.equal(await piUpgrade(hub, PI), "open");
    });

    await test("no token or a wrong token → 401 on read and write", async () => {
      for (const h of [{}, { Authorization: "Bearer nope" }] as Record<string, string>[]) {
        assert.equal((await hub.req("GET", "/api/state", h)).status, 401);
        assert.equal((await hub.req("POST", "/api/command", h, MUTATING[0][2])).status, 401);
      }
    });
  } finally {
    for (const h of hubs) await h.stop();
  }
  console.log(`readonly.e2e.test.ts: ${passed} groups passed`);
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  for (const h of hubs) console.error(`--- hub :${h.port} log:\n` + h.log.join("\n"));
  for (const h of hubs) await h.stop();
  process.exit(1);
});
