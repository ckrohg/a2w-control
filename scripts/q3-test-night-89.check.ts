/**
 * @purpose Static check for scripts/q3-test-night-89.sh (the #89 Q3 cold-night query pack): every table and
 * column the pack reads must exist in the CREATE TABLE / ALTER TABLE text in this repo (planner/src/store.ts,
 * analytics-mirror/lib/db.ts), every jsonb key it reads from zone_floor_snapshots.zones[] must be a ZoneFloor
 * field (planner/src/demand.ts), every hbx config key must be one store.ts itself reads, the SPAN circuit
 * names must match planner/src/index.ts, the heredocs must balance and contain no write statement, and every
 * psql variable must be set with -v. Needs no database and executes nothing. Exit 1 on any failure.
 *
 * Run from the repo root:  node --import ./hub/node_modules/tsx/dist/loader.mjs scripts/q3-test-night-89.check.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const script = read("scripts/q3-test-night-89.sh");
const store = read("planner/src/store.ts");
const mirror = read("analytics-mirror/lib/db.ts");
const demand = read("planner/src/demand.ts");
const index = read("planner/src/index.ts");

let fail = 0;
const bad = (msg: string) => { fail++; console.log("FAIL", msg); };

// ── schema as the repo declares it ──
const schema = new Map<string, Set<string>>();
for (const src of [store, mirror]) {
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const cols = schema.get(m[1]) ?? new Set<string>();
    for (const line of m[2].split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("--") || /^(PRIMARY KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(t)) continue;
      cols.add(t.split(/\s+/)[0].replace(/,$/, ""));
    }
    schema.set(m[1], cols);
  }
  const alt = /ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+)/g;
  while ((m = alt.exec(src))) schema.get(m[1])?.add(m[2]);
}

// ── what the pack reads (table → columns). The text check below keeps this list honest. ──
const uses: Record<string, string[]> = {
  slx_readings: ["ts", "outdoor_f", "tank_f", "tank_target_f", "backup_called", "stages_called"],
  hbx_config_versions: ["id", "observed_at", "config"],
  zone_call_samples: ["ts", "calling_zone_ids"],
  zone_floor_snapshots: ["ts", "zones"],
  tempiq_zone_physics: ["zone_id", "name", "emitter_type", "ua_btu_hr_f", "confidence", "source", "fetched_at"],
  span_readings: ["ts", "name", "power_w"],
};
for (const [table, cols] of Object.entries(uses)) {
  const have = schema.get(table);
  if (!have) { bad(`table ${table} not found in any CREATE TABLE`); continue; }
  if (!script.includes(table)) bad(`script never names ${table} (this list is stale)`);
  for (const c of cols) {
    if (!have.has(c)) bad(`${table}.${c} not in schema (has: ${[...have].join(", ")})`);
    if (!new RegExp(`\\b${c}\\b`).test(script)) bad(`script never uses column ${c} (this list is stale)`);
  }
}
// every real table named after FROM/JOIN must be in the list above (CTEs and set-returning functions excluded)
const ctes = new Set([...script.matchAll(/^(\w+) AS \($/gm)].map((x) => x[1]));
const notTables = new Set(["unnest", "generate_series", "jsonb_array_elements", "LATERAL", "w", "d", "params", ...ctes]);
for (const m of script.matchAll(/(?<!epoch )\b(?:FROM|JOIN)\s+(\w+)/g)) {   // extract(epoch FROM x) is not a table
  if (!notTables.has(m[1]) && !uses[m[1]]) bad(`FROM/JOIN ${m[1]} is not a table this check knows`);
}

// ── jsonb keys from zone_floor_snapshots.zones[] must be ZoneFloor fields, as demand.ts persists them ──
const zf = demand.slice(demand.indexOf("export interface ZoneFloor"), demand.indexOf("export interface FloorResult"));
const zfFields = new Set([...zf.matchAll(/^\s+(\w+)\??:/gm)].map((x) => x[1]));
if (zfFields.size === 0) bad("could not parse interface ZoneFloor from demand.ts");
for (const k of new Set([...script.matchAll(/z->>'(\w+)'/g)].map((x) => x[1]))) {
  if (!zfFields.has(k)) bad(`jsonb key ${k} is not a ZoneFloor field (${[...zfFields].join(", ")})`);
}
// ── hbx config keys: only the ones store.ts reads for the curve in force ──
for (const k of new Set([...script.matchAll(/config->>'(\w+)'/g)].map((x) => x[1]))) {
  if (!store.includes(`config->>'${k}'`)) bad(`hbx config key ${k} is not read anywhere in store.ts`);
}
// ── SPAN circuit names ──
for (const n of ["Buffer Tank", "Air-Water 1", "Air-Water 2"]) {
  if (!script.includes(`'${n}'`)) bad(`script lacks circuit '${n}'`);
  if (!index.includes(`"${n}"`)) bad(`planner/src/index.ts does not name circuit "${n}"`);
}

// ── heredocs balanced, quoted (no bash expansion inside), and read-only ──
let open = 0, blocks = 0;
for (const l of script.split("\n")) {
  if (/<<'SQL'/.test(l)) { open++; blocks++; }
  else if (l === "SQL") open--;
  if (open < 0) bad("heredoc terminator without an opener");
}
if (open !== 0) bad(`unbalanced heredocs (${open} still open)`);
if (/<<SQL\b/.test(script) || /<<"SQL"/.test(script)) bad("an unquoted heredoc is present");
const sqlText = script.split("<<'SQL'").slice(1).map((s) => s.split("\nSQL\n")[0]).join("\n");
for (const kw of ["INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "TRUNCATE", "ALTER", "COPY", "GRANT", "VACUUM"]) {
  if (new RegExp(`^\\s*${kw}\\b`, "mi").test(sqlText)) bad(`write statement ${kw} in the SQL`);
}
// ── every psql variable the SQL interpolates is set with -v ──
const setVars = new Set([...script.matchAll(/-v (\w+)=/g)].map((x) => x[1]));
const usedVars = new Set([...sqlText.matchAll(/(?<![:\w]):'?([a-z_]\w*)'?/g)].map((x) => x[1]));
for (const v of usedVars) if (!setVars.has(v)) bad(`psql variable :${v} is never set with -v`);

console.log(`tables checked: ${Object.keys(uses).join(", ")}`);
console.log(`jsonb keys: ${[...new Set([...script.matchAll(/z->>'(\w+)'/g)].map((x) => x[1]))].join(", ")}`);
console.log(`heredoc blocks: ${blocks}; psql -v variables: ${[...setVars].join(", ")}; used: ${[...usedVars].join(", ")}`);
console.log(fail ? `\n${fail} problem(s)` : "\nall checks passed");
process.exit(fail ? 1 : 0);
