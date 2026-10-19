/**
 * @purpose Assertions for the SPAN-local heartbeat (#187, spanlocal.ts): a stale local table pages HIGH within 15 min,
 * once, and resolves once; the cloud failing alone shows but never pages; an absent or empty table never pages.
 * Run with: npx tsx planner/src/spanlocal.test.ts
 */
import assert from "node:assert/strict";
import { spanHealth, SpanLocalAlarm, SPAN_LOCAL_STALE_S, type SpanCloudState } from "./spanlocal";

const NOW = Date.parse("2026-10-16T04:45:00Z") / 1000;
const okCloud: SpanCloudState = { enabled: true, last_ok_at: "2026-10-16T04:40:00.000Z", fail_streak: 0, last_error: null };
const badCloud: SpanCloudState = { enabled: true, last_ok_at: "2026-10-15T23:40:00.000Z", fail_streak: 61, last_error: "fetch failed" };

// ── 1. /health.span shape ───────────────────────────────────────────────────────────────────────────────────────
{
  const h = spanHealth({ "Buffer Tank": NOW - 25, "Air-Water 1": NOW - 40, "Air-Water 2": NOW - 3_600 }, NOW, okCloud);
  assert.equal(h.local_table, true);
  assert.equal(h.local_last_reading_age_s, 25, "the newest circuit's age");
  assert.deepEqual(h.circuits_seen.map((c) => [c.name, c.age_s]), [["Air-Water 1", 40], ["Air-Water 2", 3_600], ["Buffer Tank", 25]]);
  assert.equal(h.local_stale, false, "one silent circuit is not a dead stream");
  assert.deepEqual(h.cloud, okCloud);
}
// ── 2. the cloud failing ALONE: on /health, never a page (the Oct 15 23:43Z case with the local path alive) ──────
{
  const a = new SpanLocalAlarm();
  const h = spanHealth({ "Buffer Tank": NOW - 25 }, NOW, badCloud);
  assert.equal(h.cloud.fail_streak, 61);
  assert.equal(a.step(h), null);
}
// ── 3. stale local stream → one HIGH page (within 15 min), then quiet, then one recovery ─────────────────────────
{
  const a = new SpanLocalAlarm();
  assert.equal(a.step(spanHealth({ "Buffer Tank": NOW - SPAN_LOCAL_STALE_S }, NOW, okCloud)), null, "exactly 15 min is not yet stale");
  const p = a.step(spanHealth({ "Buffer Tank": NOW - SPAN_LOCAL_STALE_S - 60 }, NOW, badCloud));
  assert.equal(p?.priority, "high");
  assert.equal(p?.title, "⚠ SPAN local stream stale");
  assert.match(p?.body ?? "", /16 min old/);
  assert.match(p?.body ?? "", /cloud path is failing too \(61 in a row: fetch failed\)/);
  assert.equal(a.step(spanHealth({ "Buffer Tank": NOW - 3_600 }, NOW, badCloud)), null, "edge-triggered: no repeat");
  const r = a.step(spanHealth({ "Buffer Tank": NOW - 20 }, NOW, okCloud));
  assert.equal(r?.resolved, true);
  assert.equal(r?.priority, "default");
  assert.equal(a.step(spanHealth({ "Buffer Tank": NOW - 20 }, NOW, okCloud)), null);
}
// ── 4. absent / empty table → never a page (the rehearsal DB; a mirror that never wrote SPAN) ──────────────────────
{
  const a = new SpanLocalAlarm();
  const absent = spanHealth(null, NOW, okCloud);
  assert.deepEqual([absent.local_table, absent.local_last_reading_age_s, absent.local_stale], [false, null, null]);
  assert.equal(a.step(absent), null);
  const empty = spanHealth({}, NOW, { enabled: false, last_ok_at: null, fail_streak: 0, last_error: null });
  assert.equal(empty.local_stale, null);
  assert.equal(a.step(empty), null);
  // a Pi clock ahead of ours never yields a negative age
  assert.equal(spanHealth({ x: NOW + 30 }, NOW, okCloud).local_last_reading_age_s, 0);
}
console.log("spanlocal.test.ts: all assertions passed");
