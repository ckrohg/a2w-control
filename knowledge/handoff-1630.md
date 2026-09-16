<!--
@purpose Fresh-session handoff prompt for TempIQ #1600 world-model work (2026-07-16).
Paste the block under "## Prompt" as the first message of a new session. Context: Phase 1
(LLM world-prior spatial inference) shipped (#1611 + hotfixes #1619/#1626), generated the
first 6BB graph, owner reviewed it → labels locked in twin_edges + modeling gaps opened as
TempIQ #1630. Two items queued: (1) #1630 prompt/representation fix + re-run; (2) rebase +
merge Phase 2 PR #1615 (red only from staleness, not a code bug).
-->

# Handoff — TempIQ #1600 world-model (next session)

**Run from:** `cd /Users/ckrohg/Documents/Claude/a2w-control` (the TENET workspace — CLAUDE.md +
journals auto-load here, and the prompt's relative paths `cd planner` and `../TempIQv2/.env`
resolve from here). TempIQ code is edited via isolated git worktrees off `../TempIQv2`, never by
`cd`-ing into it as home base.

Paste the block below as the **first message** of a fresh session.

## Prompt

```
Continue the TempIQ #1600 causal spatial world-model work. Phase 1 (LLM world-prior spatial
inference) shipped last session and generated the first real 6BB graph, which the owner reviewed.
Two things are queued. Start with `tenet_context`, then read TempIQ issue #1630 (has the full plan
+ the owner's confirmed-label validation table) and PR #1615.

── TASK 1 (primary): TempIQ #1630 — fix the world-prior's modeling flaw + re-run ──
The Phase-1 world-prior over-infers physical adjacency from shared HVAC systems. The owner's 6BB
review proved system-membership and adjacency are ORTHOGONAL (same mini-split can span floors;
ensuite rooms can be on different systems). Implement the #1630 plan:
  1. system-membership = a WEAK proximity hint, overridable by floor/room-name evidence; model
     same-system thermal coupling as its OWN relationship, distinct from spatial adjacency.
  2. weighted many-to-many / PARTIAL overlaps (owner: "upstairs bath is above PART of the kitchen
     radiant") — fractional weights, not binary edges.
  3. hallway/connector spaces that mediate adjacency (6BB: Downstairs↔Living↔Dining share a
     downstairs hall; Ally's/Christian's/Upstairs-Office/William cluster around an upstairs hall).
  4. fix the upstairs-cluster coverage gap.
Files: server/services/thermal/spatial-world-prior.ts (SYSTEM_PROMPT + buildUserPrompt + possibly
edge metadata/subtype), and tests/unit/services/spatial-world-prior.test.ts.

Use the FROZEN-CONTRACT SUBAGENT pattern (like Phase 1): author specs/a2w3-1600-*.md +
eval/build/a2w3-1600-*.ts, then dispatch a general-purpose Agent in an ISOLATED git worktree off
fresh origin/main, iterate to eval metric=1.0, open the PR. Do NOT use `tenet build --run`.

CRITICAL TRAPS:
  - claude-sonnet-4-6 REJECTS assistant-message prefill (400) — never add a `{ role:"assistant" }`
    turn. Force JSON via the prompt + a tolerant greedy-brace parser + ample max_tokens (8000).
    Read the first TEXT block via .find (not content[0]); try/catch messages.create. (See memory
    sonnet-4-6-no-prefill — this cost 2 deploy cycles last session.)
  - TempIQ's Vercel prod has a PROMOTION RACE: after merge, the new route can take 10-30 min to
    become the live alias, and concurrent merges sometimes promote an older commit. Poll before
    concluding "deployed"; check `gh api repos/ckrohg-org/TempIQv2/deployments?environment=Production`.

RE-RUN + VALIDATE after the fix deploys:
  - Trigger: POST https://tempiq.vercel.app/api/insights/infer-spatial with a Bearer full-scope
    surface token (get it from `cd planner && railway variables --json | jq -r .TEMPIQ_SURFACE_TOKEN`
    — it's scope=full, bound to 6BB property 10ade374-bd2e-466b-83aa-6329b8f39c71). Returns a
    summary {status, edgesWritten, adjacencyEdges, verticalEdges, confidenceHistogram}.
  - Inspect the actual graph read-only against TempIQ's DB (DATABASE_URL is in ../TempIQv2/.env):
    twin_edges (discovery_source='world_prior') JOIN twin_nodes ON zone_id JOIN zones for names +
    causal_evidence->>'reasoning'; zone_space_mappings; spaces.
  - MUST NOT clobber the owner's confirmed labels: rows with user_confirmed=true are ground truth
    (the world-prior already guards this). Validate the new graph against #1630's label table.
  - Present the regenerated graph to the owner for a second review round.

── TASK 2: rebase + merge PR #1615 (Phase 2 — passive coupling fuses the world-prior) ──
Built + verified last session (eval 16/16, vitest 9/9 locally) but its CI went red purely from
STALENESS — the branch (wave/a2w3-1600-phase2-fusion) is ~12+ commits behind main and the failing
tests are unrelated pre-existing suites (a `db.insert is not a function` harness error), NOT the
coupling-fusion code. Rebase onto current origin/main, re-verify (its frozen eval
eval/build/a2w3-1600-phase2-coupling-fusion.ts must return metric=1.0 + vitest green), then merge
on green. No code changes expected. Do this in an isolated worktree.

Background: a2w-control is standalone; it CONSUMES TempIQ's graph via the insights API (never a
runtime dependency). Owner rejects over-engineering. Journal every step (tenet_journal_write).
```

## Reference (not part of the paste)

**Shipped 2026-07-16:** TempIQ #1611 (Phase 1 world-prior), #1619 + #1626 (hotfixes: max_tokens
truncation, then the sonnet-4-6 prefill 500). First 6BB graph generated (13 edges / 19 zone↔space
/ 12 spaces) and reviewed.

**Owner-confirmed labels already in `twin_edges` (`user_confirmed=true`):** Master Bedroom↔Master
Bathroom (ensuite, different systems), Barn Basement↑Barn-Tack (vertical), Barn-Tack↔Barn Basement
(adjacency), Kitchen Radiant↑Upstairs Bathroom (PARTIAL vertical), Living Room↑Upstairs Baseboard.
Reclassified: Master Bedroom↔Downstairs = system_coupling (not adjacency). Tagged: Living↔Downstairs
= adjacency via downstairs hallway. Floors fixed: master suite = 2nd. Full table lives in TempIQ #1630.

**6BB system clusters (for reference):** Barn Mini-Split (Tack + Basement) · Downstairs+MB Mini-Split
(Downstairs + Master Bedroom — spans floors) · Hydronic A2W (Dining, Kitchen Radiant, Living Room
Baseboard, Master Bathroom, Mud Room, Upstairs Baseboard, Upstairs Bathroom) · Upstairs 4-Zone
(Ally's, Christian's, Upstairs Office, William) · Xmas+Office (Den/Office, Xmas Room).
