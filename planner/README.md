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

## Demand-floor cadence (#136)

The demand floor used to be computed once per shadow cycle (60 min) and escalate +6 °F per **cycle**;
a zone starting to call at :05 waited up to an hour, then climbed at one step per hour. Now `pollOnce`
runs `floorReCheckOnce` every `POLL_SECONDS` before Phase B: refresh the feed, advance each zone's
**unbroken-calling minutes** by the elapsed time (capped at 15 min so a telemetry gap is not credited),
propose the floor at the current outdoor, and if it exceeds the plan's current block by
`FLOOR_RAISE_MIN_F` (3) raise that block **in place** (`store.raiseLatestPlanBlock`: raises only, band-
clamped, never over a soak, only below the winter guard where the hourly plan applies the floor; a bank /
pre-boost it overtakes loses its flag — one identity per block). Phase B and the auto-pilot read the plan
on the same poll, so the pump setpoints lead and the write follows within the 15-minute write rate limit.
Escalation is `ESCALATE_STEP_F` per elapsed **hour** after a free first hour — identical slope to the old
per-cycle rule at a 60-minute cadence, unchanged by the 5-minute one (the issue's prerequisite). The
hourly replan (DP, bank, soak, storm, pre-boost) is untouched; downward moves only ever happen there.
`/health.demand_floor_cadence` shows the last check, floor vs block, the decision, and the raises in 24 h.

## DHW pre-boost (#135)

The flat 120 °F DHW floor does not hold a hard draw: measured 2026-08-07, evening showers sagged the
tank to 102–117 °F with both pumps at full call, and the 16.5 kW backup element paid for the shortfall
(~21 kWh/week at COP 1.0). `lagT` 60 → 180 only made the element slower to join; the shortfall stayed.

The plan now anticipates it. The learner's floor windows (threshold 25 % of days, padded ±1 h) cover
nearly the whole day on this house (`[[0,21],[22,24]]` from 137 draws in 15 d), so the boost is keyed
to the **peak** draw windows instead — hours where ≥ 50 % of observed days had a draw, unpadded
(`dhw.ts peakWindows`). For each peak the same tank history yields the window's draw **sag** — pre-draw level minus the trough in the next 60 min, per draw,
p75 over the window (`measureWindowSags`). When a window has ≥ 6 measured draws (so the p75 is never one
sample) and a sag ≥ 3 °F, the warmest non-window hour in the `prechargeLookbackH` lead is raised to
`dhwFloorF + min(sag p75, 12) + 2.4 °F × hours of standby before the bell` (capped at `strictCapF`; if
the allowance would breach the cap the hour right before the window is used instead). A soak or bank
already in the lead hours IS the pre-boost — none is added. The trough scan stops at a telemetry gap,
and in winter a zone call can read as a draw: the 6-draw floor and the 12 °F cap bound that. Reason: `pre-boost to 126°F for 17:00 window (sag p75
6.2°F over 11 draws; …)`. It is an excursion like the bank: Phase B leads the pump setpoints off it (I1),
the auto-pilot writes it as a flat target under the shaped curve, the identification driver treats it as
a plan conflict, and the TempIQ window poster files it as `bank`. `/health.dhw.windows[]` shows the
measurement behind every peak (and `floor_windows` the padded ones) (draws, sag p75/median, pre-draw and trough medians, `boost_f`), and
the plan's `meta.pre_boosts` records what was applied. Raises only — a pre-boost can never make a
shower colder. Acceptance (#135): evening-window troughs ≥ `dhwFloorF` on normal days, element minutes
attributable to DHW sags → ~0 without relying on `lagT`, whole-system daily kWh not up.

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

- **Second instance** — each planner heartbeats an id (`hostname:pid`) into `planner_instances`
  every poll; if a *second* live instance persists across two polls (the 2-poll grace absorbs a
  rolling redeploy's container overlap) the planner pages **"⚠ Second planner instance detected
  — single-writer at risk"** (high) and clears when solo again. This is **non-blocking** — it
  can never wedge the real writer. `/health.instance` exposes the current id + peers.

A DB-backed single-writer **lease** — a *blocking* guard in `patch()` that stops a second
instance from writing at all — is **built and flag-gated (`WRITER_LEASE_ENABLED`, default off).**
When enabled, each poll the planner renews or claims a singleton `hbx_writer_lease` row (takeover
on stale, so a redeploy reclaims it), and `patch()` refuses any write (`423`) unless this instance
holds a fresh lease. It ships **off** because a stale-lease bug could wedge the sole writer — arm
it deliberately (ideally at the #34 go-live) and confirm takeover works on the first redeploy.
`/health.writer_lease` shows the current holder.

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
| `WRITER_LEASE_ENABLED` | no | `1` arms the blocking single-writer lease (default off) — see §Single-writer invariant. |
| `TEMPIQ_WINDOWS_ENABLED` | no | `1` posts our commanded-target episodes to TempIQ as quarantine windows (a2w#137; needs `TEMPIQ_SURFACE_TOKEN`). Default off. |
| `TEMPIQ_WINDOWS_EVERY_MIN` | no | poster cadence, default `5` |
| `IDENTIFICATION_ENABLED` | no | `1` constructs the identification driver (needs autopilot, Phase B, the winter-solver feed, the hub and `TEMPIQ_SURFACE_TOKEN`). Default off. |
| `IDENTIFICATION_MODE` | no | seeds `controller_flags.identification_mode`: `off` (default) \| `shadow` (decide + draw + log, write nothing) \| `armed`. Runtime switch: dashboard Optimize page or `POST /api/identification`. |
| `SHAPED_CURVE` | no | `1` makes the auto-pilot command the plan's demand-shaped reset curve for non-excursion hours (#133 b) so the HBX weather-compensates on its own between writes and after a planner death. `shadow` computes and stamps the curve and reports it at `/health.curve.plan_implies` (with `would_write`) but writes nothing — the step before `1` on a live auto-pilot. Default off = the flat per-hour target. |
| `FLOOR_CADENCE` | no | `0` disables the per-poll demand-floor re-check (#136). Default on: every poll the floor is recomputed and, if it exceeds the plan's current block by ≥ 3 °F (below the winter guard, never over a soak, band-clamped), the block is raised in place so Phase B leads it and the auto-pilot writes it on the same poll. Raises only. Escalation is per elapsed HOUR of unbroken calling (was per cycle), so the cadence change does not steepen it. `/health.demand_floor_cadence`. |
| *(forecast cache)* | — | The hourly plan reads open-meteo; on failure (HTTP 429 after a deploy burst) it reuses the last good forecast (`forecast_cache`, ≤ 6 h old, past hours trimmed) so the plan and the demand floor still refresh. `/health.forecast.source` = `live` \| `cached`; the plan's `meta.forecast_source` records which. No cache → the hour fails as before. |
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

> 2026-09-29: Railway created no deployment for the #142 merge (657cd8a) — the docs push that
> followed it minutes later was evaluated instead and SKIPPED ("no changes to watched files").
> When a planner merge shows no deployment in `railway deployment list -s a2w-planner`, a
> follow-up commit under `planner/**` (this note) is the sanctioned nudge — merged through
> `scripts/deploy-gate.sh` like any other deploying change.


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
controller's *decision* to fire (breaker-independent); this confirms the element's *actual* draw via
the **SPAN cloud API** (SRP login — same path TempIQ uses, **no tunnel**). **Dormant until
`SPAN_USERNAME` is set** — deploying it changes nothing.

| Env | Meaning |
|---|---|
| `SPAN_USERNAME` | SPAN app login (email). Unset = alarm off. |
| `SPAN_PASSWORD` | SPAN app password. SRP auth via `amazon-cognito-identity-js`. |
| `SPAN_BACKUP_CIRCUIT` | case-insensitive name substring of the element's circuit (default `backup`); if it doesn't match, the first poll logs the available circuit names |
| `SPAN_BACKUP_ALARM_KWH` | this-hour energy above which it pages (default `0.3`; a 16.5 kW element hits 0.3 kWh in ~65 s, an idle circuit reads ~0) |
| `SPAN_BUILDING_ID` | optional; auto-discovered from the account if unset |
| `SPAN_POLL_SECONDS` | poll cadence, own timer (default `60`) |

Auths with Cognito, polls each circuit's current-hour energy (`GET_CURRENT_HOUR_ENERGY`), edge-alerts
when the backup circuit's this-hour kWh exceeds the threshold. **~1 h detection latency** (SPAN's
hourly energy aggregation) — fine here: the element runs for hours, and `backup_called` is the instant
signal. A read/auth failure never alarms (transient); `backup_called` is the redundant net. This is
what makes re-energizing the breaker safe. Standalone — A2W's own SPAN login (pattern copied from
TempIQ's `span-cloud.ts`, no runtime coupling).

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

## TempIQ perturbation windows (a2w#137, FLAG-OFF)

`tempiq-windows.ts` tells TempIQ WHEN we were driving the buffer, so its passive thermal
learners quarantine those hours instead of fitting our perturbation as the house behaving
(TempIQ's U4 fitted the as-found tank temperature back as a zone "requirement" from exactly
this contamination — TempIQv2#2043; their half is `awt_perturbation_windows` +
`POST /api/insights/experiment-windows`, TempIQv2#2050).

Grain is one window per commanded-target **episode**: opens at an accepted `set_target`
(autopilot / dashboard / boost all funnel through `writes.ts`), closes at the next event that
replaces the curve — our next accepted `set_target` or `restore`, or a **foreign** dbt/mbt
change the drift detector recorded. The device holds our curve through a planner outage, so an
open window (`endedAt: null`, "active until now") is the honest state, not a gap. Kind names
what a learner must treat differently — `autopilot | sanitize | storm | bank` from the plan
reason, `storm | boost | manual` for dashboard writes — and every window carries the dose
(`commandedTargetF`, mean `achievedAwtF`, adoption `compliance`, outdoor band, calling zones).

**Every window is quarantine-only (`assignment: null`).** None of these writes is a randomised
probe — the autopilot raises the target *because* zones are calling — so TempIQ must never fit
them as exogenous; the identification arm is a separate driver (gtm#1616 A/B). Phase B is not
posted: it tracks the tank target and adds no independent AWT perturbation.

Idempotent and durable: `tempiq_window_posts` remembers what was posted and which windows are
open; the July→now backfill drains in ≤500-window batches on the first ticks, then each tick
posts only new episodes and newly-closable ones. Fail-soft like every TempIQ hop — a POST
failure logs, counts a streak and retries; a per-window validation rejection is recorded and
not retried. `/status.tempiq_windows` reports it. Local proof of the four queries against a
synthetic history: `scripts/tempiq-windows-local-check.ts` (localhost only, never prod).

## Identification driver (gtm#1616 / #137, FLAG-OFF)

`identify.ts` runs **randomised** supply-water probes so TempIQ's U4 can *measure* each zone's
required water temperature instead of reading a textbook curve. Passive variation is endogenous
(the buffer sags because demand is high — TempIQv2#2043), so the only fittable evidence is a
deliberately drawn, labelled perturbation. TempIQ owns the statistics
(`GET /api/insights/identification-plan`: which zone × outdoor band, which direction, how big,
whether it is safe — TempIQv2#2051); this module owns the actuator and the guardrails.

One window at a time, drawn not scheduled: pick the top safe, owner-verified cell whose band is
the current outdoor → draw against `assignmentProbability` (a **probe** arm or a **hold** arm — the
hold is recorded too; it is U4's control evidence at the base level) → for an up-probe, publish
the target to Phase B so the setpoints **lead** it (I1 would otherwise reject the write) → write
through `writer.setTarget` with the identification ceiling (owner decision 2026-09-29: probes may
exceed the everyday 135 °F cap up to `sanitizeCapF` 145; I1 + the rate limit still guard) → the
auto-pilot is **held** for the window → abort checks every poll (I1 violated, room deficit on a
down-probe, DHW draw on a down-probe, hub/SLX stale, storm, boost) → on the window's end the hold
is released and the auto-pilot re-commands its plan. A down-probe abort **restores the as-found
curve immediately** (the one write the rate limit never blocks; hotter is the safe direction).

Windows persist in `identification_windows` (restart-safe) and are posted to TempIQ as kind
`awt_identification` **with the drawn assignment** — the only kind U4 may fit. The quarantine
poster skips `identification` writes so the same minutes are not also filed as manual quarantine.
`/status.identification` and `/health.identification` report mode, plan, and the open window;
`controller_status.identification_*` feeds the dashboard. Assertions: `identify.test.ts`.
## Demand-shaped reset curve (#133 b, FLAG-OFF)

`setTarget` emulates a fixed target with a near-flat line, so a dead planner leaves the tank at
one number all winter — the as-found weather compensation is gone (#133). With `SHAPED_CURVE=1`
the auto-pilot commands a **demand-shaped curve** for non-excursion hours instead: `curve.ts`
`shapeCurve()` puts the design point `dot` at (coldest outdoor in the next 24 h of forecast − 10 °F,
bounded to [5, wwsd − 20]) with `dbt` = demand there (binding calling zone + buffer margin, floored
by the DHW floor, clamped to the I4 envelope at that outdoor) and `mbt` = the floor at `wwsd`;
`wwsd` is never moved (it shuts heating off above it). The design point moves because the I4 lower
bound pins any 5 °F endpoint at 135 °F, and that line runs 11 °F hot at 35 °F — a COP tax every
mild day. The HBX then compensates on its own between planner writes and after a planner death;
below the design point it holds `dbt` (a bounded under-service only in a snap colder than
forecast − 10 °F while the planner is *also* dead).

`writer.setCurve()` guards I4 at **both** endpoints and I1 against the curve's **output** at the
live outdoor; `restore()` puts the as-found `dot` back too. Phase B leads
`max(curve output now, curve output at the next block's forecast outdoor)` (`curveLeadF`), not a
commanded scalar. Excursions — bank, sanitize, storm, boost, pre-charge, identification probes — stay
flat-target writes on top of the curve; the next non-excursion hour re-commands the curve.
`/health.curve` reports the curve **in force** (endpoints + output at the live outdoor) and the
curve the latest plan implies. Assertions: `curve.test.ts`.

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

## Identification driver ↔ TempIQ experiment calendar (gtm#1618 / #153)

Right before **every** draw, and again right before an open window's first write or a retried write, the driver asks
`GET /api/insights/probe-interlock?horizonMin=<probe duration + abort latency>` on TempIQ. A listed hydronic zone,
`blockAll: true`, a non-200 (a 404 reads "endpoint not deployed on TempIQ yet"), a malformed body or a 3 s timeout
all mean **no draw** — fail closed, with the reason in `/health.identification.lastResult`. Shadow asks too, so the
shadow ledger shows what armed would have done. A window the interlock refused before anything was commanded is
ended as `interlock:…`, is never posted to TempIQ, and never starts the 60-min cooldown (only windows that
happened do — a hold arm, a probe whose write was accepted, or in shadow a shadow window). That cooldown rule
lives in SQL; `scripts/identify-cooldown-local-check.ts` proves it against a local Postgres — it TRUNCATEs
`identification_windows`, so it refuses any URL other than the dedicated `a2w_local` database on a loopback host:

```sh
LOCAL_DATABASE_URL=postgres://$(whoami)@localhost:5432/a2w_local npx tsx ../scripts/identify-cooldown-local-check.ts
```

## Observability added by the 2026-09-30 eval (F4 / F6 / §10.10)

- `/health.dhw.last_pre_boost` — `{at, toF, reason, result}` of the last #135 pre-boost block the auto-pilot reached
  (`set` | `would-set` | `rate-limited` | `rejected: …` | `held` — already commanded within tolerance, or an
  identification hold); null until the first boost hour. Answers "did this morning's boost fire, and if not why?"
  without a prod query.
- `/health.curve.in_force.shaped` now means "the plan's shaped curve is the one the device holds" (the auto-pilot's own
  four-field predicate), not `dbt − mbt > 4`; `spread_f` keeps the spread visible.
- `/health.phase_b.fail_streak` — consecutive write failures per pump (the ntfy page fires at 3; this says how long).
- `scripts/identification-mode.sh [off|shadow|armed]` — read or set the identification driver's mode on the live planner
  with the bearer read from Railway (never printed). Arming pages ntfy at "high".

## Cold-day rehearsal (`scripts/rehearsal/`)

Runs the **real planner** (`POLL_ONCE=1`, three polls) against a **local** Postgres with every upstream faked
— SensorLinx (device read + PATCH echo), the hub (state + leased commands), TempIQ (zones, calls,
identification plan, posts), open-meteo, NWS, OutageWatch — from a scenario JSON, then asserts what the
planner *did* (DB ledgers + the fake's request log), not what it logged.

```sh
scripts/rehearsal/run.sh cold-morning     # 22 °F falling to 12 °F, two zones calling, leases armed
scripts/rehearsal/run.sh warm-evening     # 62 °F, nothing calling, device already at 120 → must write NOTHING
```

**Hour-independent by construction** (eval 2026-09-30, F1): the plan's daily 140 °F soak goes to the warmest
*remaining* hour of the local day, so a falling forecast run in the late afternoon would put the soak on the current
block — the driver then refuses to draw beside it and the demand floor rides the soak's 145 °F ceiling; the harness
passed at 01:00 and failed at 17:30 on the same planner. The fake now shapes the served forecast
(`scripts/rehearsal/forecast-shape.ts`): the local day holding the hour 4 h from now has its warmest hour at or after
that hour (a +0.5 °F nudge, logged in `fake.log` as `forecastShape`), and a day with < 6 blocks left gets no soak.
The rule looks only at the blocks the planner can hold (its 24-block slice, plus the served history hour the
planner keeps at exactly xx:00), so a warmer hour beyond the horizon never suppresses the nudge. The fake also
formats each served hour in the HOUSE's zone (`HOUSE_TZ`, pinned to `America/New_York` by `run.sh`) **with its UTC
offset**, never the host's zone and never offset-less: on a Mac set to Pacific time the fake wrote 14:00 (PDT) and
the planner read 14:00 EDT, shifting the forecast, the soak hour and the DHW windows 3 h off the real clock, and an
offset-less string names the fall-back hour twice. The three-poll sequence (plan → act → draw) is therefore the same
at any time of day and on any host; the DST hours are covered by the shaping test's instant round-trips, not by a
rehearsal run on those days.

Requires a local Postgres on :5432 (the DB `a2w_rehearsal` is dropped and recreated). Nothing reaches
production: the DB must be localhost, `SLX_BASE_URL` / `OPEN_METEO_URL` / `NWS_URL` / `HUB_URL` /
`TEMPIQ_BASE_URL` all point at the fake, and ntfy / Resend / SPAN stay unset. Poll 1 plans (a virgin DB has
no plan), poll 2 writes the floor (the driver idles: base not at plan), poll 3 draws an identification window
on the settled base. Add a scenario by copying `scenarios/cold-morning.json`; the `expect` block drives
`assert.ts`. The first run of this harness found the driver drawing a hold arm at the device's stale target
before the auto-pilot had written a freshly raised floor (fixed in `identify.ts`: the base must sit within
`MIN_STEP_F` of the plan's current block).
