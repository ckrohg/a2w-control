/**
 * Build Eval: w0-6-dashboard — storm banner + controls + history on analytics-mirror
 *
 * Structural checks + Next.js typecheck (server components can't be imported
 * standalone). Gate-compliant — do NOT remove the regression-bounds,
 * stderr-format, or json-failed-checks blocks.
 *
 * @purpose Decomposed spec-compliance checks for issue #13 (specs/w0-6-dashboard.md)
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

const BANNER = "analytics-mirror/app/storm-banner.tsx"
const ROUTE = "analytics-mirror/app/api/planner/storm/route.ts"
const CONTROL = "analytics-mirror/app/control/control-client.tsx"
const HBX = "analytics-mirror/app/hbx/page.tsx"

export async function evaluate(_dataPath: string): Promise<number> {
  const checks: { name: string; pass: boolean }[] = []
  const banner = fileContent(BANNER)
  const route = fileContent(ROUTE)
  const control = fileContent(CONTROL)
  const hbx = fileContent(HBX)

  // L1
  checks.push({ name: "banner-exists", pass: existsSync(resolve(BANNER)) })
  checks.push({ name: "route-exists", pass: existsSync(resolve(ROUTE)) })

  // L2/L4: banner
  checks.push({ name: "banner-queries-open-event", pass: banner.includes("storm_events") && banner.includes("ended_at IS NULL") })
  checks.push({ name: "banner-degrades-silently", pass: banner.includes("catch") })
  checks.push({ name: "banner-on-home", pass: fileContent("analytics-mirror/app/page.tsx").includes("StormBanner") })
  checks.push({ name: "banner-on-hbx-curve-savings", pass: hbx.includes("StormBanner") && fileContent("analytics-mirror/app/curve/page.tsx").includes("StormBanner") && fileContent("analytics-mirror/app/savings/page.tsx").includes("StormBanner") })

  // L2/L4: route handler
  checks.push({ name: "route-authed", pass: route.includes("isAuthed") })
  checks.push({ name: "route-proxies-planner", pass: route.includes("PLANNER_API_TOKEN") && (route.includes("/api/storm/") || (route.includes("arm") && route.includes("disarm"))) })
  checks.push({ name: "route-token-server-side-only", pass: !control.includes("PLANNER_API_TOKEN") })
  checks.push({ name: "route-has-get-status", pass: route.includes("export async function GET") || route.includes("export const GET") })

  // L2/L4: control card
  checks.push({ name: "control-storm-card", pass: control.includes("Storm Mode") || control.includes("Storm mode") })
  checks.push({ name: "control-arm-disarm-actions", pass: control.includes("arm") && control.includes("disarm") })

  // L2/L4: history on /hbx
  checks.push({ name: "hbx-storm-history", pass: hbx.includes("storm_events") && (hbx.includes("Storm events") || hbx.includes("Storm history")) })
  checks.push({ name: "hbx-history-guarded", pass: /try[\s\S]{0,400}storm_events/.test(hbx) || /storm_events[\s\S]{0,400}catch/.test(hbx) })

  // L4: house conventions on new files
  checks.push({ name: "route-dynamic-exports", pass: route.includes("force-dynamic") || route.includes("dynamic") })

  // L3: substantive + regression bounds
  const primaryLineCount = lineCount(banner)
  checks.push({ name: "primary-file-substantive-min-20-lines", pass: primaryLineCount >= 20 })
  const PRIMARY_LINE_BASELINE = 20
  checks.push({ name: "lines-not-shrinking-massively", pass: primaryLineCount === 0 || primaryLineCount >= PRIMARY_LINE_BASELINE * 0.5 })
  const KNOWN_EXPORTS: string[] = ["StormBanner"]
  checks.push({ name: "required_exports_present", pass: KNOWN_EXPORTS.every(e => banner.includes(e)) })
  // existing pages keep their conventions (regression guard)
  checks.push({ name: "hbx-page-conventions-intact", pass: hbx.includes("force-dynamic") && hbx.includes("I1Banner") })

  // L3 compile — Next.js typecheck via tsc
  ensureDeps("analytics-mirror")
  let compiles = false
  try { execSync("npx -p typescript tsc --noEmit", { cwd: join(ROOT, "analytics-mirror"), stdio: "pipe" }); compiles = true } catch {}
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
