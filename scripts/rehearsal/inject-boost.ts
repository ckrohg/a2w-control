/**
 * @purpose #232 rehearsal step: start a dashboard boost through the REAL guarded writer (HbxWriter.boost — the same
 * I4 / I1 / rate-limit / audit / self-recorded-config path POST /api/hbx/boost takes) against the fake upstreams and
 * the local rehearsal DB, then rewind its timer so the planner's next poll finds the row due. What the planner then
 * restores — the plan's curve, or the July as-found one — is the scenario's whole point. Localhost and the fake only;
 * run by run.sh between polls 2 and 3 when the scenario carries a `boost` block.
 */
import fs from "node:fs";
import { Store } from "../../planner/src/store";
import { SensorLinxClient } from "../../planner/src/sensorlinx";
import { HubClient } from "../../planner/src/hub";
import { HbxWriter } from "../../planner/src/writes";

const url = process.env.DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]*@?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) { console.error("refusing: DATABASE_URL must point at localhost"); process.exit(2); }
for (const k of ["SLX_BASE_URL", "HUB_URL"]) {
  if (!/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(process.env[k] ?? "")) { console.error(`refusing: ${k} must be the rehearsal fake (got ${process.env[k] ?? "unset"})`); process.exit(2); }
}
const scenario = JSON.parse(fs.readFileSync(process.env.REHEARSAL_SCENARIO!, "utf8"));
const boost = scenario.boost as { targetF: number; minutes: number } | undefined;
if (!boost) { console.error("the scenario has no `boost` block"); process.exit(2); }

const store = new Store(url);
const slx = new SensorLinxClient(process.env.SENSORLINX_EMAIL ?? "rehearsal", process.env.SENSORLINX_PASSWORD ?? "rehearsal");
const hub = new HubClient(process.env.HUB_URL!, process.env.HUB_CLIENT_TOKEN ?? "t");
const writer = new HbxWriter(slx, store, hub, process.env.SLX_BUILDING_ID ?? "fake-building", process.env.SLX_SYNC_CODE ?? "FAKE-0001",
  async (title, body) => { console.log(`[ntfy] (no topic) ${title}: ${body}`); });

async function main() {
  const r = await writer.boost(boost!.targetF, boost!.minutes, "dashboard");
  console.log(`boost ${boost!.targetF}°F for ${boost!.minutes} min accepted: ${r.detail} (restore_at ${r.boost_restore_at})`);
  // The real wait is `minutes`; rewound so the planner's next poll finds the row due (store.dueBoosts) and the
  // scenario can prove what the expiry writes without waiting the timer out.
  const pool = (store as unknown as { pool: { query: (q: string) => Promise<{ rowCount: number | null }> } }).pool;
  const u = await pool.query(`UPDATE hbx_boosts SET restore_at = now() - interval '1 minute' WHERE NOT restored`);
  console.log(`rewound ${u.rowCount} boost row(s): due on the next poll`);
  await store.close();
}
main().catch((e) => { console.error("inject-boost failed:", e); process.exit(1); });
