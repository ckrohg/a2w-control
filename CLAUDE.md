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

**A2W Control** — custom IoT control bridge for 2× Arctic (Guangdong Macon MAHRW030ZA/BEH2) air-to-water heat pumps in southern NH. Personal infrastructure project, not a startup — ignore GTM/brand framing.

**Read first, in order:**
1. `knowledge/reference/heatpump-bridge-handoff.md` — complete build spec. Hardware architecture and stack decisions are SETTLED; do not redesign or propose alternatives.
2. `knowledge/reference/modbus-register-map.md` — distilled register map (source of truth: `A2W Modbus.docx` same folder, from Winnie @ Guangdong Macon)
3. `knowledge/PRODUCT_SPEC.md` + `knowledge/ROADMAP.md` — working summaries

**Stage:** Phase 0 (simulator-first). Build the `heatpump-bridge/` repo per handoff §6.2 against simulated pumps. No hardware dependency. Phase 1 is gated on Winnie's CN22/pinout reply (emailed 2026-07-04).

**Key traps:** W610 transparent mode = RTU framing over TCP, not Modbus TCP. P17 anti-freeze is normal, never an alert-worthy error. Write guardrails (handoff §6.4) before any write path is exposed.

Owner rejects over-engineering — right-sized solutions first (SQLite, single process, Cloudflare Tunnel).

## Relationship to TempIQ

- **NEVER edit TempIQv2** (`~/Documents/Claude/TempIQv2`) — it is a reference library only. Read it, learn from it, copy patterns from it (HBX read/write, SPAN panel power ingestion). No writes, no shared runtime dependencies in v1.
- A2W Control is a **standalone platform**. Future integration (TempIQ setting heat pump targets, or feeding signals so A2W decides) arrives as an API consumer of the existing endpoints — never as a coupling that makes A2W depend on TempIQ to function. See `knowledge/reference/tempiq-borrowables.md` for the catalog of borrowable code.
