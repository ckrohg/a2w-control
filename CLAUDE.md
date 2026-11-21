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

**Stage (reconciled 2026-11-20 against the repo and `knowledge/reference/`; the last live reconciliation is
`knowledge/reference/live-state-20260916.md`):** Phases 0-2 are DONE. The bridge runs on the Pi
against both real pumps; write_enabled was flipped on pump 1 on 2026-07-13 and both pumps are
write-enabled now. The cloud side is live: Railway hub + Railway Postgres (migrated off Neon
2026-08-23, #79) + Vercel dashboard; the Railway deploy config is declared in `.railway/railway.ts` (#164) and
reaches the services only through an owner-run `railway config apply`. **Phase B is ACTIVE** — the planner drives both
pumps' setpoints to track the HBX tank target (the curve in force is `/health.curve.in_force`) on 90-minute leases.
The winter DP solver runs in SHADOW; `demand_forecast` has both gates (`FORECAST_FETCH_ENABLED`,
`FORECAST_PREHEAT_ENABLED`) off by default and drift-check [4] reports their live values. TempIQ push/read are
live (18 zones, 38 spatial edges). Winnie's thread CLOSED 2026-07-14 — nothing is owed either
direction. Dev quickstart in `heatpump-bridge/README.md`.

**Do not trust a doc over `/health`.** This file was ~2 months stale before 2026-09-16, and two months stale
again before 2026-11-20 (a closed issue and a past date in Next). `scripts/drift-check.sh` asserts
declared-vs-live; run it before believing any stage claim, including this one.

**FINDING-1 is CLOSED (armed 2026-10-18).** The revert-to-baseline failsafe is live on the Pi.
`~/bridge-data/config.yaml` has `guardrails.baseline_setpoint_c: 52`, `lease_max_minutes: 180` and
`lease_warn_minutes: 15`, so `check_lease()` runs every tick. Planner `/health.phase_b` reports
`lease Nm armed` per pump. Treat the revert as a SAFETY write: nothing may hold, queue or rate-limit it (see #208).
The live config sits OUTSIDE the repo, so no merge, tag or deploy changes it; edit it on the Pi, back it up first.

**Live safety layer (2026-11-20; verify with `scripts/drift-check.sh` and `/health`, not this list):**
- **HBX `lagT` = 60** (drift-check [9]). At 180 the HBX never added the second pump or the backup, which was the
  Oct 14–16 incident's root cause (`incident-20261016-hp2-e21-investigation.md` §6). Never raise it to save
  element energy; the element is gated by its SPAN breaker ("Buffer Tank", kept OPEN) instead.
- **Self-heal LIVE** on the Pi (`self_heal.live`, `circuits_verified`): power-cycles a pump's SPAN circuit on E21.
  #292 (a blind Pi is blind, not two dead pumps) is on main and reaches the Pi only with the next release tag. The
  **backup-element gate** (planner `BACKUP_GATE`, Pi `backup_fallback`) defaults to SHADOW; promotion is the owner's call.
- **Pump-health** (`planner/src/pumphealth.ts`): a check pages only when named in `PUMP_HEALTH_LIVE`; the owner
  promoted `running_no_lift`, `heating_no_draw` and `idle_draw` (2026-11-04). `defrost_overlong` counts only while its
  HBX stage calls (#286): an idle pump still reporting "defrost" is not a stuck defrost. `/health.pump_health` shows
  which checks are live.
- **Storm mode arms on outage-grade triggers only** (#115/#290, `planner/src/storm.ts`): gusts > 50 mph for ≥ 2 h, an
  NWS High Wind, Blizzard or Ice Storm Warning, freezing rain, ≥ 8 in of snow from one storm, or a grid outage. Cold
  alone never arms it; the reset curve and the winter solver answer cold.
- **6bb also switches SPAN breakers, heating circuits included.** That is the owner's decision; the panel reports
  USER for both systems. A pump switched off by a person is deliberate, not a fault (#212).
- **Alerts:** high/urgent alerts and all-clears push to the owner's phone via 6bb `/api/external/alert`
  (`SIXBB_ALERT_*`; Pi `notifications.sixbb_alert_*`). Email is unchanged. Nobody subscribes to the ntfy topic.
  The lease-revert "planner not commanding setpoints" alert stays record-tier (#191, owner 2026-11-11).
- **SPAN local API v1 is removed 2026-12-31** (#199): the v2 transport (`bridge/span_v2.py`, MQTT eBus) shipped in
  release-20261102-1 pinned to `transport: v1`. The flip to `auto` is a Pi config change
  (`reference/span-v2-local-api.md` step 3); drift-check [10] fails a pinned v1 from 2026-12-15.
- **DB backups** cover the live Railway Postgres 18 again (#203). Restore with `scripts/analyze-local.sh`; on the
  administrator Mac, put `~/micromamba/envs/pg/bin` on PATH first.

**Next (owner plan 2026-11-20):** #294–#297 are on main; #298 (the DHW pre-boost survives the winter guard) landed
2026-11-20 — verify its deploy on `/health`. PR #293 (#180, branch `owner/planner-handover-180`) is still open: it changes
the Railway start command from `npm start` to `node dist/index.js` so the planner hears SIGTERM and releases the writer
lease. It changes nothing until the owner runs `railway config apply` (planned Mon 2026-11-23; `.railway/railway.ts`);
until then every planner deploy is a writer-lease handover of 600 s or more. Tue 2026-11-24: the Pi gets Ethernet (its
Wi-Fi is −79 dBm, `incident-20261016-hp2-e21-investigation.md`) and one release tag, after which `span.transport: auto`
goes live on the Pi (#199). Then the winter backlog: #89 TempIQ/local required-supply divergence, #87 winter DP v2,
#76 comm degradation. The forecast shadow sequence (`FORECAST_FETCH_ENABLED=1` → ≥2 weeks of real cold →
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
- **More than one agent merges here — both follow the gate (owner, 2026-10-30).** Two agents on two
  Macs act on this repo as `ckrohg`. Every merge that deploys the planner or the hub goes through
  `scripts/deploy-gate.sh merge <pr>`, whichever agent does it; none goes through `gh pr merge` or the
  web UI directly. Right before merging, re-read `git log origin/main` since the PR's base and the open
  PR list for overlapping work (two cold-room alerts landed 35 min apart on 2026-10-30: TempIQv2#2136 and
  #2142; the second was removed in #2144), and re-check the PR's state: the other agent may already have
  merged, closed or superseded it.

**Key traps:** W610 transparent mode = RTU framing over TCP, not Modbus TCP. P17 anti-freeze is normal, never an alert-worthy error. Write guardrails (handoff §6.4) before any write path is exposed. SensorLinx's reported tank target (`temp1.target`, `slx_readings.tank_target_f`) is a snapshot that freezes while the HBX is idle — after a soak/bank lowering it reads the OLD target for 7–16 h while the device is on the new curve; the curve in force (`/health.curve.in_force`) is the operative target (`knowledge/reference/stale-slx-target-2026-10-19.md`). Railway never reads `.railway/railway.ts` on a push: only `railway config apply` changes the services, and it redeploys BOTH (run `railway config plan` first). The bridge's `Store` guards its sqlite3 connection with a `threading.Lock`, not only an asyncio.Lock — every `to_thread` worker must take `_thread_lock` or two event loops segfault the process (#94, `tests/test_store_two_loops.py`).

Owner rejects over-engineering — right-sized solutions first (SQLite, single process, Cloudflare Tunnel).

## Relationship to TempIQ

- **NEVER edit TempIQv2** (`~/Documents/Claude/TempIQv2`) — it is a reference library only. Read it, learn from it, copy patterns from it (HBX read/write, SPAN panel power ingestion). No writes, no shared runtime dependencies in v1.
- A2W Control is a **standalone platform**. Future integration (TempIQ setting heat pump targets, or feeding signals so A2W decides) arrives as an API consumer of the existing endpoints — never as a coupling that makes A2W depend on TempIQ to function. See `knowledge/reference/tempiq-borrowables.md` for the catalog of borrowable code.
