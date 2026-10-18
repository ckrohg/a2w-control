/**
 * @purpose Lifecycle coverage for the Pi-link dropout bookkeeping in index.ts (#166) — the
 * ORDERING cases the pure tracker tests cannot reach, because they live in how ws emits
 * `connection`, `close` and the ping timer. Spawns the real hub as a direct child of this
 * process (node --import tsx, a free port, a 1.5 s ping interval) and drives it with real sockets:
 *
 *   1. a replacement connection while the old socket is OPEN          → no dropout
 *   2. a plain close + reconnect                                       → one short episode
 *   3. a missed pong (client never answers protocol pings)            → terminated, counted once
 *   4. the Pi sends a close frame but holds TCP open (socket CLOSING
 *      for up to 30 s in ws) and reconnects BEFORE the ping timer
 *      notices (asserted as a precondition, so the case cannot pass
 *      vacuously on a slow runner)                                     → counted, not swallowed
 *   5. the same with no reconnect                                      → the ping timer registers it
 *
 * Every assertion is a per-case delta against the hub's log or /health, polled with a bounded
 * wait rather than a fixed sleep. Runs under `npm test` with the rest of src/*.test.ts, ~15 s.
 * The hub's own boot probes do reach ntfy.sh / api.resend.com (async, bounded, logged only);
 * nothing in the assertions depends on them.
 *
 * Not covered, deliberately: a replacement landing in the microseconds between terminate() and
 * the destroyed socket's `close` event. That window cannot be hit from outside the process;
 * it is closed twice over (markDisconnected at terminate time, and the CLOSING guard in
 * `connection` that case 4 does exercise), so either guard alone keeps the count right.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import WebSocket from "ws";

const HUB_DIR = path.resolve(__dirname, "..");
const PI_TOKEN = "e2e-pi-token";
const PING_MS = 1_500;
let PORT = 0;

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

// --- hub process + line-buffered log ----------------------------------------------------------

const proc: { hub?: ChildProcess } = {};
const log: string[] = [];
const count = (needle: string) => log.filter((l) => l.includes(needle)).length;
const DISCONNECTED = "[hub] Pi disconnected";
const RECONNECTED = "[hub] Pi reconnected after";

/** Chunks need not end on line boundaries: keep the partial tail per stream. */
function lineSink(): (d: Buffer) => void {
  let tail = "";
  return (d: Buffer) => {
    const parts = (tail + d.toString()).split("\n");
    tail = parts.pop() ?? "";
    for (const l of parts) if (l.startsWith("[hub]")) log.push(l);
  };
}

async function startHub(): Promise<void> {
  PORT = await freePort();
  // A DIRECT child (node --import tsx), not `npx tsx`: npx/tsx launchers interpose processes
  // that do not reliably forward signals, and a hub left listening after a failed run would
  // poison the next one. tsx resolves from the hub's own node_modules (a devDependency).
  const hub = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: HUB_DIR,
    env: { ...process.env, PORT: String(PORT), HUB_PI_TOKEN: PI_TOKEN, HUB_CLIENT_TOKEN: "e2e-client",
           NTFY_TOPIC: "", PLANNER_HEALTH_URL: "", PI_PING_INTERVAL_MS: String(PING_MS) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  hub.stdout!.on("data", lineSink());
  hub.stderr!.on("data", lineSink());
  hub.once("exit", (code, sig) => log.push(`[hub] <exited code=${code} signal=${sig}>`));
  proc.hub = hub;
  const up = await waitFor(async () => {
    if (hub.exitCode !== null) return true;
    try { await health(); return true; } catch { return false; }
  }, 20_000);
  if (!up || hub.exitCode !== null) throw new Error(`hub did not come up on :${PORT}\n${log.join("\n")}`);
}

/** SIGTERM the hub (it has its own graceful shutdown) and wait, bounded, for it to exit. */
async function stopHub(): Promise<void> {
  const hub = proc.hub;
  if (!hub || hub.exitCode !== null || hub.signalCode !== null) return;
  hub.kill("SIGTERM");
  const gone = await waitFor(() => hub.exitCode !== null || hub.signalCode !== null, 8_000);
  if (!gone) hub.kill("SIGKILL");
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`  ok   ${name}`);
}

/** Close a Pi socket and wait until the hub has logged that drop. */
async function dropAndSettle(ws: WebSocket): Promise<void> {
  const before = count(DISCONNECTED);
  ws.close();
  assert.ok(await waitFor(() => count(DISCONNECTED) === before + 1), "hub logged the drop");
}

(async () => {
  await startHub();
  try {
    await test("boot: pre-#166 fields first and unchanged, no episodes", async () => {
      const h = await health();
      assert.deepEqual(Object.keys(h).slice(0, 3), ["ok", "pi_connected", "last_state_ts"]);
      assert.equal(h.pi_connected, false);
      assert.equal(h.pi_dropouts_24h, 0);
      assert.equal(h.current_dropout_min, null, "the wait for the first Pi is not a dropout");
    });

    await test("replacement while OPEN is not a dropout", async () => {
      const a = await pi();
      assert.ok(await waitFor(async () => (await health()).pi_connected));
      const dc = count(DISCONNECTED);
      const b = await pi();
      assert.ok(await waitFor(() => a.readyState === WebSocket.CLOSED), "old socket closed by the hub (4000)");
      const h = await health();
      assert.equal(h.pi_connected, true);
      assert.equal(h.pi_dropouts_24h, 0, "a live socket being replaced is not a dropout");
      assert.equal(h.current_dropout_min, null);
      assert.equal(count(DISCONNECTED), dc, "no disconnect logged for the replaced socket");
      await dropAndSettle(b);                            // a real drop, consumed by the next case
    });

    await test("plain close + reconnect: one short episode, one reconnect line", async () => {
      const h0 = await health();
      assert.equal(h0.pi_connected, false);
      assert.equal(typeof h0.current_dropout_min, "number", "open dropout is visible while disconnected");
      const drops = h0.pi_dropouts_24h, rc = count(RECONNECTED);
      const c = await pi();
      assert.ok(await waitFor(() => count(RECONNECTED) === rc + 1));
      const h = await health();
      assert.equal(h.pi_dropouts_24h, drops + 1);
      assert.equal(h.current_dropout_min, null);
      assert.ok(h.last_dropout && h.last_dropout.minutes < 1, "a seconds-long drop is a <1 min episode");
      await dropAndSettle(c);
    });

    await test("missed pong: terminated, counted exactly once, closed by the next connect", async () => {
      const d = await pi({ autoPong: false });
      assert.ok(await waitFor(async () => (await health()).pi_connected));
      const dc = count(DISCONNECTED), drops = (await health()).pi_dropouts_24h;
      // first tick marks it stale, second tick terminates: ≤ 2 intervals + margin.
      assert.ok(await waitFor(() => count("Pi missed pong") === 1, PING_MS * 3), "hub reaped the silent Pi");
      assert.ok(await waitFor(() => d.readyState === WebSocket.CLOSED));
      await sleep(200);                                  // let the socket's `close` cleanup run
      assert.equal(count(DISCONNECTED), dc + 1, "terminate counts once, not again on close");
      const h = await health();
      assert.equal(h.pi_connected, false);
      assert.equal(typeof h.current_dropout_min, "number");
      assert.equal(h.pi_dropouts_24h, drops, "still open: not counted until it closes");
      const e = await pi();
      assert.ok(await waitFor(async () => (await health()).pi_dropouts_24h === drops + 1));
      await dropAndSettle(e);
    });

    await test("close frame with TCP held open (socket CLOSING) + reconnect BEFORE the ping tick: counted", async () => {
      const f = await rawPi();
      assert.ok(await waitFor(async () => (await health()).pi_connected));
      // Phase-align with the ping timer: wait for the hub's next ping frame (0x89) so the
      // following tick is a full PING_MS away, then act inside that window.
      await new Promise<void>((r) => f.once("data", () => r()));
      const dc = count(DISCONNECTED), rc = count(RECONNECTED), drops = (await health()).pi_dropouts_24h;
      f.write(CLOSE_FRAME);                              // Pi says goodbye but never closes TCP
      assert.ok(await waitFor(async () => !(await health()).pi_connected, 1_000), "readyState left OPEN");
      // PRECONDITION for the race: the ping timer has NOT registered the drop yet. If this
      // fails the runner is too slow for the window, and the case must fail, not pass vacuously.
      assert.equal(count(DISCONNECTED), dc, "precondition: ping timer has not noticed the CLOSING socket");
      const g = await pi();
      assert.ok(await waitFor(() => count(RECONNECTED) === rc + 1), "reconnect line logged");
      const h = await health();
      assert.equal(h.pi_connected, true);
      assert.equal(h.pi_dropouts_24h, drops + 1, "the CLOSING socket's dropout is counted");
      assert.equal(count(DISCONNECTED), dc + 1);
      // The late `close` of the old socket must not count again.
      f.destroy();
      await sleep(PING_MS + 300);                        // past one more ping tick as well
      assert.equal(count(DISCONNECTED), dc + 1, "late close of the replaced socket is a no-op");
      assert.equal((await health()).pi_dropouts_24h, drops + 1);
      await dropAndSettle(g);
    });

    await test("close frame with TCP held open, NO reconnect: the ping timer registers it within one interval", async () => {
      const f = await rawPi();
      assert.ok(await waitFor(async () => (await health()).pi_connected));
      const dc = count(DISCONNECTED);
      f.write(CLOSE_FRAME);
      assert.ok(await waitFor(() => count(DISCONNECTED) === dc + 1, PING_MS * 2), "ping timer registered it");
      const h = await health();
      assert.equal(h.pi_connected, false);
      assert.equal(typeof h.current_dropout_min, "number", "tracker agrees with pi_connected");
      f.destroy();
      await sleep(300);
      assert.equal(count(DISCONNECTED), dc + 1, "the eventual close is a no-op");
    });
  } finally {
    await stopHub();
  }
  console.log(`link.e2e.test.ts: ${passed} groups passed`);
  process.exit(0);
})().catch(async (err) => {
  console.error(err);
  console.error("--- hub log:\n" + log.join("\n"));
  await stopHub();
  process.exit(1);
});
