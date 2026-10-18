/**
 * @purpose Lifecycle coverage for the Pi-link dropout bookkeeping in index.ts (#166) — the
 * ORDERING cases the pure tracker tests cannot reach, because they live in how ws emits
 * `connection`, `close` and the ping timer. Spawns the real hub (tsx, random port, a 400 ms ping
 * interval) and drives it with real sockets:
 *
 *   1. a replacement connection while the old socket is OPEN          → no dropout
 *   2. a missed pong (client never answers protocol pings)            → terminated, counted once
 *   3. the Pi sends a close frame but holds TCP open (socket CLOSING
 *      for up to 30 s in ws) and reconnects inside that window          → counted, not swallowed
 *   4. a plain close + reconnect                                       → one short episode
 *
 * Runs under `npm test` with the rest of src/*.test.ts. ~10 s. Needs no network beyond localhost.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";

const HUB_DIR = path.resolve(__dirname, "..");
const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const PI_TOKEN = "e2e-pi-token";
const PING_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Health {
  ok: boolean; pi_connected: boolean; last_state_ts: number | null;
  pi_dropouts_24h: number; pi_dropouts_7d: number; longest_dropout_min: number;
  last_dropout: { start: string; end: string; minutes: number } | null;
  current_dropout_min: number | null; tracking_since: string;
}
const health = async (): Promise<Health> =>
  (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as Health;

/** A Pi that answers pings (or not). */
function pi(opts: { autoPong?: boolean } = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/pi`, {
      headers: { Authorization: `Bearer ${PI_TOKEN}` },
      autoPong: opts.autoPong ?? true,
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** A raw socket that completes the WS handshake, then can send a close FRAME while keeping
 *  TCP open — that is what parks the hub's side in CLOSING until ws's 30 s close timer. */
function rawPi(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const sock = net.connect({ port: PORT, host: "127.0.0.1", allowHalfOpen: true });
    sock.once("error", reject);
    sock.once("connect", () => {
      sock.write(
        `GET /pi HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
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
/** Masked close frame (clients must mask), no payload. */
const CLOSE_FRAME = Buffer.concat([Buffer.from([0x88, 0x80]), randomBytes(4)]);

const proc: { hub?: ChildProcess } = {};
const log: string[] = [];
const count = (needle: string) => log.filter((l) => l.includes(needle)).length;

async function startHub(): Promise<void> {
  const hub = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: HUB_DIR,
    env: { ...process.env, PORT: String(PORT), HUB_PI_TOKEN: PI_TOKEN, HUB_CLIENT_TOKEN: "e2e-client",
           NTFY_TOPIC: "", PLANNER_HEALTH_URL: "", PI_PING_INTERVAL_MS: String(PING_MS) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const grab = (d: Buffer) => { for (const l of d.toString().split("\n")) if (l.startsWith("[hub]")) log.push(l); };
  hub.stdout!.on("data", grab);
  hub.stderr!.on("data", grab);
  proc.hub = hub;
  for (let i = 0; i < 100; i++) {
    try { await health(); return; } catch { await sleep(200); }
  }
  throw new Error("hub did not come up");
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok   ${name}`);
}

(async () => {
  await startHub();
  try {
    await test("boot: pre-#166 fields first and unchanged, no episodes", async () => {
      const h = await health();
      assert.deepEqual(Object.keys(h).slice(0, 3), ["ok", "pi_connected", "last_state_ts"]);
      assert.equal(h.pi_connected, false);
      assert.equal(h.pi_dropouts_24h, 0);
    });

    await test("replacement while OPEN is not a dropout", async () => {
      const a = await pi(); await sleep(150);
      assert.equal((await health()).pi_connected, true);
      const b = await pi(); await sleep(300);           // a is closed with 4000 by the hub
      const h = await health();
      assert.equal(h.pi_connected, true);
      assert.equal(h.pi_dropouts_24h, 0, "a live socket being replaced is not a dropout");
      assert.equal(count("Pi disconnected"), 0);
      assert.equal(a.readyState, WebSocket.CLOSED);
      b.close(); await sleep(300);                      // a real drop, counted below
      assert.equal(count("Pi disconnected"), 1);
    });

    await test("plain close + reconnect: one short episode, one reconnect line", async () => {
      const before = (await health()).current_dropout_min;
      assert.equal(typeof before, "number", "open dropout is visible while disconnected");
      const c = await pi(); await sleep(200);
      const h = await health();
      assert.equal(h.pi_dropouts_24h, 1);
      assert.equal(h.current_dropout_min, null);
      assert.ok(h.last_dropout && h.last_dropout.minutes < 1);
      assert.equal(count("Pi reconnected after"), 1);
      c.close(); await sleep(300);
      assert.equal(count("Pi disconnected"), 2);
    });

    await test("missed pong: terminated, counted exactly once, closed by the next connect", async () => {
      const d = await pi({ autoPong: false }); await sleep(200);
      const dropsBefore = count("Pi disconnected");
      // ping at PING_MS marks it stale, the next tick terminates: ~2 intervals.
      await sleep(PING_MS * 3);
      assert.equal(count("Pi missed pong"), 1);
      assert.equal(count("Pi disconnected"), dropsBefore + 1, "terminate counts once, not again on close");
      assert.equal(d.readyState, WebSocket.CLOSED);
      const h = await health();
      assert.equal(h.pi_connected, false);
      assert.equal(typeof h.current_dropout_min, "number");
      const e = await pi(); await sleep(200);
      assert.equal((await health()).pi_dropouts_24h, 3);
      e.close(); await sleep(300);
    });

    await test("close frame with TCP held open (socket CLOSING) + reconnect inside the window: counted", async () => {
      const f = await rawPi(); await sleep(200);
      assert.equal((await health()).pi_connected, true);
      const drops = (await health()).pi_dropouts_24h;        // 4 so far
      const dcBefore = count("Pi disconnected");
      const rcBefore = count("Pi reconnected after");
      f.write(CLOSE_FRAME);                                   // Pi says goodbye but never closes TCP
      await sleep(100);
      // Before the hub notices via the ping timer, a new Pi arrives. pi_connected was already
      // false (readyState CLOSING); the episode must be registered, not swallowed.
      const g = await pi(); await sleep(250);
      const h = await health();
      assert.equal(h.pi_connected, true);
      assert.equal(h.pi_dropouts_24h, drops + 1, "the CLOSING socket's dropout is counted");
      assert.equal(count("Pi disconnected"), dcBefore + 1);
      assert.equal(count("Pi reconnected after"), rcBefore + 1);
      // The late `close` of the old socket (ws's 30 s timer, or our teardown here) must not count again.
      f.destroy(); await sleep(300);
      assert.equal(count("Pi disconnected"), dcBefore + 1);
      assert.equal((await health()).pi_dropouts_24h, drops + 1);
      g.close(); await sleep(300);
    });

    await test("close frame with TCP held open, NO reconnect: the ping timer registers it within one interval", async () => {
      const f = await rawPi(); await sleep(200);
      const dcBefore = count("Pi disconnected");
      f.write(CLOSE_FRAME);
      await sleep(PING_MS * 2);
      const h = await health();
      assert.equal(h.pi_connected, false);
      assert.equal(typeof h.current_dropout_min, "number", "tracker agrees with pi_connected");
      assert.equal(count("Pi disconnected"), dcBefore + 1);
      f.destroy(); await sleep(300);
      assert.equal(count("Pi disconnected"), dcBefore + 1, "the eventual close is a no-op");
    });
  } finally {
    proc.hub?.kill("SIGTERM");
  }
  console.log(`link.e2e.test.ts: ${passed} groups passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  console.error("--- hub log:\n" + log.join("\n"));
  proc.hub?.kill("SIGTERM");
  process.exit(1);
});
