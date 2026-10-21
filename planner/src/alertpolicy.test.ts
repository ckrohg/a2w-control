/**
 * @purpose Assertions for the owner alert policy (alertpolicy.ts): tier → channels, all-clears only for pages, DB
 * latches that survive a restart and re-send at most daily, and fail-open on a DB error.
 * Run with: npx tsx planner/src/alertpolicy.test.ts
 */
import assert from "node:assert/strict";
import { route, tierSubject, Latches, PageBudget, episodeTier, piUnreachablePageAfterS, RENOTIFY_MS, type LatchStore, type Tier } from "./alertpolicy";

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
  assert.equal(await latches.claim("freeze", "page", now), true, "first open sends");
  latches = new Latches(store, quiet); // a redeploy: in-memory edges lost, the DB row is not
  assert.equal(await latches.claim("freeze", "page", now + 60_000), false, "the restart's re-fire is suppressed");
  assert.equal(await latches.claim("freeze", "page", now + RENOTIFY_MS + 1), true, "still true a day later: one reminder");
  assert.equal(await latches.release("freeze", "page"), "page", "release reports the tier it was sent at");
  assert.equal(await latches.release("freeze", "page"), null, "nothing open: no all-clear due");

  down = true;
  assert.equal(await latches.claim("x", "attention", now), true, "DB down fails open");
  assert.equal(await latches.release("x", "page" as Tier), "page", "DB down: all-clear still sent at the caller's tier");
  down = false;

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
