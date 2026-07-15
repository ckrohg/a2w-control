/**
 * Build Eval: w0-5-storm-wiring — storm pollers + events + manual API in index.ts
 *
 * index.ts cannot be imported (it starts the service), so checks are structural
 * plus compile. Gate-compliant — do NOT remove the regression-bounds,
 * stderr-format, or json-failed-checks blocks.
 *
 * @purpose Decomposed spec-compliance checks for issue #12 (specs/w0-5-storm-wiring.md)
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
function ensureDeps(dir: string): void {
  const wt = join(ROOT, dir, "node_modules"), main = join(MAIN, dir, "node_modules")
  if (ROOT !== MAIN && !existsSync(wt) && existsSync(main)) { try { symlinkSync(main, wt, "dir") } catch {} }
}

const INDEX = "planner/src/index.ts"

export async function evaluate(_dataPath: string): Promise<number> {
  const checks: { name: string; pass: boolean }[] = []
  const src = fileContent(INDEX)

  // L2: envs + imports
  checks.push({ name: "env-storm-mode-enabled", pass: src.includes("STORM_MODE_ENABLED") })
  checks.push({ name: "env-storm-cap", pass: src.includes("STORM_CAP_F") })
  checks.push({ name: "env-outagewatch-url", pass: src.includes("OUTAGEWATCH_URL") && src.includes("victorious-light-production.up.railway.app") })
  checks.push({ name: "imports-storm-module", pass: src.includes("./storm") && src.includes("evaluateStormState") && src.includes("fetchOutageStatus") })

  // L4: behavior wiring
  checks.push({ name: "trigger-poll-30min", pass: /30\s*\*\s*60\s*\*\s*1000|1_?800_?000/.test(src) })
  checks.push({ name: "outage-in-5min-loop", pass: src.includes("fetchOutageStatus") && (src.match(/fetchOutageStatus/g) || []).length >= 1 })
  checks.push({ name: "persists-storm-events", pass: src.includes("insertStormEvent") && src.includes("closeStormEvent") })
  checks.push({ name: "ntfy-on-transitions", pass: /ntfy\([^)]*[Ss]torm/.test(src) })
  checks.push({ name: "plan-shaping-gated-on-flag", pass: src.includes("STORM_MODE_ENABLED") && src.includes("stormCeilingF") })
  checks.push({ name: "only-raises-max", pass: /Math\.max\([^)]*tank_target_f|tank_target_f[\s\S]{0,80}Math\.max/.test(src) })
  checks.push({ name: "hp1-setpoint-recomputed", pass: src.includes("hp1_setpoint_f") && src.includes("i1MarginF") })
  checks.push({ name: "storm-reason-string", pass: src.includes("storm mode: banking heat") })

  // L2: manual API routes (authed)
  checks.push({ name: "arm-route", pass: src.includes("/api/storm/arm") })
  checks.push({ name: "disarm-route", pass: src.includes("/api/storm/disarm") })
  const armIdx = src.indexOf("/api/storm/")
  const authNearby = armIdx > 0 && src.slice(Math.max(0, armIdx - 2000), armIdx + 2000).includes("authed(")
  checks.push({ name: "storm-routes-authed", pass: authNearby })
  checks.push({ name: "arm-hours-clamped", pass: /72/.test(src) })
  checks.push({ name: "health-storm-field", pass: /storm:\s*\{/.test(src) || src.includes("storm: {") })

  // L3: substantive + regression bounds
  const primaryLineCount = lineCount(src)
  checks.push({ name: "primary-file-substantive-min-20-lines", pass: primaryLineCount >= 20 })
  const PRIMARY_LINE_BASELINE = 400
  checks.push({ name: "lines-not-shrinking-massively", pass: primaryLineCount === 0 || primaryLineCount >= PRIMARY_LINE_BASELINE * 0.9 })
  const KNOWN_EXPORTS: string[] = ["pollOnce", "shadowOnce", "scoreOnce", "checkI1", "checkI8", "/api/hbx/boost", "/health"]
  checks.push({ name: "required_exports_present", pass: KNOWN_EXPORTS.every(e => src.includes(e)) })

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
