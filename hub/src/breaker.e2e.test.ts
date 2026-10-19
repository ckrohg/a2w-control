/**
 * @purpose End-to-end coverage of POST /api/breaker on the real hub (spawned as a child, like
 * link.e2e.test.ts) with a fake Pi on a real WebSocket: the double gate (client bearer AND
 * X-Arm-Token), 503 when arming is unconfigured or no Pi, 400 on a malformed body, 501 fast for a
 * bridge that predates breaker control, the command frame the Pi receives, the read-back result
 * relayed verbatim (200 on a verified ack, 502 on a refusal), 504 when no ack arrives, and
 * /api/state carrying the bridge's span snapshot. BREAKER_ACK_GRACE_MS is shortened so the
 * timeout case costs half a second. Run: npx tsx src/breaker.e2e.test.ts
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

  static async start(env: Record<string, string>): Promise<Hub> {
    const hub = new Hub(await freePort());
    const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: HUB_DIR,
      env: { ...process.env, PORT: String(hub.port), HUB_PI_TOKEN: PI, HUB_CLIENT_TOKEN: CLIENT,
             NTFY_TOPIC: "", PLANNER_HEALTH_URL: "", BREAKER_ACK_GRACE_MS: "500", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const sink = (d: Buffer) => { for (const l of d.toString().split("\n")) if (l.trim()) hub.log.push(l); };
    p.stdout!.on("data", sink);
    p.stderr!.on("data", sink);
    hub.proc = p;
    const up = await waitFor(async () => {
      try { return (await fetch(`http://127.0.0.1:${hub.port}/health`)).ok; } catch { return false; }
    }, 20_000);
    if (!up) throw new Error(`hub did not come up\n${hub.log.join("\n")}`);
    return hub;
  }

  post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}/api/breaker`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  async stop(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    p.kill("SIGTERM");
    if (!(await waitFor(() => p.exitCode !== null || p.signalCode !== null, 8_000))) p.kill("SIGKILL");
  }
}

type Frame = Record<string, unknown>;

/** A fake Pi: connects, pushes one state frame, records commands, answers per `reply`. */
async function fakePi(hub: Hub, opts: { capabilities?: string[]; span?: unknown;
                                        reply?: (cmd: Frame) => Frame | null }) {
  const commands: Frame[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${hub.port}/pi`, { headers: { Authorization: `Bearer ${PI}` } });
    w.on("open", () => resolve(w));
    w.on("error", reject);
  });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as Frame;
    if (m.type !== "command") return;
    commands.push(m);
    const ack = opts.reply?.(m);
    if (ack) ws.send(JSON.stringify({ type: "ack", command_id: m.command_id, setpoint_c: null, ...ack }));
  });
  const ts = Date.now() / 1000 + Math.random();   // unique, so we wait for THIS frame
  ws.send(JSON.stringify({ type: "state", ts, pumps: [],
                           ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
                           ...(opts.span ? { span: opts.span } : {}) }));
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${hub.port}/api/state`, { headers: { Authorization: `Bearer ${CLIENT}` } });
    return ((await r.json()) as { ts: number | null }).ts === ts;
  });
  return { ws, commands };
}

const AUTH = { Authorization: `Bearer ${CLIENT}`, "X-Arm-Token": ARM };
const CYCLE = { circuit: "Air-Water 2", action: "power_cycle", off_s: 60 };
const hubs: Hub[] = [];
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok   ${name}`);
}

(async () => {
  try {
    const unarmed = await Hub.start({ HUB_ARM_TOKEN: "" });
    hubs.push(unarmed);
    await test("arming unconfigured (HUB_ARM_TOKEN unset) → 503, even with the client token", async () => {
      const r = await unarmed.post(CYCLE, AUTH);
      assert.equal(r.status, 503);
    });
    await unarmed.stop();

    const hub = await Hub.start({ HUB_ARM_TOKEN: ARM });
    hubs.push(hub);

    await test("auth: no bearer → 401; bearer without arm token → 401; wrong arm token → 401", async () => {
      assert.equal((await hub.post(CYCLE)).status, 401);
      assert.equal((await hub.post(CYCLE, { Authorization: `Bearer ${CLIENT}` })).status, 401);
      assert.equal((await hub.post(CYCLE, { Authorization: `Bearer ${CLIENT}`, "X-Arm-Token": "nope" })).status, 401);
      assert.equal((await hub.post(CYCLE, { Authorization: "Bearer nope", "X-Arm-Token": ARM })).status, 401);
    });

    await test("malformed body → 400 (off_s below the 60 s floor, unknown action)", async () => {
      assert.equal((await hub.post({ ...CYCLE, off_s: 30 }, AUTH)).status, 400);
      assert.equal((await hub.post({ circuit: "Air-Water 2", action: "toggle" }, AUTH)).status, 400);
    });

    await test("no Pi connected → 503", async () => {
      assert.equal((await hub.post(CYCLE, AUTH)).status, 503);
    });

    await test("old bridge (no 'breaker' capability) → 501 immediately, nothing sent to the Pi", async () => {
      const old = await fakePi(hub, {});
      const t0 = Date.now();
      const r = await hub.post(CYCLE, AUTH);
      assert.equal(r.status, 501);
      assert.ok(Date.now() - t0 < 2_000, "answered without waiting for an ack");
      assert.equal(old.commands.length, 0);
      old.ws.close();
      await sleep(100);
    });

    const span = { circuits: [{ name: "Air-Water 2", relay_state: "CLOSED", power_w: 108 }], busy: null };
    const pi = await fakePi(hub, {
      capabilities: ["breaker"], span,
      reply: (cmd) => {
        if (cmd.circuit === "Silent") return null;                         // never acks
        if (cmd.circuit === "Buffer Tank") {
          return { ok: false, detail: "refused: close-only", result: { ok: false, refused: true } };
        }
        return { ok: true, detail: "OFF 60 s, back ON (verified)",
                 result: { ok: true, circuit: cmd.circuit, relay_state: "CLOSED", verified: true, off_s: 60.4 } };
      },
    });

    await test("/api/state carries the bridge's span snapshot", async () => {
      const r = await fetch(`http://127.0.0.1:${hub.port}/api/state`, { headers: { Authorization: `Bearer ${CLIENT}` } });
      assert.deepEqual(((await r.json()) as { span: unknown }).span, span);
    });

    await test("verified ack → 200 with the read-back result; the Pi got the breaker frame", async () => {
      const r = await hub.post(CYCLE, AUTH);
      assert.equal(r.status, 200);
      const out = (await r.json()) as { ok: boolean; result: { relay_state: string; verified: boolean } };
      assert.equal(out.ok, true);
      assert.equal(out.result.relay_state, "CLOSED");
      assert.equal(out.result.verified, true);
      const cmd = pi.commands.at(-1)!;
      assert.equal(cmd.action, "breaker");
      assert.equal(cmd.op, "power_cycle");
      assert.equal(cmd.circuit, "Air-Water 2");
      assert.equal(cmd.off_s, 60);
      assert.equal(cmd.source, "armed-dashboard");
    });

    await test("bridge refusal → 502 with its detail and result", async () => {
      const r = await hub.post({ circuit: "Buffer Tank", action: "open" }, AUTH);
      assert.equal(r.status, 502);
      const out = (await r.json()) as { detail: string; result: { refused: boolean } };
      assert.match(out.detail, /close-only/);
      assert.equal(out.result.refused, true);
    });

    await test("no ack → 504 after the grace (close: grace only)", async () => {
      const t0 = Date.now();
      const r = await hub.post({ circuit: "Silent", action: "close" }, AUTH);
      assert.equal(r.status, 504);
      assert.ok(Date.now() - t0 >= 450, "waited the grace");
    });
    pi.ws.close();
  } finally {
    for (const h of hubs) await h.stop();
  }
  console.log(`breaker.e2e.test.ts: ${passed} groups passed`);
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  for (const h of hubs) console.error(`--- hub :${h.port} log:\n` + h.log.join("\n"));
  for (const h of hubs) await h.stop();
  process.exit(1);
});
