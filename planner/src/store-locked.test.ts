/**
 * @purpose #177 (codex pass 3): the queries that run under the device lock (writes.ts withDeviceLock) must fail in
 * bounded time even when the database connection never completes startup — otherwise one stalled TLS/auth handshake
 * after a successful PATCH holds the lock, and every later write (a restore included) queues behind it. A black-hole
 * TCP server (accepts, never answers) stands in for the stalled database. Run with: npx tsx planner/src/store-locked.test.ts
 */
import assert from "node:assert/strict";
import net from "node:net";
import { Store } from "./store";

// a regression here HANGS (that is the bug) — fail the suite instead of the CI job timing out
setTimeout(() => { console.error("store-locked.test.ts: a lock-held query hung — no connect/query timeout"); process.exit(1); }, 20_000).unref();

(async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((s) => { sockets.push(s); }); // accept and say nothing, ever
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  const store = new Store(`postgres://x@127.0.0.1:${port}/x`, { connect: 300, statement: 1_000, query: 1_500 });

  for (const [name, call] of [
    ["latestConfig", () => store.latestConfig()],
    ["latestConfigVersion", () => store.latestConfigVersion()],
    ["plannerWrites", () => store.plannerWrites(new Date())],
    ["insertConfigVersion", () => store.insertConfigVersion({}, null)],
    ["insertHbxWrite", () => store.insertHbxWrite({ source: "t", action: "t", requested: null, result: "t", detail: "t" })],
  ] as const) {
    const t0 = Date.now();
    await assert.rejects(call(), `${name} must reject against a database that never answers`);
    const ms = Date.now() - t0;
    assert.ok(ms < 3_000, `${name} failed in ${ms} ms — bounded by the connect timeout, not hung`);
  }

  for (const s of sockets) s.destroy();
  server.close();
  await store.close().catch(() => {});
  console.log("store-locked.test.ts (#177 bounded lock-held queries): all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
