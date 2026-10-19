/**
 * @purpose Assertions for the alert outbox (alerts.ts, #185 / #187): an undelivered page is re-sent until a channel
 * acknowledges it — across a restart — and an acknowledged one never again. Run with: npx tsx planner/src/alerts.test.ts
 */
import assert from "node:assert/strict";
import { AlertOutbox, type AlertStore } from "./alerts";

(async () => {
  // an in-memory alert_episodes table, shared across "restarts"
  const rows: { id: number; uid: string; kind: string; key: string; title: string; detail: string; notified: boolean; cleared: boolean }[] = [];
  let closeUp = true;
  const store: AlertStore = {
    closeAlertEpisodeIds: async (ids) => { if (!closeUp) throw new Error("db down"); for (const r of rows) if (ids.includes(r.id)) r.cleared = true; },
    openAlertEpisode: async (uid, kind, key, _p, title, detail) => {
      const hit = rows.find((r) => r.uid === uid);
      if (hit) return hit.id; // idempotent on uid, like the SQL
      rows.push({ id: rows.length + 1, uid, kind, key, title, detail, notified: false, cleared: false }); return rows.length;
    },
    closeAlertEpisodeUids: async (uids) => { if (!closeUp) throw new Error("db down"); for (const r of rows) if (uids.includes(r.uid)) r.cleared = true; },
    markAlertNotified: async (id) => { rows[id - 1].notified = true; },
    undeliveredAlertEpisodes: async () => rows.filter((r) => !r.cleared && !r.notified).map((r) => ({ id: r.id, uid: r.uid, kind: r.kind, title: r.title, detail: r.detail })),
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
  assert.equal(e.pending(), 1, "…but kept until it is durable (codex pass 4)");
  dbUp = true;
  assert.equal(await e.retry(), 0, "persisted as already notified — not sent again");
  assert.equal(e.pending(), 0);
  assert.equal(rows.at(-1)?.title, "⚠ lost too?");
  assert.equal(rows.at(-1)?.notified, true);

  // codex pass 3: (a) a queued alert whose condition cleared is cancelled — it never reopens a resolved incident
  dbUp = false; up = false;
  const g = new AlertOutbox(flaky, send, () => {});
  await g.open("fault_called", "2", "pump2", "⚠ obsolete", "E21");
  assert.equal(g.pending(), 1);
  await g.close("fault_called", "2");
  assert.equal(g.pending(), 0, "cancelled on recovery");
  dbUp = true; up = true;
  const n0 = rows.length;
  await g.retry();
  assert.equal(rows.length, n0, "nothing inserted later for a resolved incident");
  // (b) a FAILED close is retried until the DB takes it — so a restart cannot re-adopt a resolved episode as open
  const h = new AlertOutbox(store, send, () => {});
  await h.open("stage_unserved", "2", "pump2", "⚠ HP2 not heating", "b");
  closeUp = false;
  await h.close("stage_unserved", "2");
  assert.equal(h.pendingCloses(), 1);
  assert.equal(rows.at(-1)?.cleared, false, "the close did not land yet");
  await h.retry();
  assert.equal(h.pendingCloses(), 1, "still down");
  closeUp = true;
  await h.retry();
  assert.equal(h.pendingCloses(), 0);
  assert.equal(rows.at(-1)?.cleared, true, "closed once the DB is back");

  // codex pass 4: (1) a RECURRENCE before a pending close succeeds is never closed by it
  closeUp = true; up = true;
  const r1 = new AlertOutbox(store, send, () => {});
  await r1.open("fault_called", "2", "pump2", "⚠ first", "E21");
  const firstId = rows.length;
  closeUp = false;
  await r1.close("fault_called", "2");                      // HP2 recovered; the close is refused
  up = false;
  await r1.open("fault_called", "2", "pump2", "⚠ again", "E21"); // …HP2 faults again; this page is NOT heard
  const secondId = rows.length;
  closeUp = true; up = true;
  const sentBefore = sent.length;
  await r1.retry();
  assert.equal(rows[firstId - 1].cleared, true, "the first episode is closed by ID");
  assert.equal(rows[secondId - 1].cleared, false, "the recurrence stays open…");
  assert.equal(rows[secondId - 1].notified, true, "…and its page is re-sent and acknowledged");
  assert.equal(sent.at(-1), "⚠ again");
  assert.ok(sent.length > sentBefore);
  // (2) a resolved, unheard episode whose close is still pending is never paged
  up = false;
  const r2 = new AlertOutbox(store, send, () => {});
  await r2.open("stage_unserved", "1", "pump1", "⚠ obsolete-if-resolved", "b");
  closeUp = false;
  await r2.close("stage_unserved", "1");
  up = true;
  const n1 = sent.length;
  await r2.retry();
  assert.ok(!sent.slice(n1).includes("⚠ obsolete-if-resolved"), "pending close → not re-sent after recovery");
  closeUp = true;
  await r2.retry();
  assert.equal(r2.pendingCloses(), 0);
  // (3) row could not be written but the page WAS heard: persisted later and marked notified — no resend
  dbUp = false; up = true;
  const r3 = new AlertOutbox(flaky, send, () => {});
  const n2 = sent.length;
  assert.equal(await r3.open("span_local_stale", "span", null, "⚠ heard once", "x"), true);
  assert.equal(r3.pending(), 1, "kept until durable");
  dbUp = true;
  await r3.retry();
  assert.equal(r3.pending(), 0);
  const row = rows.find((x) => x.title === "⚠ heard once");
  assert.ok(row && row.notified, "recorded as already notified — a restart re-adopts it instead of re-paging");
  assert.equal(sent.slice(n2).filter((t) => t === "⚠ heard once").length, 1, "sent exactly once");
  // adopt(): a restart re-adopts open rows so a recovery closes them by ID
  const r4 = new AlertOutbox(store, send, () => {});
  r4.adopt([{ id: row!.id, kind: "span_local_stale", key: "span" }]);
  await r4.close("span_local_stale", "span");
  assert.equal(row!.cleared, true);

  // codex pass 5: (1) heard, but the notified mark FAILED → the mark is retried, the page is never re-sent, and the
  // failure does not stop other episodes from being processed
  let markUp = false;
  const marky: AlertStore = { ...store, markAlertNotified: async (id) => { if (!markUp) throw new Error("db blip"); return store.markAlertNotified(id); } };
  up = true;
  const m = new AlertOutbox(marky, send, () => {});
  const n3 = sent.length;
  await m.open("fault_called", "1", "pump1", "⚠ heard, mark failed", "x");
  const heardId = rows.length;
  up = false;
  await m.open("stage_unserved", "2", "pump2", "⚠ unheard neighbour", "y");
  up = true;
  for (let i = 0; i < 3; i++) await m.retry();
  assert.equal(sent.slice(n3).filter((t) => t === "⚠ heard, mark failed").length, 1, "heard once, never re-sent while its mark is failing");
  assert.ok(sent.slice(n3).includes("⚠ unheard neighbour"), "the failing mark does not block the other episode");
  markUp = true;
  await m.retry();
  assert.equal(rows[heardId - 1].notified, true, "the mark lands once the DB takes it");
  // (2) a kind held back by canResend (its watch has not re-evaluated since a restore) is not re-sent from the DB
  up = false;
  await m.open("stage_unserved", "9", "pump1", "⚠ maybe obsolete", "z");
  up = true;
  const n4 = sent.length;
  await m.retry((kind) => kind !== "stage_unserved");
  assert.ok(!sent.slice(n4).includes("⚠ maybe obsolete"), "held back");
  await m.retry(() => true);
  assert.ok(sent.slice(n4).includes("⚠ maybe obsolete"), "sent once its watch has re-evaluated");

  // codex pass 8: the INSERT committed but its reply was lost → treated as unrecorded; the recovery must still close
  // that committed row (by uid), and nothing is paged after the recovery
  up = false; closeUp = true;
  let lostReply = true;
  const ghost: AlertStore = { ...store, openAlertEpisode: async (...args) => { const id = await store.openAlertEpisode(...args); if (lostReply) throw new Error("connection reset"); return id; } };
  const gx = new AlertOutbox(ghost, send, () => {});
  await gx.open("fault_called", "7", "pump2", "⚠ ghost", "E21");
  const ghostRow = rows.at(-1)!;
  assert.equal(ghostRow.title, "⚠ ghost", "the row WAS committed");
  assert.equal(gx.pending(), 1, "…but the outbox could not know");
  await gx.close("fault_called", "7");                         // HP2 recovers
  assert.equal(ghostRow.cleared, true, "closed by uid");
  lostReply = false; up = true;
  const n5 = sent.length;
  await gx.retry();
  assert.ok(!sent.slice(n5).includes("⚠ ghost"), "the resolved incident is never paged");
  // and a retried insert of the same uid returns the same row (no duplicate)
  const before2 = rows.length;
  await gx.open("stage_unserved", "8", "pump1", "⚠ one row", "b");
  assert.equal(rows.length, before2 + 1);

  // codex pass 9: (a) a lost-reply insert cancelled on recovery whose uid-close FAILS → never paged meanwhile
  up = false;
  lostReply = true;
  const gy = new AlertOutbox(ghost, send, () => {});
  await gy.open("fault_called", "11", "pump2", "⚠ ghost 2", "E21");
  closeUp = false;
  await gy.close("fault_called", "11");                          // recovery; the close by uid fails
  lostReply = false; up = true;
  const n6 = sent.length;
  await gy.retry();
  assert.ok(!sent.slice(n6).includes("⚠ ghost 2"), "a resolved ghost is never paged while its uid-close is pending");
  closeUp = true;
  await gy.retry();
  assert.equal(rows.find((r) => r.title === "⚠ ghost 2")?.cleared, true, "…and is closed once the DB takes it");
  // (b) a lost-reply insert that WAS heard → persisted later and never sent a second time from the DB
  lostReply = true;
  const gz = new AlertOutbox(ghost, send, () => {});
  const n7 = sent.length;
  await gz.open("span_local_stale", "span2", null, "⚠ heard ghost", "x");
  lostReply = false;
  await gz.retry();
  await gz.retry();
  assert.equal(sent.slice(n7).filter((t) => t === "⚠ heard ghost").length, 1, "heard once, sent once");
  assert.equal(rows.find((r) => r.title === "⚠ heard ghost")?.notified, true);

  // codex pass 10: a STALLED insert (never settles) must not hold the page — it goes out after the bound, and the
  // episode stays retryable by uid (a late commit is harmless)
  const stalled: AlertStore = { ...store, openAlertEpisode: () => new Promise<number>(() => { /* never */ }) };
  up = true;
  const sx = new AlertOutbox(stalled, send, () => {}, 50);
  const n8 = sent.length;
  const t0 = Date.now();
  assert.equal(await sx.open("fault_called", "12", "pump2", "⚠ stalled DB", "E21"), true, "paged despite the stalled insert");
  assert.ok(Date.now() - t0 < 2_000, "within the bound");
  assert.equal(sent[n8], "⚠ stalled DB");
  assert.equal(sx.pending(), 1, "kept for persistence by uid");
  // a stalled undelivered fetch does not hang retry()
  const stalled2: AlertStore = { ...store, undeliveredAlertEpisodes: () => new Promise(() => { /* never */ }) };
  const sy = new AlertOutbox(stalled2, send, () => {}, 50);
  const t1 = Date.now();
  await sy.retry();
  assert.ok(Date.now() - t1 < 2_000);

  console.log("alerts.test.ts: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
