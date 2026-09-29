/**
 * @purpose identify.ts: prove the identification_windows schema init against a LOCAL Postgres — the
 * legacy backfill must queue exactly the newest already-written probe for cleanup and mark every
 * older one terminal, and a SECOND init must change nothing (codex pass 5: a re-run that re-queued the
 * next-oldest row could replay a stale probe over current intent). Never touches production.
 *
 * Run from planner/:  LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/identify-local-check.ts
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";

const url = process.env.LOCAL_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("refusing: LOCAL_DATABASE_URL must point at localhost");
  process.exit(2);
}
const store = new Store(url);
const pool = (store as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<any> } }).pool;

async function main() {
  await store.ensureSchema();
  await pool.query(`TRUNCATE identification_windows RESTART IDENTITY`);
  // Three legacy ended live probes predating cleanup tracking (cleanup_state 'none', write_id set), a
  // hold arm, a dry run, and an ended probe that was never written.
  const ins = (arm: string, writeId: number | null, dry: boolean, state = "ended") => pool.query(
    `INSERT INTO identification_windows (state, arm, direction, zone_ids, band_lo, band_hi, magnitude_f, base_f, target_f, cap_f, draw_probability, draw_seed, started_at, ended_at, end_reason, duration_min, write_id, dry_run, cleanup_state, write_accepted)
     VALUES ($1,$2,'up','{z}',30,45,8,135,143,145,0.5,'0.2',now() - interval '3 hours',now() - interval '1 hour','completed',120,$3,$4,'none',false)`,
    [state, arm, writeId, dry]);
  await ins("probe", 11, false);           // id 1 legacy
  await ins("probe", 12, false);           // id 2 legacy
  await ins("hold", null, false);          // id 3 hold — never cleaned
  await ins("probe", 13, true);            // id 4 dry run — never cleaned
  await ins("probe", null, false);         // id 5 never written — never cleaned
  await ins("probe", 14, false);           // id 6 legacy, NEWEST
  await store.ensureSchema();              // the upgrade path
  const rows = async () => (await pool.query(`SELECT id, cleanup_state, write_accepted, cleanup_detail FROM identification_windows ORDER BY id`)).rows;
  let r = await rows();
  assert.deepEqual(r.map((x: any) => [Number(x.id), x.cleanup_state, x.write_accepted]), [
    [1, "done", true], [2, "done", true], [3, "none", false], [4, "none", true], [5, "none", false], [6, "pending", true],
  ], JSON.stringify(r));
  assert.match(r[0].cleanup_detail, /superseded/);
  const pending = await store.cleanupPendingIdentificationWindows();
  assert.deepEqual(pending.map((w) => w.id), [6]);
  // A second and third init change nothing: no stale probe is ever re-queued.
  await store.ensureSchema(); await store.ensureSchema();
  const r2 = await rows();
  assert.deepEqual(r2, r);
  // Once #6 is cleaned, further inits still queue nothing.
  await store.updateIdentificationWindow(6, { cleanupState: "done", cleanupDetail: "re-commanded base 135 °F" });
  await store.ensureSchema();
  assert.deepEqual((await store.cleanupPendingIdentificationWindows()).map((w) => w.id), []);
  assert.equal((await rows())[0].cleanup_state, "done");
  console.log("identify-local-check: all assertions passed");
}
main().then(() => store.close(), (e) => { console.error(e); process.exitCode = 1; return store.close(); });
