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

**A2W Control** — custom IoT control bridge for 2× Arctic (Guangdong Macon MAHRW030ZA/BEH2) air-to-water heat pumps at 6 Black Brook Rd, South Hamilton, MA (North Shore; DOE climate zone 5A — same house as TempIQ / 6bb-solar / OutageWatch). Personal infrastructure project, not a startup — ignore GTM/brand framing.

**Read first, in order:**
1. `knowledge/reference/heatpump-bridge-handoff.md` — complete build spec. Hardware architecture and stack decisions are SETTLED; do not redesign or propose alternatives.
2. `knowledge/reference/modbus-register-map.md` — distilled register map (source of truth: `A2W Modbus.docx` same folder, from Winnie @ Guangdong Macon)
3. `knowledge/PRODUCT_SPEC.md` + `knowledge/ROADMAP.md` — working summaries

**Stage (reconciled 2026-09-16 against the RUNNING system — see
`knowledge/reference/live-state-20260916.md`):** Phases 0-2 are DONE. The bridge runs on the Pi
against both real pumps; write_enabled was flipped on pump 1 on 2026-07-13 and both pumps are
write-enabled now. The cloud side is live: Railway hub + Railway Postgres (migrated off Neon
2026-08-23, #79) + Vercel dashboard. **Phase B is ACTIVE** — the planner drives both pumps'
setpoints to track the HBX tank target (52–63 °C in Oct 2026) on 90-minute leases. The winter DP
solver runs in SHADOW; `demand_forecast` is idle with both gates off. TempIQ push/read are
live (18 zones, 38 spatial edges). Winnie's thread CLOSED 2026-07-14 — nothing is owed either
direction. Dev quickstart in `heatpump-bridge/README.md`.

**Do not trust a doc over `/health`.** This file was ~2 months stale before 2026-09-16, and so
was ROADMAP.md. `scripts/drift-check.sh` now asserts declared-vs-live; run it before believing
any stage claim, including this one.

**FINDING-1 is CLOSED (armed 2026-10-18).** The revert-to-baseline failsafe is live on the Pi.
`~/bridge-data/config.yaml` has `guardrails.baseline_setpoint_c: 52`, `lease_max_minutes: 180` and
`lease_warn_minutes: 15`, so `check_lease()` runs every tick. Planner `/health.phase_b` reports
`lease Nm armed` per pump. Treat the revert as a SAFETY write: nothing may hold, queue or rate-limit it (see #208).
The live config sits OUTSIDE the repo, so no merge, tag or deploy changes it; edit it on the Pi, back it up first.

**Live safety layer (2026-10-19; verify with `scripts/drift-check.sh` and `/health`, not this list):**
- **HBX `lagT` = 60** (drift-check [9]). At 180 the HBX never added the second pump or the backup, which was the
  Oct 14–16 incident's root cause (`incident-20261016-hp2-e21-investigation.md` §6). Never raise it to save
  element energy; the element is gated by its SPAN breaker ("Buffer Tank", kept OPEN) instead.
- **Self-heal LIVE** on the Pi (`self_heal.live`, `circuits_verified`): power-cycles a pump's SPAN circuit on E21.
  The **backup-element gate** (planner `BACKUP_GATE`, Pi `backup_fallback`) and **pump-health** checks run in SHADOW.
  Promotion is the owner's call.
- **6bb also switches SPAN breakers, heating circuits included.** That is the owner's decision; the panel reports
  USER for both systems. A pump switched off by a person is deliberate, not a fault (#212).
- **Alerts:** high/urgent alerts and all-clears push to the owner's phone via 6bb `/api/external/alert`
  (`SIXBB_ALERT_*`; Pi `notifications.sixbb_alert_*`). Email is unchanged. Nobody subscribes to the ntfy topic.
- **SPAN local API v1 is removed 2026-12-31** (#199): migrate `span_local` to v2 in November.
- **DB backups** cover the live Railway Postgres 18 again (#203). Restore with `scripts/analyze-local.sh`; on the
  administrator Mac, put `~/micromamba/envs/pg/bin` on PATH first.

**Next:** the Pi gets Ethernet about 2026-10-26; its Wi-Fi is −79 dBm and causes the remaining dropouts. Then the
winter backlog: #89 TempIQ/local required-supply divergence, #87 winter DP v2, #76 comm degradation, #94 bridge-tests
segfault. The forecast shadow sequence (`FORECAST_FETCH_ENABLED=1` → ≥2 weeks of real cold →
`FORECAST_PREHEAT_ENABLED=1`, per `reference/winter-dp-commissioning.md`) is WEATHER-gated, not work-gated.

**Working rules (added 2026-09-16 after the Pi went offline mid-session — see
`knowledge/reference/incident-20260916-pi-offline.md`):**

- **Merge deploying PRs ONE AT A TIME, verified.** Use `scripts/deploy-gate.sh merge <pr>`: it
  refuses to merge from an unhealthy baseline, waits for the deploy, and re-verifies. Anything
  touching `planner/` or `hub/` redeploys a live service controlling this house's heat. Docs,
  CI and `knowledge/` PRs are inert (watchPatterns) and can land freely.
- **Never run analysis queries against the production database.** Use
  `scripts/analyze-local.sh` to restore the newest encrypted backup locally and query that.
  Same schema, same history, zero load on the box the house's telemetry ingests into.
- **Never cut a `release-*` tag on the owner's behalf.** That is the ONLY path to the Pi, and
  it is deliberately a human step (fusion audit risk 4).
- **A burst of merges destroys attribution.** The point of serialising is not that a merge is
  likely to break something — it is that without a known-good bracket you cannot answer "did we
  cause this?" with anything better than a guess. On home-heating infrastructure that is the
  difference that matters.

**Key traps:** W610 transparent mode = RTU framing over TCP, not Modbus TCP. P17 anti-freeze is normal, never an alert-worthy error. Write guardrails (handoff §6.4) before any write path is exposed.

Owner rejects over-engineering — right-sized solutions first (SQLite, single process, Cloudflare Tunnel).

## Relationship to TempIQ

- **NEVER edit TempIQv2** (`~/Documents/Claude/TempIQv2`) — it is a reference library only. Read it, learn from it, copy patterns from it (HBX read/write, SPAN panel power ingestion). No writes, no shared runtime dependencies in v1.
- A2W Control is a **standalone platform**. Future integration (TempIQ setting heat pump targets, or feeding signals so A2W decides) arrives as an API consumer of the existing endpoints — never as a coupling that makes A2W depend on TempIQ to function. See `knowledge/reference/tempiq-borrowables.md` for the catalog of borrowable code.
