# Agent: build-w0-2-demand

## Task
BUILD TASK — Create the files described below. Write code immediately. Do NOT spend turns exploring — the eval diagnostics tell you exactly what's missing.

FAILED CHECKS (from eval):


EVAL DIAGNOSTICS:
{"failed_checks":["file-exists","purpose-header","type-InsightZone","type-FloorResult","fetch-insights-endpoint","fetch-timeout","module-imports","buffer-margin-4.5","baseboard-design-day-135","baseboard-30F-band","baseboard-mild-floor-108","radiant-5F-110","radiant-60F-95","minisplit-null","binding-zone-design-day","tank-target-adds-margin","calling-set-respected","no-calls-null-binding","degraded-mode-null","primary-file-substantive-min-20-lines","required_exports_present","compiles"],"score":0.043478260869565216}

YOUR TASK:
"

IMPORTANT: Use write_file to create complete files. Every failed check above is something you need to fix. Start writing code NOW.

## Constraints
- **Files in scope (create or modify):** planner/src/demand.ts
- **Do NOT modify:** AGENT.md, EXPERIMENTS.md, eval scripts, node_modules, dist
- **Max file changes:** 3
- **Time budget:** 600s

## How to Succeed (build mode)
1. Read EXPERIMENTS.md — it shows what failed and any partial scaffolding
2. Create or modify the files listed in **Files in scope** so the spec's acceptance criteria pass
   - Use Write tool for files that don't exist yet
   - Use Edit tool for files that exist
3. Stop when the eval would score >baseline — it runs automatically after you exit

## What NOT to Do
- Do not modify AGENT.md, EXPERIMENTS.md, eval scripts, or tests
- Do not just add comments or documentation
- Do not repeat experiments listed as REJECTED in EXPERIMENTS.md
