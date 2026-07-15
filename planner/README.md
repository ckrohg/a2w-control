# a2w-planner

The planner service from `knowledge/reference/cross-system-optimization-plan.md`. This is
**Phase A-2: the SensorLinx reader** — later phases add the shadow planner (A-5), the
day-plan solver (§6.2), and the guarded HBX write adapter (Phase C, §5.2).

What it does now (READ-ONLY — this service never writes to SensorLinx):

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

## Environment variables

| Var | Required | Notes |
|---|---|---|
| `SENSORLINX_EMAIL` / `SENSORLINX_PASSWORD` | yes | SensorLinx account login (JWT lives ~15 min; the client re-logs-in on 401). |
| `DATABASE_URL` | yes | The Neon Postgres (same DB as `analytics-mirror`; tables are additive). |
| `SLX_BUILDING_ID` | no | default `673e25ab8db6198c521700ed` |
| `SLX_SYNC_CODE` | no | default `AECO-2036` |
| `POLL_SECONDS` | no | default `300` |
| `NTFY_TOPIC` / `NTFY_SERVER` | no | alerts off when unset; server defaults to `https://ntfy.sh` |
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
Write API (Phase C, not used here): `knowledge/reference/hbx-write-api.md`.

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
| `EMITTER_OVERRIDES` | JSON name→deliveryType map (default carries the survey) |
| `EMITTER_SYNTHETIC_ZONES` | JSON InsightZone[] (default: the invisible Xmas Room loop) |

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
