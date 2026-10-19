/**
 * @purpose a2w#177: exercise the self-diagnosing curve alert against a LOCAL Postgres with the REAL Store — the
 * migration, every new column, the device lock's bounded pool, and the restart path the unit suite can only fake:
 * an unconfirmed observation persisted by one planner process is reloaded by the next (store.pendingUnconfirmed),
 * announced when the change is gone, and settled (store.resolveUnconfirmed) so a third process stays quiet. Never
 * touches production (the analyze-local.sh rule): it needs LOCAL_DATABASE_URL and refuses anything not localhost.
 *
 * Run from planner/:  LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/drift-local-check.ts
 * (createdb a2w_local first if needed; the check TRUNCATEs hbx_config_versions and hbx_writes.) Exits non-zero on failure.
 */
import assert from "node:assert/strict";
import { Store } from "../planner/src/store";
import { withDeviceLock } from "../planner/src/writes";
import { extractConfig, handlePolledConfig, pendingUnconfirmedNotice, UNCONFIRMED_TITLE, type DriftDeps } from "../planner/src/drift";

const url = process.env.LOCAL_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  console.error("refusing: LOCAL_DATABASE_URL must point at localhost (this check is for a local database only)");
  process.exit(2);
}

const device = (dbt: number, mbt: number) => ({ syncCode: "S", dot: 26, wwsd: 125, dbt, mbt, htDif: 4, changeSource: "server", updatedAt: new Date().toISOString() });

function deps(store: Store, reread: () => Promise<Record<string, any>>, pages: string[]): DriftDeps {
  return {
    reread, wait: async () => true, lock: withDeviceLock,
    latest: () => store.latestConfigVersion(),
    plannerWrites: (sinceMs) => store.plannerWrites(new Date(sinceMs)),
    record: (r) => store.insertConfigVersion(r.config, r.changes, r),
    notify: async (title) => { pages.push(title); },
    log: () => {},
  };
}

async function main() {
  // ── process A: seed, then a planner write, then a curve change whose confirmation read fails ──────────────────
  const a = new Store(url);
  await a.ensureSchema();
  await a.ensureSchema(); // idempotent on a migrated DB
  const pool = (a as unknown as { pool: { query: (q: string, p?: unknown[]) => Promise<any> } }).pool;
  await pool.query(`TRUNCATE hbx_config_versions, hbx_writes RESTART IDENTITY`);
  const pages: string[] = [];
  await handlePolledConfig(await a.latestConfigVersion(), device(120, 118), deps(a, async () => device(120, 118), pages));
  await a.insertConfigVersion(extractConfig(device(142, 138)), { dbt: { old: 120, new: 142 }, mbt: { old: 118, new: 138 }, _source: "autopilot:set_target" } as any, { raw: device(142, 138) });
  await a.insertHbxWrite({ source: "autopilot", action: "set_target", requested: { dbt: 142, mbt: 138 }, result: "accepted", detail: "t", response: { dbt: 142, mbt: 138 } });
  const failed = await handlePolledConfig(await a.latestConfigVersion(), device(100, 96), deps(a, async () => { throw new Error("HTTP 503"); }, pages));
  assert.equal(failed.diagnosis?.verdict, "unconfirmed");
  assert.equal(pages.length, 0, "unconfirmed pages nobody");
  const rows = (await pool.query(`SELECT changed_fields, config, raw, reread_raw, verdict, diagnosis FROM hbx_config_versions ORDER BY id`)).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].raw.dbt, 120, "the seed row stores the raw device object");
  assert.equal(rows[2].verdict, "unconfirmed");
  assert.equal(rows[2].changed_fields, null);
  assert.equal(rows[2].config.dbt, 142, "the evidence row's config is the current baseline");
  assert.equal(rows[2].raw.dbt, 100, "the first read is kept whole");
  assert.equal((await a.latestConfig())?.dbt, 142, "the baseline did not move");
  const w = await a.plannerWrites(new Date(Date.now() - 3_600_000));
  assert.deepEqual(w.last?.echo, { dbt: 142, mbt: 138 }, "hbx_writes.response round-trips");
  await a.close(); // ← the restart

  // ── process B: reloads the pending observation; the change is gone → the notice; settled ──────────────────────
  const b = new Store(url);
  await b.ensureSchema();
  const pending = await b.pendingUnconfirmed();
  assert.equal(pending?.verdict, "unconfirmed", "a restart reloads the unsettled observation");
  const out = await handlePolledConfig(await b.latestConfigVersion(), device(142, 138), deps(b, async () => device(142, 138), pages));
  assert.equal(out.kind, "unchanged");
  const carry = pendingUnconfirmedNotice(pending, out);
  assert.equal(carry.notice?.title, UNCONFIRMED_TITLE);
  assert.equal(carry.resolved, true);
  await b.resolveUnconfirmed();
  assert.equal(await b.pendingUnconfirmed(), null, "settled");
  await b.close();

  // ── process C: nothing to repeat; then unconfirmed → confirmed page that reached NOBODY → restart ──────────────
  const c = new Store(url);
  assert.equal(await c.pendingUnconfirmed(), null, "a later restart does not re-announce it");
  const again = await handlePolledConfig(await c.latestConfigVersion(), device(90, 86), deps(c, async () => { throw new Error("HTTP 503"); }, pages));
  assert.equal(again.diagnosis?.verdict, "unconfirmed");
  const dead = deps(c, async () => device(90, 86), pages);
  dead.notify = async () => false;                                     // every channel down
  const conf = await handlePolledConfig(await c.latestConfigVersion(), device(90, 86), dead);
  assert.equal(conf.diagnosis?.verdict, "foreign");
  assert.equal(conf.delivered, false);
  assert.equal((await c.latestCurveDiagnosis())?.verdict, "foreign", "the confirmed row is recorded and is the newest diagnosis");
  const kept = pendingUnconfirmedNotice(again.diagnosis, conf);
  assert.equal(kept.resolved, false, "an undelivered confirmed page settles nothing");
  await c.close(); // ← restart before anyone heard
  const d = new Store(url);
  const back = await d.pendingUnconfirmed();
  assert.equal(back?.verdict, "unconfirmed", "the restart still reloads it — a later confirmed row does not hide it (codex pass 11)");
  const quiet = await handlePolledConfig(await d.latestConfigVersion(), device(90, 86), deps(d, async () => device(90, 86), pages));
  assert.equal(quiet.kind, "unchanged");
  assert.equal(pendingUnconfirmedNotice(back, quiet).notice?.title, UNCONFIRMED_TITLE, "…and announces it");
  await d.resolveUnconfirmed();
  assert.equal(await d.pendingUnconfirmed(), null);
  assert.deepEqual(pages, [], "the only page in this run was the undelivered one (counted by `dead`, not `pages`)");
  await d.close();
  console.log("drift-local-check: all assertions passed");
}

main().catch((e) => { console.error(e); process.exit(1); });
