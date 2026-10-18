/**
 * @purpose Lifecycle coverage for the Pi-link dropout bookkeeping in index.ts (#166) — the
 * ORDERING cases the pure tracker tests cannot reach, because they live in how ws emits
 * `connection`, `close` and the ping timer. Spawns the real hub as a direct child of this
 * process (node --import tsx, a free port) and drives it with real sockets.
 *
 * Two hub instances, so each guard is tested in isolation rather than by racing a timer:
 *
 *   FAST hub (ping every 1.5 s)
 *   1. a replacement connection while the old socket is OPEN          → no dropout
 *   2. a plain close + reconnect                                       → one short episode
 *   3. a missed pong (client never answers protocol pings)            → terminated, counted once
 *   4. the Pi sends a close frame but holds TCP open (socket CLOSING
 *      for up to 30 s in ws), no reconnect                             → the PING TIMER registers it
 *
 *   SLOW hub (ping every 10 min — the timer cannot fire during the case)
 *   5. the same CLOSING socket, then a reconnect                       → the CONNECTION guard
 *      registers it; with that guard removed this case fails, because nothing else can
 *
 * Every assertion is a per-case delta against the hub's log or /health, polled with a bounded
 * wait rather than a fixed sleep. Runs under `npm test` with the rest of src/*.test.ts, ~12 s.
 * The hub's boot probes do reach ntfy.sh / api.resend.com (async, bounded, logged only);
 * nothing asserted depends on them.
 *
 * Not covered, deliberately: a replacement landing in the microseconds between terminate() and
 * the destroyed socket's `close` event. That window cannot be hit from outside the process;
 * it is closed twice over (markDisconnected at terminate time, and the CLOSING guard in
 * `connection` that case 5 isolates), so either guard alone keeps the count right.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";

const HUB_DIR = path.resolve(__dirname, "..");
const PI_TOKEN = "e2e-pi-token";
const FAST_PING_MS = 1_500;
const SLOW_PING_MS = 600_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `pred` until true or `ms` elapses; returns whether it became true. */
async function waitFor(pred: () => boolean | Promise<boolean>, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(25);
  }
  return pred();
}

/** Ask the OS for a free port (close it; the hub binds it a few ms later). */
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

interface Health {
  ok: boolean; pi_connected: boolean; last_state_ts: number | null;
  pi_dropouts_24h: number; pi_dropouts_7d: number; longest_dropout_min: number;
  last_dropout: { start: string; end: string; minutes: number } | null;
  current_dropout_min: number | null; tracking_since: string;
}

/** Masked close frame (clients must mask), no payload. */
const CLOSE_FRAME = Buffer.concat([Buffer.from([0x88, 0x80]), randomBytes(4)]);
const DISCONNECTED = "[hub] Pi disconnected";
const RECONNECTED = "[hub] Pi reconnected after";
const MISSED_PONG = "[hub] Pi missed pong";

/** One spawned hub: its port, its line-buffered log, and clients that talk to it. */
class Hub {
  readonly log: string[] = [];
  private proc?: ChildProcess;
  private constructor(readonly port: number, readonly pingMs: number) {}

  static async start(pingMs: number): Promise<Hub> {
    const hub = new Hub(await freePort(), pingMs);
    // A DIRECT child (node --import tsx), not `npx tsx`: launchers interpose processes that do
    // not reliably forward signals, and a hub left listening after a failed run would poison
    // the next one. tsx resolves from the hub's own node_modules (a devDependency; cwd = hub/).
    const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: HUB_DIR,
      env: { ...process.env, PORT: String(hub.port), HUB_PI_TOKEN: PI_TOKEN, HUB_CLIENT_TOKEN: "e2e-client",
             NTFY_TOPIC: "", PLANNER_HEALTH_URL: "", PI_PING_INTERVAL_MS: String(pingMs) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout!.on("data", hub.lineSink());
    p.stderr!.on("data", hub.lineSink());
    p.once("exit", (code, sig) => hub.log.push(`[hub] <exited code=${code} signal=${sig}>`));
    hub.proc = p;
    const up = await waitFor(async () => {
      if (p.exitCode !== null) return true;
      try { await hub.health(); return true; } catch { return false; }
    }, 20_000);
    if (!up || p.exitCode !== null) throw new Error(`hub did not come up on :${hub.port}\n${hub.log.join("\n")}`);
    return hub;
  }

  /** Chunks need not end on line boundaries: keep the partial tail per stream. */
  private lineSink(): (d: Buffer) => void {
    let tail = "";
    return (d: Buffer) => {
      const parts = (tail + d.toString()).split("\n");
      tail = parts.pop() ?? "";
      for (const l of parts) if (l.startsWith("[hub]")) this.log.push(l);
    };
  }

  count(needle: string): number { return this.log.filter((l) => l.includes(needle)).length; }

  async health(): Promise<Health> {
    return (await (await fetch(`http://127.0.0.1:${this.port}/health`)).json()) as Health;
  }

  /** A Pi that answers pings (or not). */
  pi(opts: { autoPong?: boolean } = {}): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/pi`, {
        headers: { Authorization: `Bearer ${PI_TOKEN}` },
        autoPong: opts.autoPong ?? true,
      });
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });
  }

  /** A raw socket that completes the WS handshake, then can send a close FRAME while keeping
   *  TCP open — that is what parks the hub's side in CLOSING until ws's 30 s close timer. */
  rawPi(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const sock = net.connect({ port: this.port, host: "127.0.0.1", allowHalfOpen: true });
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.write(
          `GET /pi HTTP/1.1\r\nHost: 127.0.0.1:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${PI_TOKEN}\r\n\r\n`,
        );
      });
      sock.once("data", (buf) => {
        const expect = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
        if (!buf.toString().includes(`Sec-WebSocket-Accept: ${expect}`)) reject(new Error("handshake failed"));
        else resolve(sock);
      });
    });
  }

  /** Close a Pi socket and wait until the hub has logged that drop. */
  async dropAndSettle(ws: WebSocket): Promise<void> {
    const before = this.count(DISCONNECTED);
    ws.close();
    assert.ok(await waitFor(() => this.count(DISCONNECTED) === before + 1), "hub logged the drop");
  }

  /** SIGTERM (the hub has its own graceful shutdown) and wait, bounded, for it to exit. */
  async stop(): Promise<void> {
    const p = this.proc;
    if (!p || p.exitCode !== null || p.signalCode !== null) return;
    p.kill("SIGTERM");
    const gone = await waitFor(() => p.exitCode !== null || p.signalCode !== null, 8_000);
    if (!gone) p.kill("SIGKILL");
  }
}

const hubs: Hub[] = [];
let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok   ${name}`);
}

(async () => {
  try {
    const fast = await Hub.start(FAST_PING_MS);
    hubs.push(fast);

    await test("boot: pre-#166 fields first and unchanged, no episodes", async () => {
      const h = await fast.health();
      assert.deepEqual(Object.keys(h).slice(0, 3), ["ok", "pi_connected", "last_state_ts"]);
      assert.equal(h.pi_connected, false);
      assert.equal(h.pi_dropouts_24h, 0);
      assert.equal(h.current_dropout_min, null, "the wait for the first Pi is not a dropout");
    });

    await test("replacement while OPEN is not a dropout", async () => {
      const a = await fast.pi();
      assert.ok(await waitFor(async () => (await fast.health()).pi_connected));
      const dc = fast.count(DISCONNECTED);
      const b = await fast.pi();
      assert.ok(await waitFor(() => a.readyState === WebSocket.CLOSED), "old socket closed by the hub (4000)");
      const h = await fast.health();
      assert.equal(h.pi_connected, true);
      assert.equal(h.pi_dropouts_24h, 0, "a live socket being replaced is not a dropout");
      assert.equal(h.current_dropout_min, null);
      assert.equal(fast.count(DISCONNECTED), dc, "no disconnect logged for the replaced socket");
      await fast.dropAndSettle(b);                       // a real drop, consumed by the next case
    });

    await test("plain close + reconnect: one short episode, one reconnect line", async () => {
      const h0 = await fast.health();
      assert.equal(h0.pi_connected, false);
      assert.equal(typeof h0.current_dropout_min, "number", "open dropout is visible while disconnected");
      const drops = h0.pi_dropouts_24h, rc = fast.count(RECONNECTED);
      const c = await fast.pi();
      assert.ok(await waitFor(() => fast.count(RECONNECTED) === rc + 1));
      const h = await fast.health();
      assert.equal(h.pi_dropouts_24h, drops + 1);
      assert.equal(h.current_dropout_min, null);
      assert.ok(h.last_dropout && h.last_dropout.minutes < 1, "a seconds-long drop is a <1 min episode");
      await fast.dropAndSettle(c);
    });

    await test("missed pong: terminated, counted exactly once, closed by the next connect", async () => {
      const d = await fast.pi({ autoPong: false });
      assert.ok(await waitFor(async () => (await fast.health()).pi_connected));
      const dc = fast.count(DISCONNECTED), mp = fast.count(MISSED_PONG), drops = (await fast.health()).pi_dropouts_24h;
      // first tick marks it stale, second tick terminates: ≤ 2 intervals + margin.
      assert.ok(await waitFor(() => fast.count(MISSED_PONG) === mp + 1, FAST_PING_MS * 3), "hub reaped the silent Pi");
      assert.ok(await waitFor(() => d.readyState === WebSocket.CLOSED));
      await sleep(200);                                  // let the socket's `close` cleanup run
      assert.equal(fast.count(DISCONNECTED), dc + 1, "terminate counts once, not again on close");
      const h = await fast.health();
      assert.equal(h.pi_connected, false);
      assert.equal(typeof h.current_dropout_min, "number");
      assert.equal(h.pi_dropouts_24h, drops, "still open: not counted until it closes");
      const e = await fast.pi();
      assert.ok(await waitFor(async () => (await fast.health()).pi_dropouts_24h === drops + 1));
      await fast.dropAndSettle(e);
    });

    await test("close frame with TCP held open (socket CLOSING), no reconnect: the ping timer registers it", async () => {
      const f = await fast.rawPi();
      assert.ok(await waitFor(async () => (await fast.health()).pi_connected));
      const dc = fast.count(DISCONNECTED);
      f.write(CLOSE_FRAME);                              // Pi says goodbye but never closes TCP
      assert.ok(await waitFor(async () => !(await fast.health()).pi_connected, 1_000), "readyState left OPEN");
      assert.ok(await waitFor(() => fast.count(DISCONNECTED) === dc + 1, FAST_PING_MS * 2), "ping timer registered it");
      const h = await fast.health();
      assert.equal(h.pi_connected, false);
      assert.equal(typeof h.current_dropout_min, "number", "tracker agrees with pi_connected");
      f.destroy();
      await sleep(300);
      assert.equal(fast.count(DISCONNECTED), dc + 1, "the eventual close is a no-op");
    });

    await fast.stop();

    // --- the connection-time guard, isolated: a hub whose ping timer cannot fire in time ---
    const slow = await Hub.start(SLOW_PING_MS);
    hubs.push(slow);

    await test("close frame with TCP held open (socket CLOSING) + reconnect: the CONNECTION guard registers it", async () => {
      const f = await slow.rawPi();
      assert.ok(await waitFor(async () => (await slow.health()).pi_connected));
      const dc = slow.count(DISCONNECTED), rc = slow.count(RECONNECTED), drops = (await slow.health()).pi_dropouts_24h;
      f.write(CLOSE_FRAME);                              // Pi says goodbye but never closes TCP
      assert.ok(await waitFor(async () => !(await slow.health()).pi_connected, 1_000), "readyState left OPEN");
      assert.equal(slow.count(DISCONNECTED), dc, "no ping tick can have run: the only way to count this is the guard");
      const g = await slow.pi();
      assert.ok(await waitFor(() => slow.count(RECONNECTED) === rc + 1), "reconnect line logged");
      const h = await slow.health();
      assert.equal(h.pi_connected, true);
      assert.equal(h.pi_dropouts_24h, drops + 1, "the CLOSING socket's dropout is counted by the connection guard");
      assert.equal(slow.count(DISCONNECTED), dc + 1);
      assert.ok(slow.log.indexOf(DISCONNECTED) < slow.log.lastIndexOf("[hub] Pi connected"),
        "guard runs before the new socket is announced");
      // The late `close` of the old socket must not count again.
      f.destroy();
      await sleep(500);
      assert.equal(slow.count(DISCONNECTED), dc + 1, "late close of the replaced socket is a no-op");
      assert.equal((await slow.health()).pi_dropouts_24h, drops + 1);
      await slow.dropAndSettle(g);
    });
  } finally {
    for (const h of hubs) await h.stop();
  }
  console.log(`link.e2e.test.ts: ${passed} groups passed`);
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  for (const h of hubs) console.error(`--- hub :${h.port} (ping ${h.pingMs} ms) log:\n` + h.log.join("\n"));
  for (const h of hubs) await h.stop();
  process.exit(1);
});
