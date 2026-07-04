# TENET — a2w-control

You are in a TENET workspace. Every session, use these tools:

**Start:** `tenet_context` — get project state, recent journals, team activity
**Work:** `tenet_journal_write` — record every feature, decision, fix, discovery (mandatory)
**Check:** `tenet_memory_search` — search past decisions before making new ones
**Skills:** `/skill <name>` — load specialized instructions on demand

## Journal Protocol

Write journal entries AS YOU WORK, not at session end. Each entry needs:
- type: feature | decision | fix | discovery
- title: short description
- summary: 2-3 sentences
- files: relevant paths
- next: what should happen next

## Rules

- Journal every significant action — no exceptions
- Every code file gets a `@purpose` header comment
- Search memory before making architectural decisions
- Use `/skill` to load domain expertise — don't guess

## Current Focus
Building a new product from scratch. Start by filling in knowledge/VISION.md — what are you building and why? Then use /skill startup for stage assessment, /skill brand-architect for identity, /skill spec for technical spec.

Pinned skills: `startup`, `brand-architect`, `spec`. Run `/skill` for more.
