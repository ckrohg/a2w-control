# a2w-planner

The planner service from `knowledge/reference/cross-system-optimization-plan.md`. This is
**Phase A-2: the SensorLinx reader** — later phases add the shadow planner (A-5), the
day-plan solver (§6.2), and the guarded HBX write adapter (Phase C, §5.2).

What it does now (it both **reads** the HBX and — through one guarded path — is the **sole
writer** of the reset curve; see [§Single-writer invariant](#single-writer-invariant) below):

- Polls the HBX ECO-0600 through **`api.sensorlinx.co`** (the app's host — richer than
  the legacy `mobile.` host TempIQ uses) every `POLL_SECONDS` (default 300).
- Stores a narrow reading per poll in **`slx_readings`** (Neon): tank temp, tank target,
  outdoor, heat/cool demand, per-stage call flags, backup call flag, relay bitmask,
  connected.
- Extracts the ~70 configuration parameters (curve, differentials, staging, backup
  triggers, demand modes, schedule) and maintains **`hbx_config_versions`** — an
  append-only history. Row 1 = first observation; every later row = a detected edit with
  `changed_fields` (old → new). This is the §6.6 curve-version/drift tracker.
- **ntfy alerts** (optional): config drift (high priority), reader offline after 5
  consecutive poll failures, and recovery. Same topic the Pi/hub use.
- `GET /health` → `{ok, lastPollAt, lastDriftAt, consecutiveFailures}` (503 when failing).

## Single-writer invariant

**The deployed Railway planner (`a2w-hub` → service `a2w-planner`) is the SOLE authorized
writer of the HBX reset curve.** Every write to `api.sensorlinx.co` goes through one guarded
code path, so every write is envelope-clamped, cross-checked, rate-limited, verified, and
audited. This is the invariant that makes automation safe on a live heat pump (kanban #36).

**One code path — no exceptions:**

```
sensorlinx.ts  patchDevice()        ← the ONLY method that PATCHes the device
      ▲  (called by nothing else)
writes.ts      HbxWriter            ← the ONLY caller: setTarget / boost / restore
      ▲
callers:  • auto-sanitize (index.ts, flag-gated daily soak)
          • autopilot.ts (applies the shadow-plan target, flag-gated)
          • POST /api/hbx/{target,restore,boost}  (bearer-gated HTTP API)
```

Every accepted write, in order: **I4** outdoor-indexed envelope clamp → **I1** cross-check
(each online pump must clear target + margin, or the write is rejected) → 15-min rate limit
(restore exempt) → PATCH with read-back verify → a self-recorded `hbx_config_versions` row
tagged `changed_fields._source` → an audit row in `hbx_writes` for **every** attempt
(accepted *or* rejected). Adoption is asynchronous (next reheat cycle); `status()` reports
commanded-vs-operative.

**Injecting external intent — use the API, never raw SensorLinx.** Anything outside the
planner that wants to move the target (TempIQ, a scheduled agent, a human, a future
integration) MUST call the planner so the guardrails apply:

```
POST /api/hbx/target   {"target_f": 128}     Authorization: Bearer $PLANNER_API_TOKEN
POST /api/hbx/boost    {"target_f": 140, "minutes": 90}
POST /api/hbx/restore
GET  /api/hbx/target                          → writer.status()
```

**Forbidden (these break the invariant):**
- **Any direct-to-SensorLinx script.** The overnight target-write agent that authenticated to
  `api.sensorlinx.co` and PATCHed the curve directly is **RETIRED** — its mechanism is folded
  into `writes.ts` and its function lives in `autopilot.ts` + the API above. Re-running such a
  script bypasses every guardrail (it collided with a planner write 0.4 s apart on 2026-07-16).
- **A second planner instance that writes.** Never run a local/parallel planner with
  `AUTOPILOT_DRY_RUN=0` or `PHASE_B_DRY_RUN=0` against the shared Neon DB. Exactly one instance
  writes; everything else must stay shadow/dry-run.

**Detection.** A foreign write (any writer that isn't this planner) is caught two ways, because
the planner records its *own* writes with a `_source` tag and therefore never self-alerts:
- **Real-time** — the poll loop diffs the device against the last-recorded config *captured
  before this cycle's own writes*; a foreign change to the curve (`dbt`/`mbt`) pages
  **"⚠ Foreign HBX curve write — single-writer invariant"** (high); other foreign edits page
  "HBX config changed (outside the planner)".
- **48-hour surface** — the dashboard chip runs the acceptance query
  `changed_fields IS NOT NULL AND changed_fields->>'_source' IS NULL` over the last 48 h.

*Not* auto-prevented: a rogue second planner instance (it also `_source`-tags, so neither
instance pages). Today's mitigation is operational — one deployed writer. A DB-backed
single-writer **lease** (a blocking guard in `patch()`) is the optional defense-in-depth in
#36; it is deliberately deferred rather than added to the live write path mid-autopilot-rollout.

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `SENSORLINX_EMAIL` / `SENSORLINX_PASSWORD` | yes | SensorLinx account login (JWT lives ~15 min; the client re-logs-in on 401). |
| `DATABASE_URL` | yes | The Neon Postgres (same DB as `analytics-mirror`; tables are additive). |
| `SLX_BUILDING_ID` | no | default `673e25ab8db6198c521700ed` |
| `SLX_SYNC_CODE` | no | default `AECO-2036` |
| `POLL_SECONDS` | no | default `300` |
| `NTFY_TOPIC` / `NTFY_SERVER` | no | alerts off when unset; server defaults to `https://ntfy.sh` |
| `PLANNER_API_TOKEN` | for writes | bearer that gates `POST /api/hbx/*` (and `/api/storm/*`). The ONLY sanctioned way to inject external write intent — see §Single-writer invariant. |
| `PORT` | no | Railway injects it; default 8080 |

## Deploy to Railway

1. In the existing Railway project, **New Service → this repo**, set
   **Root Directory = `planner`** (same pattern as `hub/`).
2. Set service variables: `SENSORLINX_EMAIL`, `SENSORLINX_PASSWORD`, `DATABASE_URL`
   (copy the `POSTGRES_URL` from the Vercel/Neon project), optional `NTFY_TOPIC`.
3. Deploy; check `https://<service>/health`.

## Local dev

```bash
npm install && npm run build
# one-shot poll (no server, exits after one write):
SENSORLINX_EMAIL=... SENSORLINX_PASSWORD=... DATABASE_URL=... POLL_ONCE=1 npm start
```

## Schema

```sql
slx_readings(ts pk, tank_f, tank_target_f, outdoor_f, hd_active, cd_active,
             stages_called boolean[], backup_called, relays int, connected)
hbx_config_versions(id pk, observed_at, changed_fields jsonb, config jsonb)
```

Canonical as-found baseline: `knowledge/reference/hbx-config-asfound-20260713.json`.
Write API (now LIVE — the single guarded writer): `knowledge/reference/hbx-write-api.md`.
See [§Single-writer invariant](#single-writer-invariant).

Deliberate omissions for now: gap backfill via the minute-history endpoint
(`POST .../history/minutes`) and the socket.io push channel — add if 5-min polling ever
proves insufficient.

## Deploys

Git-linked (2026-07-14): pushes to `main` touching `planner/**` auto-deploy this service
on Railway. The hub only redeploys on `hub/**` changes; the Vercel mirror only rebuilds
when `analytics-mirror/` changes. The Pi keeps its deliberate `release-*` tag flow.

## Phase B — the tracking loop (FLAG-OFF)

Built 2026-07-14, dry-run-verified against live data. Every poll cycle, each enrolled
pump's setpoint is driven to (live HBX tank target + 5°F I1 margin), rounded to whole °C,
**leased 90 min** through the hub — a dead planner lapses to the Pi's baseline within the
lease, never a stale value. Renewals are free on the Pi (renew-without-rewrite).

| Env | Meaning |
|---|---|
| `PHASE_B_ENABLED=1` | turn tracking on (default off) |
| `PHASE_B_DRY_RUN=1` | compute + log, send nothing |
| `PHASE_B_PUMPS` | default `pump1,pump2` |
| `PHASE_B_CAP_C` | planner-side cap, default 75 (bridge config clamp — NOT the reg-2027 factory 55; the Pi's live bounds stay authoritative) |

Rollback = unset `PHASE_B_ENABLED` → leases lapse → Pi reverts to `baseline_setpoint_c`.
Gate for enabling (plan §7): two-week telemetry window (~Jul 27) + clean shadow record.

## SPAN backup-element power alarm (`spanwatch.ts`, FLAG-OFF)

Independent safety net for the 16.5 kW backup element: the HBX's `backup_called` flag reports the
controller's *decision* to fire (breaker-independent); this watches the element's *actual* SPAN
circuit power and pages high-priority the moment it draws real watts. **Dormant until `SPAN_URL` is
set** — deploying it changes nothing.

| Env | Meaning |
|---|---|
| `SPAN_URL` | SPAN panel base URL. The planner is on Railway (cloud) and SPAN's API is LAN-local, so expose the panel via a **Cloudflare Tunnel** (the project's existing pattern) and point this at the tunnel. Unset = alarm off. |
| `SPAN_TOKEN` | SPAN local-API bearer token |
| `SPAN_BACKUP_CIRCUIT` | case-insensitive name substring of the element's circuit (default `backup`) |
| `SPAN_BACKUP_ALARM_W` | watts above which it pages (default `100`) |
| `SPAN_POLL_SECONDS` | poll cadence, own timer (default `60`) |

Reads `GET {SPAN_URL}/api/v1/circuits`, matches the circuit by name, edge-alerts on
`instantPowerW > SPAN_BACKUP_ALARM_W`. A read failure never alarms (a tunnel hiccup ≠ the element
running); `backup_called` is the redundant net. This is what makes re-energizing the breaker safe.

## Winter solver — shadow (W0, FLAG-OFF; plan §6.9)

Demand-driven service floors: TempIQ `/api/insights/zones` → per-zone required water
temp (baseboard curve / radiant band) → binding calling zone + 4.5 °F buffer margin →
the shadow plan's winter blocks ride that floor instead of mimicking the HBX curve.
Reasons name the binding zone. Degraded mode (feed stale >30 min) = exactly the old
behavior; A2W never depends on TempIQ to heat the house. Emitter ground truth from the
owner survey is enforced in code until TempIQv2#1508 lands (Living Room→radiant
override + synthetic Xmas Room baseboard zone).

| Env | Meaning |
|---|---|
| `WINTER_SOLVER_SHADOW=1` | enable the demand feed + floor proposals (default off) |
| `TEMPIQ_BASE_URL` / `TEMPIQ_SURFACE_TOKEN` | the insights seam (shared with the pusher) |
| `EMITTER_OVERRIDES` | JSON name→deliveryType map (default empty — owner ID 2026-07-15: TempIQ delivery_types were right) |
| `EMITTER_SYNTHETIC_ZONES` | JSON InsightZone[] (default empty — no missing zones; "Living Room Baseboard" IS the Xmas Room zone) |

Tables: `zone_floor_snapshots` (one row per shadow run when a floor was proposed).
`/health.winter_solver` = off | shadow | degraded.

## Storm mode (W0, NOTIFY-FIRST; plan §6.11)

Triggers: NWS active alerts (point query, 30-min poll) + OpenMeteo 72 h heuristics
(<0 °F, gusts >45 mph ≥3 h, freezing rain ≥2 h, snow ≥8 in) + OutageWatch `/api/status`
(5-min loop; unreachable = no signal, never = outage) + manual. Default posture pages
the owner and shapes NOTHING — set `STORM_MODE_ENABLED=1` to let armed/active windows
raise in-window plan blocks to the storm ceiling (min(HBX curve+3, `STORM_CAP_F`)) —
only-raises, I4 clamp last, hp1 setpoint recomputed.

| Env | Meaning |
|---|---|
| `STORM_MODE_ENABLED=1` | let storm state shape the plan (default off = notify-only) |
| `STORM_CAP_F` | storm ceiling cap, default 135 (lift after Phase B) |
| `OUTAGEWATCH_URL` | default the Railway OutageWatch service |

Manual (authed with `PLANNER_API_TOKEN`): `POST /api/storm/arm {hours}` /
`POST /api/storm/disarm`. Audit: `storm_events`. `/health.storm` = state + trigger.
