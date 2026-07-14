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
