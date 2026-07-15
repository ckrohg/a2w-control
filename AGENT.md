# Agent: build-w0-1-store

## Task
BUILD TASK — Create the files described below. Write code immediately. Do NOT spend turns exploring — the eval diagnostics tell you exactly what's missing.

FAILED CHECKS (from eval):


EVAL DIAGNOSTICS:
{"failed_checks":["storm-events-table","storm-events-columns","zone-floor-snapshots-table","snapshot-columns","insertStormEvent","closeStormEvent","activeStormEvent","insertZoneFloorSnapshot","latestZoneFloorSnapshot","snapshot-conflict-do-nothing","close-newest-open-row","purpose-header-updated","compiles"],"score":0.23529411764705882}

YOUR TASK:
"

IMPORTANT: Use write_file to create complete files. Every failed check above is something you need to fix. Start writing code NOW.

## Constraints
- **Files in scope (create or modify):** planner/src/store.ts
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
