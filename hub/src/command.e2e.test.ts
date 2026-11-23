/**
 * @purpose End-to-end coverage of the Pi-dropout path on the real hub spawned as a child (like
 * link.e2e.test.ts) with a fake Pi on a real WebSocket. The unit tests in command.test.ts prove
 * failPendingOnDisconnect; this file proves the wiring in index.ts: markDisconnected answers an
 * in-flight /api/command the moment the link goes, so the planner gets a 502 'Pi disconnected
 * before ack' in well under COMMAND_ACK_TIMEOUT_MS (10 s, not configurable) instead of a 504 'ack
 * timeout'. It also proves what the drop must NOT do: /api/write-enable and /api/breaker share the
 * same `pending` map but do not set failOnDisconnect, so they wait out their own timers and answer
 * 504 (a breaker action carries on on the Pi, and its 504 tells the dashboard not to retry yet).
 * The breaker's grace is 4 s here: longer than "at once", shorter than the 10 s ack timeout. Also:
 * the map is clean afterwards (a reconnected Pi's ack lands), and a late ack for a command the
 * drop already answered is a no-op. Run: npx tsx src/command.e2e.test.ts
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";
import { PI_DISCONNECTED_DETAIL } from "./command";

const HUB_DIR = path.resolve(__dirname, "..");
const PI = "e2e-pi-token";
const CLIENT = "e2e-client-token";
const ARM = "e2e-arm-token";
const COMMAND_ACK_TIMEOUT_MS = 10_000;          // hub/src/index.ts, fixed
const BREAKER_GRACE_MS = 4_000;                 // a close/open waits exactly this long for its ack
const PROMPT_MS = 2_000;                        // "well under" the 10 s ack timeout
const TIMER_SLACK_MS = 100;                     // a timer never fires early; this covers clock rounding only
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

  static async start(): Promise<Hub> {
    const hub = new Hub(await freePort());
    const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: HUB_DIR,
      env: { ...process.env, PORT: String(hub.port), HUB_PI_TOKEN: PI, HUB_CLIENT_TOKEN: CLIENT, HUB_ARM_TOKEN: ARM,
             NTFY_TOPIC: "", PLANNER_HEALTH_URL: "", BREAKER_ACK_GRACE_MS: String(BREAKER_GRACE_MS) },
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

  count(needle: string): number { return this.log.filter((l) => l.includes(needle)).length; }

  post(route: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`http://127.0.0.1:${this.port}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${CLIENT}`, ...headers },
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
interface Answer { status: number; ms: number; body: { ok: boolean; detail?: string; result?: unknown; setpoint_c?: number | null } }

/** A fake Pi: connects, pushes one state frame (so /api/breaker sees the capability), records the
 *  commands it receives, and acks only when `reply` returns something. */
async function fakePi(hub: Hub, reply: (cmd: Frame) => Frame | null = () => null) {
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
    const ack = reply(m);
    if (ack) ws.send(JSON.stringify({ type: "ack", command_id: m.command_id, setpoint_c: null, ...ack }));
  });
  const ts = Date.now() / 1000 + Math.random();
  ws.send(JSON.stringify({ type: "state", ts, pumps: [], capabilities: ["breaker"],
                           span: { circuits: [{ name: "Air-Water 2", relay_state: "CLOSED", power_w: 100 }], busy: null } }));
  assert.ok(await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${hub.port}/api/state`, { headers: { Authorization: `Bearer ${CLIENT}` } });
    return ((await r.json()) as { ts: number | null }).ts === ts;
  }), "the fake Pi's state frame reached the hub");
  return { ws, commands };
}

/** Fire a request and time its answer, without awaiting it yet. */
function timed(p: Promise<Response>): Promise<Answer> {
  const t0 = Date.now();
  return p.then(async (r) => ({ status: r.status, ms: Date.now() - t0, body: (await r.json()) as Answer["body"] }));
}

const SETPOINT = { pump_id: "aw1", value_c: 40, lease_minutes: 30, source: "planner" };
const ARMED = { "X-Arm-Token": ARM };
const hubs: Hub[] = [];
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok   ${name}`);
}

(async () => {
  try {
    const hub = await Hub.start();
    hubs.push(hub);

    await test("/api/command: the Pi takes the command and closes without acking → 502 'Pi disconnected before ack' at once", async () => {
      const pi = await fakePi(hub);
      const dc = hub.count("[hub] Pi disconnected");
      const answer = timed(hub.post("/api/command", SETPOINT));
      assert.ok(await waitFor(() => pi.commands.length === 1), "the Pi received the setpoint command");
      assert.equal(pi.commands[0].action, "setpoint");
      pi.ws.close();                                   // a plain close frame, as a rebooting bridge sends
      const a = await answer;
      assert.equal(a.status, 502);
      assert.deepEqual(a.body, { ok: false, detail: PI_DISCONNECTED_DETAIL });
      assert.equal(a.body.detail, "Pi disconnected before ack");
      assert.ok(a.ms < PROMPT_MS, `answered in ${a.ms} ms, not the ${COMMAND_ACK_TIMEOUT_MS} ms ack timeout`);
      assert.ok(await waitFor(() => hub.count("[hub] Pi disconnected — failed 1 pending command(s)") === 1), "the hub logged the one command it failed");
      assert.equal(hub.count("[hub] Pi disconnected"), dc + 1);
    });

    await test("three in flight across /api/command, /api/write-enable and /api/breaker; the Pi is terminated → only the setpoint command 502s at once, the other two wait out their own 504", async () => {
      const pi = await fakePi(hub);
      const failedBefore = hub.count("failed 1 pending command(s)");
      const answers = [
        timed(hub.post("/api/command", SETPOINT)),
        timed(hub.post("/api/write-enable", { pump_id: "aw1", enabled: true }, ARMED)),
        timed(hub.post("/api/breaker", { circuit: "Air-Water 2", action: "close" }, ARMED)),
      ];
      assert.ok(await waitFor(() => pi.commands.length === 3), "the Pi received all three commands");
      pi.ws.terminate();                               // TCP torn down without a close frame: a Wi-Fi drop
      const [cmd, arm, brk] = await Promise.all(answers);

      assert.equal(cmd.status, 502);
      assert.deepEqual(cmd.body, { ok: false, detail: PI_DISCONNECTED_DETAIL });
      assert.ok(cmd.ms < PROMPT_MS, `the setpoint command was answered in ${cmd.ms} ms`);

      // The breaker is NOT answered by the drop: the bridge may still carry the action through, and
      // the 504 wording is what stops the dashboard retrying before the relay state settles.
      assert.equal(brk.status, 504);
      assert.match(brk.body.detail!, /no answer from the bridge in time — the action may still complete/);
      assert.ok(brk.ms >= BREAKER_GRACE_MS - TIMER_SLACK_MS, `the breaker waited out its grace (${brk.ms} ms)`);

      // Write-enable keeps its plain ack timeout too.
      assert.equal(arm.status, 504);
      assert.deepEqual(arm.body, { ok: false, detail: "ack timeout" });
      assert.ok(arm.ms >= COMMAND_ACK_TIMEOUT_MS - TIMER_SLACK_MS, `write-enable waited out the ack timeout (${arm.ms} ms)`);

      assert.equal(hub.count("failed 1 pending command(s)"), failedBefore + 1, "the drop answered one entry, not three");
      assert.equal(hub.count("failed 3 pending command(s)"), 0);
    });

    await test("after the drop the map is clean: a late ack for the command it answered is a no-op, and the reconnected Pi's ack lands as 200", async () => {
      const silent = await fakePi(hub);                // never acks
      const dropped = timed(hub.post("/api/command", SETPOINT));
      assert.ok(await waitFor(() => silent.commands.length === 1));
      const droppedId = silent.commands[0].command_id as string;
      silent.ws.terminate();
      const d = await dropped;
      assert.equal(d.status, 502);
      assert.equal(d.body.detail, PI_DISCONNECTED_DETAIL);

      const back = await fakePi(hub, () => ({ ok: true, detail: "applied", setpoint_c: 41 }));
      // that command's ack arrives late, on the new link: nothing left to settle, nothing answered twice
      back.ws.send(JSON.stringify({ type: "ack", command_id: droppedId, ok: true, detail: "late", setpoint_c: 40 }));
      const fresh = await timed(hub.post("/api/command", { ...SETPOINT, value_c: 41 }));
      assert.equal(fresh.status, 200);
      assert.deepEqual(fresh.body, { ok: true, setpoint_c: 41 });
      assert.equal(back.commands.length, 1, "only the fresh command reached the reconnected Pi");
      assert.ok((await (await fetch(`http://127.0.0.1:${hub.port}/health`)).json() as { pi_connected: boolean }).pi_connected);
      back.ws.close();
      await sleep(100);
    });
  } finally {
    for (const h of hubs) await h.stop();
  }
  console.log(`command.e2e.test.ts: ${passed} groups passed`);
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  for (const h of hubs) console.error(`--- hub :${h.port} log:\n` + h.log.join("\n"));
  for (const h of hubs) await h.stop();
  process.exit(1);
});
