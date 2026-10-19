/**
 * @purpose Assertions for the alert outbox (alerts.ts, #185 / #187): an undelivered page is re-sent until a channel
 * acknowledges it — across a restart — and an acknowledged one never again. Run with: npx tsx planner/src/alerts.test.ts
 */
import assert from "node:assert/strict";
import { AlertOutbox, type AlertStore } from "./alerts";

(async () => {
  // an in-memory alert_episodes table, shared across "restarts"
  const rows: { id: number; kind: string; key: string; title: string; detail: string; notified: boolean; cleared: boolean }[] = [];
  const store: AlertStore = {
    openAlertEpisode: async (kind, key, _p, title, detail) => { rows.push({ id: rows.length + 1, kind, key, title, detail, notified: false, cleared: false }); return rows.length; },
    markAlertNotified: async (id) => { rows[id - 1].notified = true; },
    undeliveredAlertEpisodes: async () => rows.filter((r) => !r.cleared && !r.notified).map((r) => ({ id: r.id, kind: r.kind, title: r.title, detail: r.detail })),
  };
  let up = false;
  const sent: string[] = [];
  const send = async (title: string) => { sent.push(title); return up; };

  // both channels down at the opening edge
  const a = new AlertOutbox(store, send, () => {});
  assert.equal(await a.open("fault_called", "2", "pump2", "⚠ Stage 2 called but Heat Pump 2 is FAULTED", "E21"), false);
  assert.equal(rows[0].notified, false, "not marked: nobody heard it");
  assert.equal(await a.retry(), 0, "still down: nothing sent");
  // RESTART: a fresh outbox over the same table, channels back
  up = true;
  const b = new AlertOutbox(store, send, () => {});
  assert.equal(await b.retry(), 1, "the undelivered page goes out after the restart");
  assert.equal(rows[0].notified, true);
  assert.equal(await b.retry(), 0, "and never again");
  assert.deepEqual(sent, ["⚠ Stage 2 called but Heat Pump 2 is FAULTED", "⚠ Stage 2 called but Heat Pump 2 is FAULTED", "⚠ Stage 2 called but Heat Pump 2 is FAULTED"]);
  // a cleared episode is not re-sent
  up = false;
  await b.open("span_local_stale", "span", null, "⚠ SPAN local stream stale", "x");
  rows[1].cleared = true;
  up = true;
  assert.equal(await b.retry(), 0, "cleared before delivery → not re-sent");
  // a DB failure on open still pages once
  const broken: AlertStore = { ...store, openAlertEpisode: async () => { throw new Error("db down"); } };
  const c = new AlertOutbox(broken, send, () => {});
  assert.equal(await c.open("stage_unserved", "1", "pump1", "t", "b"), true, "the page still goes out");
  // codex pass 2: the row could NOT be written AND nobody heard the page → kept in memory, retried without a restart
  let dbUp = false;
  up = false;
  const flaky: AlertStore = {
    ...store,
    openAlertEpisode: async (...args) => { if (!dbUp) throw new Error("db down"); return store.openAlertEpisode(...args); },
  };
  const d = new AlertOutbox(flaky, send, () => {});
  const before = rows.length;
  assert.equal(await d.open("fault_called", "2", "pump2", "⚠ lost?", "E21"), false);
  assert.equal(d.pending(), 1, "neither recorded nor delivered → kept");
  assert.equal(await d.retry(), 0);
  assert.equal(d.pending(), 1, "still both down → still kept");
  dbUp = true;                                   // the DB returns first: the episode becomes an outbox row…
  assert.equal(await d.retry(), 0, "…channels still down: nothing sent yet");
  assert.equal(d.pending(), 0);
  assert.equal(rows.length, before + 1);
  up = true;
  assert.equal(await d.retry(), 1, "…and it goes out when they return");
  assert.equal(rows.at(-1)?.notified, true);
  // the channels return first instead: sent directly from memory, never lost
  dbUp = false; up = false;
  const e = new AlertOutbox(flaky, send, () => {});
  await e.open("stage_unserved", "1", "pump1", "⚠ lost too?", "b");
  up = true;
  assert.equal(await e.retry(), 1, "delivered without a row");
  assert.equal(e.pending(), 0);

  console.log("alerts.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
