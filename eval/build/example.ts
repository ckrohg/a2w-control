/**
 * Example Build Eval
 *
 * This is a template for creating build evals. Each check is binary (pass/fail).
 * Score = passed / total. The agent iterates until 1.0.
 *
 * Generate evals automatically: tenet build --spec knowledge/MY_SPEC.md --name my-feature
 * Or manually: copy this file, rename, add your checks.
 *
 * Pattern: "Granularity of feedback determines speed of convergence."
 * See: knowledge/BUILD_AGENTS_GUIDE.md
 *
 * @purpose Example build eval template — copy and customize
 */
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"

const ROOT = process.env.AGENT_WORKTREE || process.cwd()
function resolve(p: string): string { return join(ROOT, p) }
function fileContains(p: string, text: string): boolean {
  const full = resolve(p)
  if (!existsSync(full)) return false
  return readFileSync(full, "utf-8").includes(text)
}

export async function evaluate(_dataPath: string): Promise<number> {
  const checks: { name: string; pass: boolean }[] = []

  // Level 1: File existence
  // checks.push({ name: "file-exists", pass: existsSync(resolve("src/lib/my-module.ts")) })

  // Level 2: Has required content
  // checks.push({ name: "has-export", pass: fileContains("src/lib/my-module.ts", "export function") })
  // checks.push({ name: "has-interface", pass: fileContains("src/lib/my-module.ts", "interface MyType") })
  // checks.push({ name: "has-purpose", pass: fileContains("src/lib/my-module.ts", "@purpose") })

  // Level 2: Compiles
  // let compiles = false
  // try { execSync("npx tsc --noEmit", { cwd: ROOT, stdio: "pipe" }); compiles = true } catch {}
  // checks.push({ name: "compiles", pass: compiles })

  // Placeholder check (remove when adding real checks)
  checks.push({ name: "placeholder", pass: true })

  const passed = checks.filter(c => c.pass).length
  const failed = checks.filter(c => !c.pass)
  console.error(`example: ${passed}/${checks.length} — ${failed.map(c => c.name).join(", ") || "all passing"}`)
  console.log(JSON.stringify({ metric: passed / checks.length, passed, total: checks.length, failed_checks: failed.map(c => c.name) }))
  return passed / checks.length
}

if (import.meta.url === `file://${process.argv[1]}`) {
  evaluate(process.argv[2] || "").then(m => { console.log(JSON.stringify({ metric: m })) })
}
