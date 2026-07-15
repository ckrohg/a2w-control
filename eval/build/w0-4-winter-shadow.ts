/**
 * Build Eval: w0-4-winter-shadow — demand floor wired into shadow.ts + index.ts
 *
 * Behavioral checks drive computeShadowPlan with a DemandFloor fixture and assert
 * the winter branch honors it (and the I4 clamp still binds). index.ts checks are
 * structural (importing it would start the service). Gate-compliant — do NOT
 * remove the regression-bounds, stderr-format, or json-failed-checks blocks.
 *
 * @purpose Decomposed spec-compliance checks for issue #11 (specs/w0-4-winter-shadow.md)
 */
import { existsSync, readFileSync, symlinkSync } from "fs"
import { join } from "path"
import { pathToFileURL } from "url"
import { execSync } from "child_process"

const ROOT = process.env.AGENT_WORKTREE || process.cwd()
const MAIN = process.cwd()
function resolve(p: string): string { return join(ROOT, p) }
function fileContent(p: string): string {
  const full = resolve(p)
  return existsSync(full) ? readFileSync(full, "utf-8") : ""
}
function lineCount(text: string): number { return text ? text.split("\n").length : 0 }
function ensureDeps(dir: string): void {
  const wt = join(ROOT, dir, "node_modules"), main = join(MAIN, dir, "node_modules")
  if (ROOT !== MAIN && !existsSync(wt) && existsSync(main)) { try { symlinkSync(main, wt, "dir") } catch {} }
}

const SHADOW = "planner/src/shadow.ts"
const INDEX = "planner/src/index.ts"
const CFG = { dot: 5, dbt: 165, wwsd: 125, mbt: 145 } // as-found HBX curve
const FLOOR = { tankTargetF: 128, bindingZone: "Dining", awtF: 123 }

export async function evaluate(_dataPath: string): Promise<number> {
  const checks: { name: string; pass: boolean }[] = []
  const shadowSrc = fileContent(SHADOW)
  const indexSrc = fileContent(INDEX)

  // L2 structure
  checks.push({ name: "demand-floor-type-exported", pass: shadowSrc.includes("DemandFloor") && shadowSrc.includes("export") })
  checks.push({ name: "flag-in-index", pass: indexSrc.includes("WINTER_SOLVER_SHADOW") })
  checks.push({ name: "demand-feed-imported", pass: indexSrc.includes("DemandFeed") && indexSrc.includes("./demand") })
  checks.push({ name: "snapshot-persisted", pass: indexSrc.includes("insertZoneFloorSnapshot") })
  checks.push({ name: "health-winter-solver", pass: indexSrc.includes("winter_solver") })
  checks.push({ name: "degraded-fallback-visible", pass: indexSrc.includes("degraded") || shadowSrc.includes("degraded") })

  // L5 behavioral — cold forecast (20°F), with and without a demand floor
  let m: any = null
  try { m = await import(pathToFileURL(resolve(SHADOW)).href) } catch {}
  checks.push({ name: "shadow-module-imports", pass: !!m })

  const coldForecast = Array.from({ length: 24 }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 0, 15, i)), outdoorF: 20,
  }))
  let withFloor: any = null, without: any = null
  try {
    withFloor = m.computeShadowPlan(coldForecast, CFG, m.DEFAULT_OPTS, FLOOR)
    without = m.computeShadowPlan(coldForecast, CFG, m.DEFAULT_OPTS)
  } catch {}
  const wf0 = withFloor?.[3] // an idle-ish hour, all outdoor 20°F
  const wo0 = without?.[3]
  checks.push({ name: "floor-raises-winter-target", pass: !!wf0 && wf0.tank_target_f === 128 })
  checks.push({ name: "reason-names-binding-zone", pass: !!withFloor && withFloor.some((b: any) => typeof b.reason === "string" && b.reason.includes("binding zone: Dining") && b.reason.includes("123")) })
  checks.push({ name: "no-floor-preserves-winter-guard", pass: !!wo0 && wo0.tank_target_f === 135 && /winter guard/i.test(wo0.reason) })
  // I4 clamp still binds: a floor above the strict cap must clamp to the band top (135)
  let clamped: any = null
  try { clamped = m.computeShadowPlan(coldForecast, CFG, m.DEFAULT_OPTS, { tankTargetF: 150, bindingZone: "Dining", awtF: 145 }) } catch {}
  checks.push({ name: "i4-clamp-still-authoritative", pass: !!clamped && clamped.every((b: any) => b.tank_target_f <= 135) })
  // summer block untouched by the floor (outdoor 70 ≥ winterGuardF)
  let summer: any = null
  try {
    const warm = Array.from({ length: 24 }, (_, i) => ({ ts: new Date(Date.UTC(2026, 6, 15, i)), outdoorF: 70 }))
    summer = m.computeShadowPlan(warm, CFG, m.DEFAULT_OPTS, FLOOR)
  } catch {}
  checks.push({ name: "summer-blocks-unaffected", pass: !!summer && summer.every((b: any) => !String(b.reason).includes("binding zone")) })
  checks.push({ name: "default-opts-unchanged", pass: !!m && m.DEFAULT_OPTS.i1MarginF === 5 && m.DEFAULT_OPTS.strictCapF === 135 && m.DEFAULT_OPTS.winterGuardF === 50 })

  // L3: substantive + regression bounds (index.ts is the larger file)
  const primaryLineCount = lineCount(indexSrc)
  checks.push({ name: "primary-file-substantive-min-20-lines", pass: primaryLineCount >= 20 })
  const PRIMARY_LINE_BASELINE = 400 // index.ts before this task
  checks.push({ name: "lines-not-shrinking-massively", pass: primaryLineCount === 0 || primaryLineCount >= PRIMARY_LINE_BASELINE * 0.9 })
  const KNOWN_EXPORTS: string[] = ["computeShadowPlan", "bandFor", "curveTargetF", "DEFAULT_OPTS", "fetchForecast"]
  checks.push({ name: "required_exports_present", pass: KNOWN_EXPORTS.every(e => shadowSrc.includes(e)) })

  // L3 compile
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
