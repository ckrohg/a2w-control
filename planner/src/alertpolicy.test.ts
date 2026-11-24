/**
 * @purpose Assertions for the owner alert policy (alertpolicy.ts): tier → channels, all-clears only for pages, DB
 * latches that survive a restart and re-send at most daily, and fail-open on a DB error.
 * Run with: npx tsx planner/src/alertpolicy.test.ts
 */
import assert from "node:assert/strict";
import { route, tierSubject, acknowledged, Latches, PageBudget, episodeTier, piUnreachablePageAfterS, RENOTIFY_MS, type LatchStore, type Tier } from "./alertpolicy";

(async () => {
  // tier → channels
  assert.deepEqual(route("page"), { push: true, email: true });
  assert.deepEqual(route("attention"), { push: false, email: true });
  assert.deepEqual(route("record"), { push: false, email: false });
  // all-clears: only a page gets one
  assert.deepEqual(route("page", true), { push: true, email: true });
  assert.deepEqual(route("attention", true), { push: false, email: false });
  assert.deepEqual(route("record", true), { push: false, email: false });

  assert.equal(tierSubject("Freeze risk: tank 98°F", "page"), "🚨 A2W — Freeze risk: tank 98°F");
  assert.equal(tierSubject("A2W: Pi running hot", "attention"), "A2W needs a look — Pi running hot");
  assert.equal(tierSubject("⚠️ Freeze-risk cleared", "page", true), "✅ A2W RESOLVED — Freeze-risk cleared");

  // latches, over an in-memory notify_latches table shared across "restarts"
  const rows = new Map<string, { tier: string; notifiedAt: Date }>();
  let down = false;
  let now = Date.parse("2026-10-20T12:00:00Z");
  const store: LatchStore = {
    getNotifyLatch: async (k) => { if (down) throw new Error("db down"); return rows.get(k) ?? null; },
    upsertNotifyLatch: async (k, tier) => { if (down) throw new Error("db down"); rows.set(k, { tier, notifiedAt: new Date(now) }); },
    deleteNotifyLatch: async (k) => { if (down) throw new Error("db down"); const r = rows.get(k); rows.delete(k); return r ? { tier: r.tier } : null; },
  };
  const quiet = () => {};
  let latches = new Latches(store, quiet);
  assert.equal(await latches.due("freeze", now), true, "first open sends");
  assert.equal(rows.has("freeze"), false, "asking writes nothing: only a page someone heard is latched");
  assert.equal(await latches.due("freeze", now + 60_000), true, "not heard, so the next try still sends");
  assert.equal(await latches.release("freeze", "page"), null, "and a page nobody heard is owed no all-clear");
  await latches.record("freeze", "page");
  latches = new Latches(store, quiet); // a redeploy: in-memory edges lost, the DB row is not
  assert.equal(await latches.due("freeze", now + 60_000), false, "the restart's re-fire is suppressed");
  assert.equal(await latches.due("freeze", now + RENOTIFY_MS + 1), true, "still true a day later: one reminder");
  // that reminder fails on every channel: the first page was still heard, so its latch and its all-clear stand
  assert.equal(await latches.release("freeze", "page"), "page", "release reports the tier it was sent at");
  assert.equal(await latches.release("freeze", "page"), null, "nothing open: no all-clear due");

  down = true;
  assert.equal(await latches.due("x", now), true, "DB down fails open");
  await latches.record("x", "page"); // logged, not thrown: the page has already been heard
  assert.equal(await latches.release("x", "page" as Tier), "page", "DB down: all-clear still sent at the caller's tier");
  down = false;

  // #324 review: an all-clear whose latch DELETE fails must not leave a row that swallows the next incident's page
  {
    const rows2 = new Map<string, { tier: string; notifiedAt: Date }>();
    let deleteFails = false;
    const store2: LatchStore = {
      getNotifyLatch: async (k) => rows2.get(k) ?? null,
      upsertNotifyLatch: async (k, tier) => { rows2.set(k, { tier, notifiedAt: new Date(now) }); },
      deleteNotifyLatch: async (k) => { if (deleteFails) throw new Error("db down"); const r = rows2.get(k); rows2.delete(k); return r ? { tier: r.tier } : null; },
    };
    let l = new Latches(store2, quiet);
    await l.record("freeze-risk", "page");
    deleteFails = true;
    assert.equal(await l.release("freeze-risk", "page"), "page", "the all-clear still goes when the delete fails");
    assert.ok(rows2.has("freeze-risk"), "the row was left behind");
    assert.deepEqual(l.pendingReleases(), ["freeze-risk"]);
    // a new freeze 2 h later, DB still failing deletes: the stale row (< 24 h) must not dedupe it
    assert.equal(await l.due("freeze-risk", now + 2 * 3_600_000), true, "a new incident after a failed release is due");
    deleteFails = false;
    assert.equal(await l.due("freeze-risk", now + 2 * 3_600_000), true, "retried on the next due() and still due");
    assert.equal(rows2.has("freeze-risk"), false, "the retry deleted the stale row");
    assert.deepEqual(l.pendingReleases(), []);
    assert.equal(await l.due("freeze-risk", now + 2 * 3_600_000), true, "no row: due as usual");

    // the per-poll sweep deletes it before any new incident (and before a restart can adopt it)
    await l.record("freeze-risk", "page");
    deleteFails = true;
    await l.release("freeze-risk", "page");
    await l.retryReleases();
    assert.ok(rows2.has("freeze-risk"), "a sweep while the DB still fails keeps it pending");
    deleteFails = false;
    await l.retryReleases();
    assert.equal(rows2.has("freeze-risk"), false, "the sweep deleted it once the DB answered");
    l = new Latches(store2, quiet); // a restart now finds no stale row to adopt
    assert.equal(await l.due("freeze-risk", now + 3_600_000), true);

    // a new heard page clears the pending mark: its row is a real latch again and dedupes as usual
    await l.record("freeze-risk", "page");
    deleteFails = true;
    await l.release("freeze-risk", "page");
    deleteFails = false;
    await l.record("freeze-risk", "page");
    assert.deepEqual(l.pendingReleases(), [], "record() supersedes the stale mark");
    assert.equal(await l.due("freeze-risk", now + 60_000), false, "and the new latch dedupes a re-fire");
  }

  // who heard it: a ntfy 200 proves nothing while nobody subscribes to the topic
  assert.equal(acknowledged({ ownerConfigured: true, ownerAcked: false, ntfyConfigured: true, ntfyAcked: true }), false, "ntfy alone is nobody");
  assert.equal(acknowledged({ ownerConfigured: true, ownerAcked: true, ntfyConfigured: true, ntfyAcked: false }), true);
  assert.equal(acknowledged({ ownerConfigured: false, ownerAcked: false, ntfyConfigured: true, ntfyAcked: true }), true, "no owner channel: ntfy is all there is");
  assert.equal(acknowledged({ ownerConfigured: false, ownerAcked: false, ntfyConfigured: true, ntfyAcked: false }), false);
  assert.equal(acknowledged({ ownerConfigured: false, ownerAcked: false, ntfyConfigured: false, ntfyAcked: false }), true, "rehearsal: the log line is the delivery");

  // page budget
  const b = new PageBudget();
  const t0 = Date.parse("2026-10-01T00:00:00Z");
  for (let i = 0; i < 3; i++) b.note(t0 + i * 3_600_000);
  assert.equal(b.over(t0 + 4 * 3_600_000), false);
  b.note(t0 + 5 * 3_600_000);
  assert.equal(b.over(t0 + 5 * 3_600_000), true, "a 4th page in a week trips the budget");
  assert.equal(b.over(t0 + 8 * 86_400_000), false, "and it rolls off after 7 days");

  // episode kinds
  assert.equal(episodeTier("stage_unserved"), "record");
  assert.equal(episodeTier("fault_called"), "record");
  assert.equal(episodeTier("span_local_stale"), "record");
  assert.equal(episodeTier("pump_running_no_lift"), "attention");
  assert.equal(episodeTier("backup_gate"), "attention");

  // Pi unreachable thresholds
  assert.equal(piUnreachablePageAfterS(20), 7200);
  assert.equal(piUnreachablePageAfterS(45), 43200);
  assert.equal(piUnreachablePageAfterS(null), 43200);

  console.log("alertpolicy: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
