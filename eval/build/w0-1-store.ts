/**
 * Build Eval: w0-1-store — storm_events + zone_floor_snapshots in planner/src/store.ts
 *
 * Gate-compliant. Do NOT remove the regression-bounds, stderr-format, or
 * json-failed-checks blocks — the eval-gate and build supervisor parse them.
 *
 * @purpose Decomposed spec-compliance checks for issue #8 (specs/w0-1-store.md)
 */
import { existsSync, readFileSync, symlinkSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"

const ROOT = process.env.AGENT_WORKTREE || process.cwd()
const MAIN = process.cwd()
function resolve(p: string): string { return join(ROOT, p) }
function fileContent(p: string): string {
  const full = resolve(p)
  return existsSync(full) ? readFileSync(full, "utf-8") : ""
}
function lineCount(text: string): number { return text ? text.split("\n").length : 0 }
/** git worktrees don't carry node_modules — link them from main so tsc can resolve deps */
function ensureDeps(dir: string): void {
  const wt = join(ROOT, dir, "node_modules"), main = join(MAIN, dir, "node_modules")
  if (ROOT !== MAIN && !existsSync(wt) && existsSync(main)) { try { symlinkSync(main, wt, "dir") } catch {} }
}

const FILE = "planner/src/store.ts"

export async function evaluate(_dataPath: string): Promise<number> {
  const checks: { name: string; pass: boolean }[] = []
  const src = fileContent(FILE)

  // L1/L2: schema additions
  checks.push({ name: "storm-events-table", pass: src.includes("CREATE TABLE IF NOT EXISTS storm_events") })
  checks.push({ name: "storm-events-columns", pass: src.includes("trigger") && src.includes("ceiling_f") && src.includes("ended_at") })
  checks.push({ name: "zone-floor-snapshots-table", pass: src.includes("CREATE TABLE IF NOT EXISTS zone_floor_snapshots") })
  checks.push({ name: "snapshot-columns", pass: src.includes("binding_zone") && src.includes("binding_awt_f") && src.includes("tank_target_f") })

  // L2: method signatures
  checks.push({ name: "insertStormEvent", pass: /async insertStormEvent\(/.test(src) })
  checks.push({ name: "closeStormEvent", pass: /async closeStormEvent\(/.test(src) })
  checks.push({ name: "activeStormEvent", pass: /async activeStormEvent\(/.test(src) })
  checks.push({ name: "insertZoneFloorSnapshot", pass: /async insertZoneFloorSnapshot\(/.test(src) })
  checks.push({ name: "latestZoneFloorSnapshot", pass: /async latestZoneFloorSnapshot\(/.test(src) })

  // L4: behavioral idioms from the spec
  checks.push({ name: "snapshot-conflict-do-nothing", pass: /zone_floor_snapshots[\s\S]{0,600}ON CONFLICT \(ts\) DO NOTHING/.test(src) })
  checks.push({ name: "close-newest-open-row", pass: /ended_at IS NULL/.test(src) })
  checks.push({ name: "purpose-header-updated", pass: src.includes("@purpose") && src.toLowerCase().includes("storm") })

  // L3: substantive + regression bounds
  const primaryLineCount = lineCount(src)
  checks.push({ name: "primary-file-substantive-min-20-lines", pass: primaryLineCount >= 20 })
  const PRIMARY_LINE_BASELINE = 318 // store.ts size before this task
  checks.push({ name: "lines-not-shrinking-massively", pass: primaryLineCount === 0 || primaryLineCount >= PRIMARY_LINE_BASELINE * 0.9 })

  // L4: existing surface preserved (additive-only constraint)
  const KNOWN_EXPORTS: string[] = ["ensureSchema", "insertReading", "latestConfig", "insertShadowPlan", "getRecentSeries", "upsertPlanScore", "insertHbxWrite", "baselineConfig", "getLatestSlx", "dueBoosts"]
  checks.push({ name: "required_exports_present", pass: KNOWN_EXPORTS.every(e => src.includes(e)) })
  checks.push({ name: "existing-tables-intact", pass: ["slx_readings", "hbx_config_versions", "shadow_plans", "plan_scores", "hbx_writes", "tank_decay_fits", "i1_episodes", "hbx_boosts", "phase_b_log"].every(t => src.includes(t)) })

  // L3: compile — planner project
  ensureDeps("planner")
  let compiles = false
  try { execSync("npx -p typescript tsc --noEmit -p planner/tsconfig.json", { cwd: ROOT, stdio: "pipe" }); compiles = true } catch {}
  checks.push({ name: "compiles", pass: compiles })

  const passed = checks.filter(c => c.pass).length
  const total = checks.length
  const failed = checks.filter(c => !c.pass).map(c => c.name)
  const score = total > 0 ? passed / total : 0
  console.error(`[eval] ${passed}/${total}: ${failed.length ? "failed: " + failed.join(", ") : "all passing"}`)
  if (failed.length > 0) {
    process.stdout.write(JSON.stringify({ failed_checks: failed, score }) + "\n")
  }
  return score
}

if (import.meta.url === `file://${process.argv[1]}`) {
  evaluate(process.argv[2] || "").then(s => { console.log(JSON.stringify({ metric: s })) })
}
