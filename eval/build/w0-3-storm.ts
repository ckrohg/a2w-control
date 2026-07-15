/**
 * Build Eval: w0-3-storm — planner/src/storm.ts triggers + pure state machine
 *
 * Behavioral checks import the module (tsx) and drive evaluateStormState /
 * deriveSyntheticTriggers / stormCeilingF with fixtures. Gate-compliant. Do NOT
 * remove the regression-bounds, stderr-format, or json-failed-checks blocks.
 *
 * @purpose Decomposed spec-compliance checks for issue #10 (specs/w0-3-storm.md)
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

const FILE = "planner/src/storm.ts"
const NOW = new Date("2026-01-10T12:00:00Z")
const H = 3600_000
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString()
const ARM_ALERT = { event: "Winter Storm Warning", severity: "Severe", tier: "arm", onset: iso(6 * H), expires: iso(30 * H), headline: "test" }
const NO_INPUT = { alerts: [], synthetic: [], outageActive: null as boolean | null }

export async function evaluate(_dataPath: string): Promise<number> {
  const checks: { name: string; pass: boolean }[] = []
  const src = fileContent(FILE)

  // L1/L2 structure
  checks.push({ name: "file-exists", pass: existsSync(resolve(FILE)) })
  checks.push({ name: "purpose-header", pass: src.includes("@purpose") })
  checks.push({ name: "nws-endpoint-and-user-agent", pass: src.includes("api.weather.gov/alerts/active") && src.includes("User-Agent") })
  checks.push({ name: "nws-event-filter", pass: /winter storm|ice storm/i.test(src) && /blizzard/i.test(src) && /extreme cold/i.test(src) })
  checks.push({ name: "openmeteo-fields", pass: src.includes("wind_gusts_10m") && src.includes("snowfall") && src.includes("weather_code") })

  // L5 behavioral
  let m: any = null
  try { m = await import(pathToFileURL(resolve(FILE)).href) } catch {}
  checks.push({ name: "module-imports", pass: !!m })

  let armed: any = null
  try { armed = m.evaluateStormState({ kind: "idle" }, { ...NO_INPUT, alerts: [ARM_ALERT] }, NOW) } catch {}
  checks.push({ name: "warning-arms", pass: armed?.state?.kind === "armed" })
  checks.push({ name: "window-starts-24h-before-onset", pass: !!armed && armed.state.kind === "armed" && Math.abs(new Date(armed.state.windowStart).getTime() - (new Date(ARM_ALERT.onset).getTime() - 24 * H)) <= H })
  checks.push({ name: "window-ends-expires-plus-6h", pass: !!armed && armed.state.kind === "armed" && Math.abs(new Date(armed.state.windowEnd).getTime() - (new Date(ARM_ALERT.expires).getTime() + 6 * H)) <= H })

  let disarmed: any = null
  try { disarmed = m.evaluateStormState(armed?.state ?? { kind: "idle" }, { ...NO_INPUT, alerts: [ARM_ALERT], manual: { disarm: true } }, NOW) } catch {}
  checks.push({ name: "manual-disarm-wins", pass: disarmed?.state?.kind === "idle" && !!disarmed?.state?.suppressedUntil })
  let suppressed: any = null
  try { suppressed = m.evaluateStormState(disarmed?.state ?? { kind: "idle" }, { ...NO_INPUT, alerts: [ARM_ALERT] }, new Date(NOW.getTime() + H)) } catch {}
  checks.push({ name: "suppression-holds", pass: suppressed?.state?.kind === "idle" })

  let manualArm: any = null
  try { manualArm = m.evaluateStormState({ kind: "idle" }, { ...NO_INPUT, manual: { armHours: 24 } }, NOW) } catch {}
  checks.push({ name: "manual-arm", pass: manualArm?.state?.kind === "armed" && manualArm?.state?.trigger === "manual" })

  let active: any = null
  try { active = m.evaluateStormState({ kind: "idle" }, { ...NO_INPUT, outageActive: true }, NOW) } catch {}
  checks.push({ name: "outage-activates", pass: active?.state?.kind === "active" })
  let nullSignal: any = null
  try { nullSignal = m.evaluateStormState({ kind: "idle" }, NO_INPUT, NOW) } catch {}
  checks.push({ name: "null-outage-never-arms", pass: nullSignal?.state?.kind === "idle" })

  let synth: any = null
  try {
    const hours = [
      { ts: iso(1 * H), tempF: -5, gustMph: 50, snowfallIn: 3, weatherCode: 66 },
      { ts: iso(2 * H), tempF: 2, gustMph: 52, snowfallIn: 3, weatherCode: 66 },
      { ts: iso(3 * H), tempF: 5, gustMph: 48, snowfallIn: 3, weatherCode: 0 },
    ]
    synth = m.deriveSyntheticTriggers(hours)
  } catch {}
  const kinds = Array.isArray(synth) ? synth.map((t: any) => t.kind) : []
  checks.push({ name: "synthetic-extreme-cold", pass: kinds.includes("extreme-cold") })
  checks.push({ name: "synthetic-high-wind", pass: kinds.includes("high-wind") })
  checks.push({ name: "synthetic-freezing-rain", pass: kinds.includes("freezing-rain") })
  checks.push({ name: "synthetic-heavy-snow", pass: kinds.includes("heavy-snow") })
  let benign: any = null
  try { benign = m.deriveSyntheticTriggers([{ ts: iso(H), tempF: 40, gustMph: 10, snowfallIn: 0, weatherCode: 1 }]) } catch {}
  checks.push({ name: "benign-forecast-no-triggers", pass: Array.isArray(benign) && benign.length === 0 })

  let ceilOk = false
  try { ceilOk = m.stormCeilingF(160, 135) === 135 && m.stormCeilingF(120, 135) === 123 && m.stormCeilingF(null, 135) === 135 } catch {}
  checks.push({ name: "storm-ceiling-capped", pass: ceilOk })

  let outageNull = false
  try { outageNull = (await m.fetchOutageStatus("http://127.0.0.1:9")) === null } catch {}
  checks.push({ name: "unreachable-outagewatch-null", pass: outageNull })

  // L3: substantive + regression bounds
  const primaryLineCount = lineCount(src)
  checks.push({ name: "primary-file-substantive-min-20-lines", pass: primaryLineCount >= 20 })
  const PRIMARY_LINE_BASELINE = 80
  checks.push({ name: "lines-not-shrinking-massively", pass: primaryLineCount === 0 || primaryLineCount >= PRIMARY_LINE_BASELINE * 0.5 })
  const KNOWN_EXPORTS: string[] = ["fetchNwsAlerts", "fetchStormForecast", "deriveSyntheticTriggers", "fetchOutageStatus", "evaluateStormState", "stormCeilingF", "StormState"]
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
