/**
 * Build Eval: w0-2-demand — planner/src/demand.ts service-floor engine + insights client
 *
 * Behavioral checks import the module directly (tsx) and assert the §6.9 math.
 * Gate-compliant. Do NOT remove the regression-bounds, stderr-format, or
 * json-failed-checks blocks — the eval-gate and build supervisor parse them.
 *
 * @purpose Decomposed spec-compliance checks for issue #9 (specs/w0-2-demand.md)
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

const FILE = "planner/src/demand.ts"
const near = (v: unknown, t: number, tol: number) => typeof v === "number" && Math.abs(v - t) <= tol

const ZONES = [
  { id: "z1", name: "Dining", deliveryType: "baseboard", uaBtuHrF: 90, thermalMassBtuF: 780, confidence: 0.8 },
  { id: "z2", name: "Kitchen", deliveryType: "radiant_floor", uaBtuHrF: 104, thermalMassBtuF: 857, confidence: 0.8 },
  { id: "z3", name: "Den", deliveryType: "mini_split", uaBtuHrF: 10, thermalMassBtuF: null, confidence: 0.9 },
]

export async function evaluate(_dataPath: string): Promise<number> {
  const checks: { name: string; pass: boolean }[] = []
  const src = fileContent(FILE)

  // L1/L2
  checks.push({ name: "file-exists", pass: existsSync(resolve(FILE)) })
  checks.push({ name: "purpose-header", pass: src.includes("@purpose") })
  checks.push({ name: "type-InsightZone", pass: src.includes("interface InsightZone") || src.includes("type InsightZone") })
  checks.push({ name: "type-FloorResult", pass: src.includes("interface FloorResult") || src.includes("type FloorResult") })
  checks.push({ name: "fetch-insights-endpoint", pass: src.includes("/api/insights/zones") && src.includes("Bearer") })
  checks.push({ name: "fetch-timeout", pass: src.includes("AbortSignal.timeout") })

  // L5: behavioral — import and drive the pure engine
  let m: any = null
  try { m = await import(pathToFileURL(resolve(FILE)).href) } catch {}
  checks.push({ name: "module-imports", pass: !!m })
  checks.push({ name: "buffer-margin-4.5", pass: m?.BUFFER_MARGIN_F === 4.5 })
  checks.push({ name: "baseboard-design-day-135", pass: !!m && near(m.requiredAwtF("baseboard", 5), 135, 0.5) })
  checks.push({ name: "baseboard-30F-band", pass: !!m && typeof m.requiredAwtF("baseboard", 30) === "number" && m.requiredAwtF("baseboard", 30) >= 111 && m.requiredAwtF("baseboard", 30) <= 116 })
  checks.push({ name: "baseboard-mild-floor-108", pass: !!m && m.requiredAwtF("baseboard", 50) === 108 && m.requiredAwtF("baseboard", 70) === 108 })
  checks.push({ name: "radiant-5F-110", pass: !!m && near(m.requiredAwtF("radiant_floor", 5), 110, 0.01) })
  checks.push({ name: "radiant-60F-95", pass: !!m && near(m.requiredAwtF("radiant_floor", 60), 95, 0.01) })
  checks.push({ name: "minisplit-null", pass: !!m && m.requiredAwtF("mini_split", 30) === null && m.requiredAwtF("dhw", 30) === null })
  let floors: any = null
  try { floors = m?.computeFloors(ZONES, null, 5) } catch {}
  checks.push({ name: "binding-zone-design-day", pass: floors?.bindingZone === "Dining" && near(floors?.bindingAwtF, 135, 0.5) })
  checks.push({ name: "tank-target-adds-margin", pass: !!floors && near(floors.tankTargetF, (floors.bindingAwtF ?? 0) + 4.5, 0.11) })
  let floorsCalling: any = null
  try { floorsCalling = m?.computeFloors(ZONES, ["z2"], 5) } catch {}
  checks.push({ name: "calling-set-respected", pass: floorsCalling?.bindingZone === "Kitchen" && near(floorsCalling?.bindingAwtF, 110, 0.01) })
  let floorsNone: any = null
  try { floorsNone = m?.computeFloors(ZONES, [], 5) } catch {}
  checks.push({ name: "no-calls-null-binding", pass: !!floorsNone && floorsNone.bindingZone === null && floorsNone.tankTargetF === null })
  let degradedOk = false
  try {
    const feed = new m.DemandFeed("http://127.0.0.1:9", "t")
    degradedOk = feed.isHealthy() === false && feed.proposeFloor(30) === null
  } catch {}
  checks.push({ name: "degraded-mode-null", pass: degradedOk })

  // L3: substantive + regression bounds
  const primaryLineCount = lineCount(src)
  checks.push({ name: "primary-file-substantive-min-20-lines", pass: primaryLineCount >= 20 })
  const PRIMARY_LINE_BASELINE = 60
  checks.push({ name: "lines-not-shrinking-massively", pass: primaryLineCount === 0 || primaryLineCount >= PRIMARY_LINE_BASELINE * 0.5 })
  const KNOWN_EXPORTS: string[] = ["BUFFER_MARGIN_F", "requiredAwtF", "computeFloors", "fetchInsightZones", "DemandFeed"]
  checks.push({ name: "required_exports_present", pass: KNOWN_EXPORTS.every(e => src.includes(e)) })

  // L3: compile
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
