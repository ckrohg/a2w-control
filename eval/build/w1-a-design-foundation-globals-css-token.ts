/**
 * Build Eval: w1-a-design-foundation-globals-css-token
 *
 * Auto-generated from spec. Decomposed checks — each is binary.
 * Score = passed / total. Agent iterates until 1.0.
 *
 * Pattern: "Granularity of feedback determines speed of convergence."
 *
 * Gate-compliant by default. Passes `tenet eval gate` out of the box; do
 * NOT remove the regression-bounds, stderr-format, or json-failed-checks
 * blocks below — the eval-gate (and the build supervisor) parse them.
 * Authority: specs/build-cycle-primitives/eval-gate-contract.md.
 *
 * @purpose Build eval for w1-a-design-foundation-globals-css-token — decomposed spec compliance checks
 */
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"

// AGENT_WORKTREE-aware: eval must score the agent's worktree, not main.
const ROOT = process.env.AGENT_WORKTREE || process.cwd()
function resolve(p: string): string { return join(ROOT, p) }
function fileContent(p: string): string {
  const full = resolve(p)
  return existsSync(full) ? readFileSync(full, "utf-8") : ""
}
function fileContains(p: string, text: string): boolean {
  return fileContent(p).includes(text)
}
function lineCount(text: string): number {
  return text ? text.split("\n").length : 0
}

export async function evaluate(_dataPath: string): Promise<number> {
  const checks: { name: string; pass: boolean }[] = []

  // L3: substantive — combined with REGRESSION-BOUNDS for the eval-gate.
  // line_count baseline guard: file must not collapse to a stub between rounds.
  const primaryLineCount = lineCount(fileContent("src/lib/unknown.ts"))
  checks.push({ name: "primary-file-substantive-min-20-lines", pass: primaryLineCount >= 20 })
  // linesNotShrinkingMassively: prevents destructive-rewrite anti-pattern.
  // baseline = expected minimum healthy size; raise this once the file lands.
  const PRIMARY_LINE_BASELINE = 20
  checks.push({ name: "lines-not-shrinking-massively", pass: primaryLineCount === 0 || primaryLineCount >= PRIMARY_LINE_BASELINE * 0.5 })
  // L3: compile check — uses `npx -p typescript tsc` to avoid the imposter package.
  let compiles = false
  try { execSync("npx -p typescript tsc --noEmit", { cwd: ROOT, stdio: "pipe" }); compiles = true } catch {}
  checks.push({ name: "compiles", pass: compiles })
  // L4: REPLACE — declare KNOWN_EXPORTS once the spec is firmed up.
  // The eval-gate scans for required_exports_present / KNOWN_EXPORTS — keep this.
  const KNOWN_EXPORTS: string[] = [] // REPLACE: add expected export names from spec
  const primarySrc = fileContent("src/lib/unknown.ts")
  checks.push({ name: "required_exports_present", pass: KNOWN_EXPORTS.length === 0 || KNOWN_EXPORTS.every(e => primarySrc.includes(e)) })
  // L6: Test file exists (sibling or in __tests__) — sharpen with block count when test framework wired.
  checks.push({ name: "tests-present", pass: existsSync(resolve("src/lib/unknown.test.ts")) || existsSync(resolve("src/__tests__/lib/unknown.test.ts")) })
  // L4: Primary file has no TODO markers — agent must finish before scoring.
  checks.push({ name: "no-todos-left", pass: !fileContent("src/lib/unknown.ts").match(/\bTODO\b/) })
  // L4: Default-pass; tighten by editing this line if the spec adds a no-any constraint.
  checks.push({ name: "no-any-types", pass: true /* TODO: tighten — spec didn't forbid `: any`, change to a regex check if it should */ })
  // L4: @purpose header has content (>5 chars) — not just the literal word.
  checks.push({ name: "purpose-not-empty", pass: (() => { const src = fileContent("src/lib/unknown.ts"); const m = src.match(/@purpose\s+(.+)/); return !!(m && m[1].trim().length > 5) })() })

  const passed = checks.filter(c => c.pass).length
  const total = checks.length
  const failed = checks.filter(c => !c.pass).map(c => c.name)
  const score = total > 0 ? passed / total : 0

  // Canonical stderr format — the build supervisor parses this for
  // failing check names and injects them into EXPERIMENTS.md hints.
  // Do NOT change the format string; the eval-gate's `stderr-format`
  // hard check matches against `[eval] N/M: failed:|all passing`.
  console.error(`[eval] ${passed}/${total}: ${failed.length ? "failed: " + failed.join(", ") : "all passing"}`)

  // Structured failure JSON to stdout — peter.ts JSON.parses the last
  // stdout line and reads `failed_checks` to build the hint. Keep this
  // emit on the failure branch; the eval-gate's `json-failed-checks`
  // hard check requires it.
  if (failed.length > 0) {
    process.stdout.write(JSON.stringify({ failed_checks: failed, score }) + "\n")
  }

  return score
}

// Direct execution: `npx tsx eval/build/w1-a-design-foundation-globals-css-token.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  evaluate(process.argv[2] || "").then(s => { console.log(JSON.stringify({ metric: s })) })
}
