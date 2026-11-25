# a2w-planner

The planner service from `knowledge/reference/cross-system-optimization-plan.md`, deployed on
Railway as `a2w-planner` and **live in the control path**. Every `POLL_SECONDS` it reads the HBX
ECO-0600 through `api.sensorlinx.co`, stores the reading and any configuration drift in the shared
Railway Postgres, and pages on drift or on going offline (`index.ts`). It is also the **sole
guarded writer** of the HBX reset curve (`writes.ts`, plan §5.2): a target is commanded by
PATCHing a valid near-flat curve (or, with `SHAPED_CURVE=1`, the plan's demand-shaped curve), and
every write passes the I4 envelope clamp, the I1 cross-check against the live pump setpoints, the
15-minute rate limit, a response-echo verify, a self-recorded config version and an audit row —
see [§Single-writer invariant](#single-writer-invariant). Two control loops ride on that: the
**auto-pilot** (`autopilot.ts`) drives the HBX buffer target to the shadow plan's current block
through the writer, and **Phase B** (`phaseb.ts`) drives both pumps' setpoints through the hub to
lead the operative target on 90-minute leases, so a dead planner lapses back to the Pi's baseline
rather than leaving a stale optimizer value — see [§Phase B](#phase-b--the-tracking-loop-live).

What the reader half does every poll:

- Polls the HBX ECO-0600 through **`api.sensorlinx.co`** (the app's host — richer than
  the legacy `mobile.` host TempIQ uses) every `POLL_SECONDS` (default 300).
- Stores a narrow reading per poll in **`slx_readings`** (Railway Postgres): tank temp, tank
  target, outdoor, heat/cool demand, per-stage call flags, backup call flag, relay bitmask,
  connected.
- Extracts the ~70 configuration parameters (curve, differentials, staging, backup
  triggers, demand modes, schedule) and maintains **`hbx_config_versions`** — an
  append-only history. Row 1 = first observation; every later row = a detected edit with
  `changed_fields` (old → new). This is the §6.6 curve-version/drift tracker.
- **Alerts** (ntfy, Resend email and the 6bb phone push, chosen by tier — see
  `alertpolicy.ts`): config drift, reader offline after 5 consecutive poll failures, and recovery.
- `GET /health` (503 after 5 consecutive poll failures) emits these top-level keys:
  `ok`, `lastPollAt`, `lastDriftAt`, `lastShadowAt`, `consecutiveFailures`, `unserved`, `span`,
  `pump_health`, `backup_gate`, `pi`, `drift`, `forecast`, `instance`, `tz`, `writer_lease`, `i1`,
  `tempiq_push`, `tempiq_read`, `tempiq_windows`, `identification`, `curve`, `phase_b`,
  `demand_floor_cadence`, `winter_solver`, `winter_dp`, `demand_forecast`, `thermal`, `storm`,
  `dhw`, `hygiene`. The sections below say what each one carries.

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

## Per-stage unserved alarm (#185) and the other 2026-10-16 incident fixes

**Per-stage alarm (`stagewatch.ts`).** The all-idle alarm ("⚠ Heat call active but NO pump is
running") pages only when *no* pump heats, so a one-unit failure is invisible while the other unit
carries — or idles uncalled. On Oct 16 00:30–00:54 ET the HBX called stage 2 only, HP2 was FAULT
(E21) and HP1 sat idle: the HBX stages by dry contact, does not know a unit is faulted, and with
rotation ON waits `lagT` (180 min) before adding the lag stage. Now, every poll, for each called
stage:
- **stage_unserved** — its mapped pump is not `heating` after a **10-min** start grace of called
  time. The clock is **suspended while that pump defrosts** and never runs on unverifiable hub
  state (#167: hub unreachable, Pi disconnected, stale frame). Pages **high** (emails), naming the
  unit, its state, any fault code, and the other stage/unit ("HP1 is not called — the HBX waits up
  to lagT (180 min)…").
- **fault_called** — its mapped pump's LIVE derived state is `fault`: an **immediate** high page. The
  code is added from the mirror's `pump_snapshots` when that snapshot is ≤ 15 min old (the hub frame
  carries only a count, which includes info-level protections like P17 anti-freeze — never a page).

Both are edge-triggered and persisted in `alert_episodes` — an OUTBOX: a page is marked notified only
when a channel acknowledged it, and unacknowledged ones are re-sent every loop tick (even while
SensorLinx is failing) and after a restart; open episodes are re-adopted at boot (they close, never
re-page). `/health.unserved {all_idle, stage_pump_map, stages, episodes_24h, lag_t_min}`. A gap of
more than 15 min between polls credits no called time. The all-idle alarm is unchanged.

**`STAGE_PUMP_MAP`** (env, JSON, default `{"1":"pump1","2":"pump2"}`) is the **physical wiring**
from each HBX stage relay to the heat pump it starts — not a preference. Verify it at the panel
before trusting the alarm: with the HBX in its stage test (or on a real call), close stage 1 alone
and confirm which unit's wall controller shows a demand, then stage 2; or trace the dry-contact pair
from the HBX stage-1 terminals to the unit's remote on/off input. If the units turn out swapped, set
`STAGE_PUMP_MAP={"1":"pump2","2":"pump1"}` (the hub's pump ids). It must map every stage 1..N
(N ≥ 2) to a DISTINCT pump; anything else falls back to the default and says so at
`/health.unserved.stage_pump_map_error`.

**`dmd` is not configuration (#182).** It is a live demand bitmask (1 ↔ 9 ↔ 41, nine flips in two
days); it left `CONFIG_FIELDS`, and the drift diff compares only `CONFIG_FIELDS`, so a dmd flip
makes no version row and no "HBX config changed" page (the false 12:00 AM banner of Oct 16).

**Storm rows close (#183, planner half).** Stand-down closes **every** open `storm_events` row, and
every planner start (the storm machine always starts idle) closes any row still open with
`detail.closed = "planner restart while idle"`. An orphan ends at its own `windowEnd`, not today,
so the TempIQ window classifier's storm lookup does not stretch it over the weeks it sat open. (The
mirror banner is driven separately.)

**SPAN-local heartbeat (#187, `spanlocal.ts`).** `/health.span {local_table,
local_last_reading_age_s, circuits_seen, local_stale, cloud{enabled, last_ok_at, fail_streak,
last_error, backup_kwh_last_hour, backup_kwh_today, backup_alarmed}}` — the newest `span_readings` sample per circuit (the Pi's LAN poller, the path every
SPAN safety action depends on), at any age, beside `spanwatch.ts`'s cloud state, with `computed_at`
and `refresh_error`. A **high** page, edge-triggered (same outbox), when the local stream is older than
**15 min**, and a resolved notice on recovery; the cloud failing alone shows here but never pages. It
runs every loop tick, independent of the SensorLinx poll. `scripts/drift-check.sh` [8] asserts local age ≤ 900 s.

SQL proven by `scripts/incident-local-check.ts` (local Postgres only).

## Pump health — running but not doing its job (SHADOW; `pumphealth.ts`)

Every existing alarm keys on a fault code (`fault_called`, self-heal) or on a pump not running while called
(`stage_unserved`, all-idle). This watches the opposite case: a pump that runs or draws power and makes no heat.
Thresholds come from 97 days of Pi data plus the Postgres restore (for the tank), recorded in `knowledge/reference/pump-health-baseline-20261019.md`.

| check | trips when |
|---|---|
| `running_no_lift` | 15 min of steady heating at ≥ 1 kW with mean outlet−inlet ΔT < 1.5 °C (measured minimum 3.4 °C) |
| `heating_no_draw` | reports heating ≥ 7 min while the SPAN circuit's 5-min mean is < 1 kW (measured minimum 2.85 kW) |
| `idle_draw` | reports idle/off ≥ 10 min while the circuit's 9-min mean is > 1 kW (measured maximum 672 W) |
| `defrost_overlong` | reports defrost continuously for > 20 min. Normal is 4–9 min. stagewatch suspends its clock in defrost, so pump1's 83-min stuck "defrost" on 2026-10-18 paged nothing |
| `called_tank_flat` | a stage is called and its pump is engaged (heating or defrost) ≥ 90 % of 45 min, the tank's net rise plus standby loss is ≤ 2 °F **and** the unit's mean ΔT over it is < 1.5 °C, held for 30 min. A flat tank alone is house load: a healthy single pump at ≤ 45 °F routinely loses ground (measured, doc §5) |
| `stage_never_called` | #172: the tank sits more than 3 °F under the **curve in force** (not SensorLinx's `tank_target_f`, which freezes while the HBX idles) at every HBX poll for 2 h, and a stage is never called. Judged for every stage in `STAGE_PUMP_MAP` (HBX rotation lets either lead), one verdict per stage's pump. Not judged while either pump is deliberately switched off (#212) or when a curve change in the window lowered the target by > 3 °F (a setback); stale or gappy HBX data, or an unknown curve, is "unknown" |

Data comes from the mirror's `readings` and `span_readings`. SPAN consumption is negative, so the checks use its
magnitude. Gating follows stagewatch: no live Pi frame, or no measured Pi clock offset, means nothing moves. A stale
or gappy window is `unknown`, and `unknown` never opens or closes an episode.

Episodes go to `alert_episodes` as `shadow_pump_<check>`. They are logged, never paged, and the paging outbox's
re-send query excludes them. A daily rollup per pump goes to `pump_health_daily`: SPAN kWh, runtime, starts and max
per hour, defrost count and minutes, mean ΔT, and a lift index (ΔT·h/kWh) per 5 °C outdoor bin. From that, the 7-day
pool is compared with the pump's own prior 14 days in the same bin (flag at ≤ −20 %; measured noise max 12.7 %) and
with its twin's learned ratio (the twins sit ~16 % apart). One digest email goes out per day. Everything is on
`/health.pump_health` and the dashboard's Pump health card.

| env | default | |
|---|---|---|
| `PUMP_HEALTH_ENABLED` | on | `0` turns the checks and rollup off |
| `PUMP_HEALTH_LIVE` | empty | comma list of checks to **promote to paging** (owner decision, per check) |
| `PUMP_SPAN_CIRCUITS` | `{"pump1":"Air-Water 1","pump2":"Air-Water 2"}` | pump → SPAN circuit (the owner-confirmed self-heal map) |
| `PUMP_HEALTH_DIGEST` / `PUMP_HEALTH_DIGEST_HOUR` | on / `7` | the daily email, sent after this America/New_York hour |

SQL proof on a local Postgres: `LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_pumphealth npx tsx ../scripts/pump-health-local-check.ts`.
Re-measure the tank check on a local restore: `LOCAL_DATABASE_URL=postgres://localhost:5432/a2w_local npx tsx ../scripts/pump-health-tank-measure.ts 97`.

## Pi link — `/health.pi` (#165)

Answers "which failure was that dropout?" from tables the planner already shares with the analytics
mirror, without the house network. Every 10 min (off the request path; `/health` serves the cached
result with its ages advanced) `pilink.ts` turns the last 7 days into:

- **dropout windows** — maximal runs of Phase B `failed: no Pi connected` in `phase_b_log` (both
  pumps; a run ends at the next `sent`; lease skips and other failures neither extend nor end it);
- a **verdict per window** from the mirror's own tables, read-only: `gap+reboot` (the Pi's 60-s
  exporter — a path that bypasses the hub — went silent too, *and* `system_stats` shows a fresh boot
  within ±10 min: the WiFi stall the bridge-watchdog's 120-min reboot cleared), `gap_only` (silent,
  no reboot), `socket_only` (readings kept arriving; only the hub socket dropped), `unknown` (no
  readings before the window, or the tables are absent — e.g. the rehearsal DB);
- `last_reading_age_s` (+ per pump), `uptime_s`, `reboots_24h` / `reboots_7d` / `last_reboot_at`
  (a reboot = the boot time `ts − uptime_s` jumping forward by > 5 min), and a `summary`.

**The clock rule.** Windows are planner-clock; the evidence is Pi-clock. Every poll the planner
measures the Pi clock against its own (planner now − the hub frame's Pi time) and records it in
`pi_clock_observations` (9 days). A verdict stands only if an aligned observation (≤ 2 min) lies
within 30 min before the window and another within 30 min after it (an open window: a fresh aligned
live offset), no misaligned observation lies between them, and no clock event (a step seen in
system_stats, a re-stamped span seen in readings' ingestion order, future-stamped rows) does either;
otherwise `unknown`. A reboot is counted only when uptime fell, the new boot track persists 15 min,
readings were flowing at its would-be origin, and it is outside any re-stamped span. Right after
the deploy (no observations yet) windows read `unknown`. `/health.pi.pi_clock` shows the counts and
the last observation.

The two SQL reductions (readings gaps > 5 min, uptime resets) run in `store.piLinkInputs`; the
weekly digest shows a tile with this beside the hub's own counters (`pi_dropouts_*`, #178), which
reset on a hub redeploy — the two sources should corroborate. Proven on a synthetic week by
`scripts/pi-health-local-check.ts` (local Postgres only).

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

**Restore goes to the plan, not to July (#232).** A boost expiry (`expireBoosts`, every poll) and
`POST /api/hbx/restore` return the plant to what the auto-pilot commands for the block in force
*right now* (`AutoPilot.planCommand` → `planCommandForBlock`: the shaped curve on a curve hour, the
flat excursion target under its identity's cap otherwise), through the same I4 / I1 / lease guards,
rate-limit exempt. The auto-pilot's next tick then reads "already commanded", so the 15-min rate
limit never holds the plan off. The July as-found endpoints (`hbx_config_versions` row 1, ≈ 158 °F at
46 °F outdoor — an I1 violation against 52 °C setpoints that Phase B would chase to the 140 °F cap)
are written only when nothing of the plan is being commanded (no auto-pilot, Off/shadow, no plan
block) or on an explicit `{"to":"as-found"}`. A refused plan restore (I1 short, Pi unverifiable, no
lease) throws instead of falling back: the device keeps the boost's own guarded target and the next
poll retries. The identification driver's cleanup (`identify.ts`) takes the same plan restore once its
guarded base re-command is refused (most often a 429 inside 15 min of the probe write); only an *abort*
whose plan restore is refused too falls back to the as-found curve, by name, because an abort must end
with a landed write — a window that ended normally stays pending and retries instead.

**Deploy handover (#162, #180).** Railway SIGTERMs the old container while the new one is already up.
`shutdown.ts` logs the signal synchronously on its first line (`[shutdown] SIGTERM received at …;
loops=… leaseOps=… writesOnWire=…`), raises the write barrier, releases the writer lease the moment no
device PATCH is on the wire (never over one), drains running polls and lease ops, releases again if a
late renew re-claimed the row, marks its `planner_instances` row with the outcome, and exits 0 inside a
12 s hard exit (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS=20` on the service). The successor's first log
lines report its predecessor (`still running … normal during a rolling deploy`, since Railway signals the old
container only after the new one is healthy), and it reports again the moment it acquires the lease
(`[handover] predecessor … released the writer lease`). The lease is never released while an HBX PATCH or a
pump-setpoint / breaker command to the Pi (hub.ts) is on the wire. Proof on a real deploy: `[shutdown] SIGTERM
received at` in the OLD container and `writer lease acquired … after N s waiting` with N under ~30 in the new one. This only
works if the signal reaches node: the Railway start command must be `node dist/index.js`, not
`npm start` — with npm as PID 1 every deploy from #163 to #287 logged nothing and waited out the full
600–700 s staleness window (#180). `scripts/drift-check.sh` [11] asserts the declared start command, and
`scripts/rehearsal/handover.sh` rehearses the whole handover against a local Postgres.

**Injecting external intent — use the API, never raw SensorLinx.** Anything outside the
planner that wants to move the target (TempIQ, a scheduled agent, a human, a future
integration) MUST call the planner so the guardrails apply:

```
POST /api/hbx/target   {"target_f": 128}     Authorization: Bearer $PLANNER_API_TOKEN
POST /api/hbx/boost    {"target_f": 140, "minutes": 90}
POST /api/hbx/restore                        → the plan's command for the block in force (#232)
POST /api/hbx/restore  {"to": "as-found"}    → the July as-found endpoints, unguarded (emergency only)
GET  /api/hbx/target                          → writer.status()
```

**Forbidden (these break the invariant):**
- **Any direct-to-SensorLinx script.** The overnight target-write agent that authenticated to
  `api.sensorlinx.co` and PATCHed the curve directly is **RETIRED** — its mechanism is folded
  into `writes.ts` and its function lives in `autopilot.ts` + the API above. Re-running such a
  script bypasses every guardrail (it collided with a planner write 0.4 s apart on 2026-07-16).
- **A second planner instance that writes.** Never run a local/parallel planner with
  `AUTOPILOT_DRY_RUN=0` or `PHASE_B_DRY_RUN=0` against the shared Railway Postgres. Exactly one
  instance writes; everything else must stay shadow/dry-run.

**Detection.** A foreign write (any writer that isn't this planner) is caught two ways, because
the planner records its *own* writes with a `_source` tag and therefore never self-alerts:
- **Real-time** — the poll loop diffs the device against the last-recorded config *captured
  before this cycle's own writes*; a foreign change to the curve (`dbt`/`mbt`) pages
  **"⚠ Foreign HBX curve write — single-writer invariant"** (high); other foreign edits page
  "HBX config changed (outside the planner)".
- **Self-diagnosing curve alert (#177).** A `dbt`/`mbt` diff is re-read after ~30 s and pages only
  if it persists (a revert records both reads with `verdict = reverted`, `changed_fields` NULL, no
  page; a re-read that fails or is cut short by SIGTERM pages nobody and never advances the
  baseline — the next poll, or the successor's first, sees the same diff and re-checks. A failed
  re-read leaves an `unconfirmed` evidence row whose config is the unchanged baseline, and if the
  next poll no longer sees the change, a default-priority "HBX curve change seen once, could not be
  confirmed" notice carries the evidence; if not even that row can be written, the poll fails —
  as a failed device read does — so no controller overwrites the curve before it is kept). Every query run under the device lock uses a small pool
  with connect, statement and query timeouts, so a stalled database releases the lock. The re-read → record runs
  under the same in-process device lock as the writer's PATCH → self-record, so a dashboard write
  can never land between them. It is then compared with the planner's own accepted writes (`hbx_writes.requested`) in the
  previous 60 min: when **every** changed curve field is within **2 °F** of a value the planner
  wrote to that field, the verdict is `echo_suspected` and it pages at **default** priority (with
  email) as **"HBX curve differs from our write (possible device/cloud transform)"** — no
  single-writer claim. Otherwise the verdict is `foreign` and today's high page stands. Both pages
  carry the evidence: before/after values, the re-read, the nearest planner-written values, the
  planner's last write with its PATCH echo (`hbx_writes.response`), and the device's own provenance
  (`changeSource`, `updatedAt`, …). Every `hbx_config_versions` row stores the full device object in
  `raw` (and `reread_raw`, `verdict`, `diagnosis` for curve events). `/health.drift.last_foreign`
  gives `{at, fields, planner_last_write, reread_confirmed, verdict}`. Prompted by the two
  2026-10-18 pages (120/118 → 141/137 and → 129/125), each 1 °F under the planner's own preceding
  flat band.
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

Every variable the planner reads (`process.env` across `planner/src`, plus the rehearsal harness
under `scripts/rehearsal`), grouped by subsystem. "Default" is what the code does when the
variable is unset; it is not what production has set. Four flags only **seed** the
`controller_flags` row on first boot (`AUTOPILOT_DRY_RUN`, `PHASE_B_DRY_RUN`,
`AUTO_SANITIZE_ENABLED`, `IDENTIFICATION_MODE`): afterwards the dashboard's Optimize page owns
them and a changed env value does not clobber the live choice. The dashboard's Off/Armed switch
(`POST /api/autonomy`) is one switch for two loops: `off` sets `controller_flags.autopilot_dry_run`
**and** `phaseb_dry_run`, `arm` clears both. The code's run-time truth is `/health`, never this
table — with one exception: `/health.phase_b.mode` echoes the `PHASE_B_DRY_RUN` seed, not the
switch, so it still reads `active` while the switch is Off. The live dry-run state is in the
per-pump `/health.phase_b.lastResults` strings and in the `controller_status` row the planner
heartbeats every poll (§Phase B).

### Core — SensorLinx reader, database, process

| Var | Default | Meaning |
|---|---|---|
| `SENSORLINX_EMAIL` | **required** | SensorLinx account login (JWT lives ~15 min; the client re-logs-in on 401). |
| `SENSORLINX_PASSWORD` | **required** | SensorLinx account password. |
| `DATABASE_URL` | **required** | The Railway Postgres (same DB as `analytics-mirror`; tables are additive). |
| `SLX_BASE_URL` | `https://api.sensorlinx.co` | SensorLinx host; the rehearsal points it at the fake. |
| `SLX_BUILDING_ID` | `673e25ab8db6198c521700ed` | SensorLinx building id. |
| `SLX_SYNC_CODE` | `AECO-2036` | The HBX device's sync code. |
| `POLL_SECONDS` | `300` | Poll cadence; Phase B, stagewatch and the floor re-check run on it. |
| `POLL_ONCE` | unset | `1` = one-shot run (poll, then the hourly chain: shadow → score → decay → realized, plus the side tasks), then exit; the rehearsal's mode. Fails fast on a broken DB. |
| `PORT` | `8080` | HTTP port; Railway injects it. |
| `TZ` | unset | Must be `America/New_York` in production: the DHW windows and storm parsing rely on local time. Reported at `/health.tz` and asserted by `scripts/drift-check.sh` [2c]. |
| `LAT` | `42.63` | Forecast / NWS point latitude. |
| `LON` | `-70.87` | Forecast / NWS point longitude. |

### Alerts

| Var | Default | Meaning |
|---|---|---|
| `NTFY_TOPIC` | unset | ntfy topic; unset = no ntfy. Priority only sets ntfy loudness — email and the phone push are chosen by tier (`alertpolicy.ts`). |
| `NTFY_SERVER` | `https://ntfy.sh` | ntfy server. |
| `RESEND_API_KEY` | empty | Resend key for email-tier alerts; empty = no email. |
| `RESEND_TO` | empty | Email recipient. |
| `RESEND_FROM` | `A2W Alerts <onboarding@resend.dev>` | Email sender. |
| `SIXBB_ALERT_URL` | empty | The 6bb app's `/api/external/alert` for the owner's phone push (page-tier alerts + their all-clears). No-op unless both 6bb vars are set. |
| `SIXBB_ALERT_KEY` | empty | Token for that endpoint. |

### Hub, Pi and the HTTP API

| Var | Default | Meaning |
|---|---|---|
| `HUB_URL` | unset | The Railway hub. Without both hub vars the I1 monitor, Phase B, pump health, the backup gate, the identification driver and the TempIQ pusher are disabled. |
| `HUB_CLIENT_TOKEN` | unset | Bearer for the hub's planner-side API. |
| `HUB_ARM_TOKEN` | empty | Bearer for hub breaker commands; required only for `BACKUP_GATE=live`. |
| `PLANNER_API_TOKEN` | unset | Bearer that gates `POST /api/hbx/*`, `/api/storm/*`, `/api/autonomy`, `/api/identification`, `/api/sanitize` and `/api/tempiq/cop-refetch`. Unset = write API disabled. The ONLY sanctioned way to inject external write intent — see §Single-writer invariant. |
| `PLANNER_READ_TOKEN` | unset | READ-ONLY bearer for the 6bb home app (#190) — opens `GET /api/status` and nothing else; see §Read-only status. Unset = that route is a plain 404, as before. Equal to another planner secret = the route stays 404 and an error is logged. |
| `WRITER_LEASE_ENABLED` | off | `1` arms the blocking single-writer lease: `patch()` refuses (423) and Phase B skips unless this instance holds the fresh `hbx_writer_lease` row — see §Single-writer invariant. |

### Phase B — pump setpoint tracking

| Var | Default | Meaning |
|---|---|---|
| `PHASE_B_ENABLED` | off | `1` constructs the tracking loop (needs the hub). Production runs with it on — see §Phase B. |
| `PHASE_B_DRY_RUN` | off | `1` seeds the loop as compute-and-log, send nothing. Seed only: the dashboard Off/Armed switch owns `controller_flags.phaseb_dry_run` afterwards — and that switch is shared with the auto-pilot (Off sets `autopilot_dry_run` too). Also decides what `/health.phase_b.mode` reports, regardless of the switch. |
| `PHASE_B_PUMPS` | `pump1,pump2` | Hub pump ids that are tracked. |
| `PHASE_B_CAP_C` | `75` | Planner-side setpoint cap in °C (the bridge config clamp, not the reg-2027 factory 55; the Pi's live bounds stay authoritative). The floor, 45 °C, is a constant. |

### Auto-pilot, plan and hygiene

| Var | Default | Meaning |
|---|---|---|
| `AUTOPILOT_ENABLED` | off | `1` constructs the auto-pilot: drives the HBX target to the shadow plan's current block through the guarded writer. |
| `AUTOPILOT_DRY_RUN` | off | `1` seeds the auto-pilot as log-only. Seed only, like `PHASE_B_DRY_RUN`; the same dashboard Off/Armed switch owns both afterwards. |
| `SHAPED_CURVE` | off | `1` (or `live`) makes the auto-pilot command the plan's demand-shaped reset curve for non-excursion hours (#133 b) and Phase B lead its output. `shadow` computes, stamps and reports the curve at `/health.curve.plan_implies` (with `would_write`) but writes nothing. Off = the flat per-hour target. |
| `AUTO_SANITIZE_ENABLED` | off | `1` seeds `controller_flags.auto_sanitize`: checkI8 fires one guarded `boost(131, 60)` per overdue soak. Seed only; `POST /api/sanitize` owns it afterwards. |
| `HYGIENE_MAX_INTERVAL_H` | `26` | Rolling window in which the tank must have held a real pasteurizing dwell (I8). Hard-capped at 72 h in `hygiene.ts`. |
| `HYGIENE_SUMMER_INTERVAL_H` | = the base interval | The I8 interval in the cool-tank regime (outdoor ≥ 55 °F). |
| `BANK_F` | `0` | #58 afternoon bank: raise the day's warmest-hour block to `dhwFloor + BANK_F`. Clamped to 0–15; 0 = off. |
| `DHW_FLOOR_F` | `120` | DHW-ready floor, which also sets the idle target. Clamped to 112–125; unparseable = 120. `/health.dhw.floor_f`. |
| `DHW_SHOWER_WINDOWS` | unset | Owner-declared shower windows, `HH:MM-HH:MM,…` local time, added to the learned pre-boost peaks. A declared start always opens a window, the hour before it is kept free so that window's boost lands there, and learned peaks that end before the first declared start get no boost (learned `[2,6]`,`[7,13]` + `06:00-10:00` → `[6,13]`: one boost, at 05:00, none at night). Declare the earliest showers of the day. `/health.dhw.shower_windows`. |
| `WINTER_DP_ENABLED` | off | `1` lets the winter DP solve raise commanded targets. The solve itself always runs in shadow when the forecast dips below 55 °F (`/health.winter_dp`). |
| `FLOOR_CADENCE` | on | `0` disables the per-poll demand-floor re-check (#136). On: a floor ≥ 3 °F above the plan's current block raises that block in place, raises only. `/health.demand_floor_cadence`. |
| `SHADOW_EVERY_MIN` | `60` | Shadow-plan cadence; also sets the demand feed's "healthy" window (cadence + 5 min, at least 35). |
| `STAGE_PUMP_MAP` | `{"1":"pump1","2":"pump2"}` | JSON map of HBX stage relay → hub pump id. The PHYSICAL wiring the per-stage unserved alarm (#185) checks against — verify it at the panel (§Per-stage unserved alarm). |

### TempIQ, demand and identification

| Var | Default | Meaning |
|---|---|---|
| `TEMPIQ_BASE_URL` | `https://tempiq.vercel.app` | The TempIQ insights seam (push, read, windows, demand feed, forecast, identification plan). |
| `TEMPIQ_SURFACE_TOKEN` | unset | Bearer for that seam; every TempIQ-facing feature below is disabled without it. |
| `TEMPIQ_PUSH_ENABLED` | off | `1` pushes hub state to TempIQ (§A-7; needs the hub). |
| `TEMPIQ_PUSH_EVERY_MIN` | `5` | Pusher cadence. |
| `TEMPIQ_READ_ENABLED` | off | `1` reads TempIQ zone insights (§6.7). |
| `TEMPIQ_READ_EVERY_MIN` | `60` | Reader cadence. |
| `COP_OVERLAP_DAYS` | `3` | How far behind the newest mirrored TempIQ COP point each hourly read re-reads (upsert) — see §TempIQ COP mirror. `0` is the pre-TempIQv2#2124 cursor and misses every completed row. |
| `TEMPIQ_WINDOWS_ENABLED` | off | `1` posts our commanded-target episodes to TempIQ as quarantine windows (a2w#137). |
| `TEMPIQ_WINDOWS_EVERY_MIN` | `5` | Window-poster cadence. |
| `WINTER_SOLVER_SHADOW` | off | `1` enables the demand feed + floor proposals (plan §6.9); off = the plan mimics the HBX curve. |
| `DEMAND_FLOOR_POLICY` | `escalate` | `escalate` (local model is the floor, TempIQ only a ceiling) \| `learned` (consume TempIQ's number outright, pre-#90) \| `local` (ignore TempIQ's number). |
| `FORECAST_FETCH_ENABLED` | off | `1` fetches TempIQ's required-supply forecast and records what it would do (#87). |
| `FORECAST_PREHEAT_ENABLED` | off | `1` lets that forecast raise a commanded target; needs FETCH. |
| `ADJACENCY_SETBACK_SHADOW` | off | `1` logs what the floor would be if warm-adjacent zones borrowed heat (#33). Shadow only. |
| `ADJACENCY_CREDIT_F` | `3` | Credit per warm neighbour in that shadow. |
| `ADJACENCY_MIN_CONF` | `0.7` | Minimum spatial-edge confidence in that shadow. |
| `EMITTER_OVERRIDES` | `{}` | JSON zone name → deliveryType overrides for TempIQ's zone list. |
| `EMITTER_SYNTHETIC_ZONES` | `[]` | JSON InsightZone[] added to TempIQ's zone list. |
| `IDENTIFICATION_ENABLED` | off | `1` constructs the identification driver (needs the auto-pilot, Phase B, the demand feed, the hub and the token). |
| `IDENTIFICATION_MODE` | `off` | Seeds `controller_flags.identification_mode`: `off` \| `shadow` \| `armed`. Runtime switch: dashboard Optimize page, `POST /api/identification` or `scripts/identification-mode.sh`. |

### Weather and storm

| Var | Default | Meaning |
|---|---|---|
| `OPEN_METEO_URL` | `https://api.open-meteo.com` | Forecast host (plan + storm heuristics); the rehearsal points it at the fake. |
| `NWS_URL` | `https://api.weather.gov` | NWS active-alerts host. |
| `OUTAGEWATCH_URL` | the Railway OutageWatch service | Outage status feed for storm mode and the generator-aware supply check (#241). |
| `STORM_MODE_ENABLED` | off | `1` lets armed/active storm windows shape the plan; off = notify-only. |
| `STORM_CAP_F` | `135` | Storm ceiling cap. |
| `STORM_STEP_F` | `10` | Pre-charge step above the curve target (owner decision 2026-09-25; `3` restores the earlier behaviour). |

### SPAN cloud watch and pump health

| Var | Default | Meaning |
|---|---|---|
| `SPAN_USERNAME` | unset | SPAN app login; unset = the cloud backup-element alarm and pump-energy metering are off. |
| `SPAN_PASSWORD` | empty | SPAN app password (SRP via Cognito). |
| `SPAN_BACKUP_CIRCUIT` | `backup` | Case-insensitive name substring of the element's circuit. |
| `SPAN_BACKUP_ALARM_KWH` | `0.3` | Trailing-60-min energy above which the element alarm pages. |
| `SPAN_BUILDING_ID` | unset | Optional; auto-discovered from the account. |
| `SPAN_POLL_SECONDS` | `60` | SPAN cloud poll cadence. |
| `SPAN_PUMP_CIRCUITS` | `air-water` | Name substring of the compressor circuits summed into `span_energy` for realized savings. |
| `PUMP_HEALTH_ENABLED` | on | `0` turns the pump-health checks and rollup off. |
| `PUMP_HEALTH_LIVE` | empty | Comma list of pump-health checks promoted to paging. |
| `PUMP_SPAN_CIRCUITS` | `{"pump1":"Air-Water 1","pump2":"Air-Water 2"}` | JSON pump → SPAN circuit name. |
| `PUMP_HEALTH_DIGEST` | on | `0` turns the daily pump-health email off. |
| `PUMP_HEALTH_DIGEST_HOUR` | `7` | America/New_York hour after which the digest is sent. |

### Backup-element gate and generator mode (`backupgate.ts`, `generator.ts`)

| Var | Default | Meaning |
|---|---|---|
| `BACKUP_GATE` | `shadow` | `off` \| `shadow` (virtual breaker, logged) \| `live` (closes the Buffer Tank breaker through the hub; needs `HUB_ARM_TOKEN`). |
| `BACKUP_GATE_REOPEN` | off | `1` lets a live gate re-open the breaker (also needs `span.backup_reopen` on the Pi). |
| `BACKUP_GATE_FLOOR_F` | `100` | Tank floor below which the gate closes (90–115). |
| `BACKUP_GATE_FLOOR_MIN` | `30` | Minutes the tank must sit under the floor (10–120). |
| `BACKUP_GATE_DEFICIT_F` | `10` | Target − tank deficit for the failed-not-recovering rule (4–20). |
| `BACKUP_GATE_FAIL_HOLD_MIN` | `90` | Minutes that deficit must hold (60–240). |
| `GEN_CAP_KW` | `20` | Generator capacity for the whole house (15–40; #241 — the Kohler 20RESA, owner 2026-11-02). |
| `GEN_MARGIN_KW` | `2.4` | Headroom kept under that cap (0–8). |
| `COMFORT_EXCLUDE_ZONES` | `Barn - Tack,Barn Basement` | Comma list of TempIQ zones left out of the 60 °F comfort check; replaces the default list. |

### Realized savings

| Var | Default | Meaning |
|---|---|---|
| `ELECTRIC_RATE_USD_KWH` | `0.30` | Tariff for the measured per-day ledger. |
| `DAILY_KWH_BASELINE` | `11.8` | Daily kWh fallback when SPAN metering is absent. |
| `STANDBY_UA_BTU` | `25` | Tank standing-loss UA (BTU/h·°F). |
| `REALIZED_LOOKBACK_DAYS` | `45` | Local days recomputed every hour (capped at the 2026-07-16 cutover). |

### Rehearsal harness only (`scripts/rehearsal/*.ts`)

`inject-boost.ts` also reads the planner's own `DATABASE_URL`, `SLX_BASE_URL` and `HUB_URL` (each
must be local), plus `SENSORLINX_*`, `HUB_CLIENT_TOKEN` and `SLX_BUILDING_ID` with rehearsal defaults.

| Var | Default | Meaning |
|---|---|---|
| `LOCAL_DATABASE_URL` | empty | The local rehearsal DB `assert.ts` checks; must be loopback. |
| `REHEARSAL_OUT` | — | Output directory for a run's artefacts (set by `run.sh`). |
| `REHEARSAL_SCENARIO` | `scenarios/cold-morning.json` | Scenario file for the fake upstreams and the assertions. |
| `REHEARSAL_SHAPED_CURVE_MODE` | unset | The run's `SHAPED_CURVE` mode for `assert.ts` (set by `run.sh`); `live` selects the shaped-curve assertions. |
| `REHEARSAL_PORT` | `9101` | Port of the fake-upstream server. |
| `REHEARSAL_LOG` | `out/requests.jsonl` | The fake's request log. |
| `SLX_SYNC_CODE` | `FAKE-0001` | The fake device's sync code (the planner side above uses the same name). |
| `TZ` | `America/New_York` | The house zone the fake formats forecast hours in; `UTC` is treated as unset. |

**Forecast cache (no variable).** The hourly plan reads open-meteo; on failure (HTTP 429 after a
deploy burst) it reuses the last good forecast (`forecast_cache`, ≤ 6 h old, past hours trimmed)
so the plan and the demand floor still refresh. `/health.forecast.source` = `live` \| `cached`;
the plan's `meta.forecast_source` records which. No cache → the hour fails as before.

## Read-only status for the 6bb app (#190, `readstatus.ts`)

`GET /api/status` with `Authorization: Bearer $PLANNER_READ_TOKEN` (HEAD too) feeds the 6bb Heating card:

```json
{ "backup":   { "called": false, "spanBufferTankKwhLastHour": 0.02 },
  "failsafe": { "armed": true, "leaseUntil": "2026-11-01T14:30:00.000Z" },
  "thermal":  { "at": "…", "tank_f": 128, "tank_target_f": 130, "outdoor_f": 31, "setpoints_f": {}, "dhw_floor_f": 120, "dhw_ready": true, "coast_h": 9.1, "tank_ua": 0.04 },
  "storm":    { "state": "idle", "trigger": null, "windowEnd": null, "enabled": false, "lastTriggerPollAt": "…" },
  "outageSignal": "ok" }
```

- `backup.called` is the HBX's own backup-element call at the last poll; `spanBufferTankKwhLastHour` is the SPAN cloud
  reading of the element circuit over the trailing 60 min (`null` while `SPAN_USERNAME` is unset).
- `failsafe.armed`: `true` the Pi shows a live revert lease on every pump in `PHASE_B_PUMPS`, `false` any pump has none or
  an expired one, or a write landed and the Pi showed none (FINDING-1), `null` Phase B off or no pump seen yet;
  `leaseUntil` is the earliest expiry across the pumps, `null` if any has none.
- `thermal` and `storm` are exactly `/health.thermal` and `/health.storm`. `outageSignal` is `unavailable` when the 6bb
  outage feed has not answered recently, whether supply reads `unknown` or the grid is only assumed (generator.ts), else
  `ok`.

Reads cached state only — no DB, hub or SensorLinx call, no side effect, no secrets. Answers: `200`; `401` for no,
empty or wrong bearer (including `PLANNER_API_TOKEN`); `405` for any other method. The read token opens no other route
and `PLANNER_API_TOKEN` does not open this one. While `PLANNER_READ_TOKEN` is unset the route is the planner's usual
empty `404`. If it equals another planner secret (`PLANNER_API_TOKEN`, `HUB_CLIENT_TOKEN`, `HUB_ARM_TOKEN`,
`TEMPIQ_SURFACE_TOKEN`, `SIXBB_ALERT_KEY`, `RESEND_API_KEY`, `SENSORLINX_PASSWORD`, `SPAN_PASSWORD`, `DATABASE_URL`) the
planner logs `ERROR: PLANNER_READ_TOKEN equals …` and keeps the route at 404 — it does **not** exit, because it controls
the house. The token is trimmed at startup, before the clash check and matching. Generate it with
`openssl rand -hex 32`. The hub's read-only side is `HUB_READONLY_TOKEN` (hub/README.md).

## Deploy to Railway

1. In the existing Railway project, **New Service → this repo**, set
   **Root Directory = `planner`** (same pattern as `hub/`).
2. Set service variables: `SENSORLINX_EMAIL`, `SENSORLINX_PASSWORD`, `DATABASE_URL`
   (reference the Railway Postgres service in the same project), `TZ=America/New_York`,
   `HUB_URL` / `HUB_CLIENT_TOKEN`, `PLANNER_API_TOKEN`, and the alert channels.
   *Historical note:* until 2026-08-23 the planner and the mirror shared a Neon Postgres
   (`DATABASE_URL` was the Vercel project's `POSTGRES_URL`); the migration to Railway Postgres
   was #79.
3. Deploy; check `https://<service>/health`. A deploying change goes through
   `scripts/deploy-gate.sh` (root README) — one at a time, verified.

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

## Phase B — the tracking loop (LIVE)

**Phase B is ACTIVE on both pumps** (root `CLAUDE.md`, reconciled against the running system
2026-09-16). `/health.phase_b.mode` reads `active` whenever `PHASE_B_DRY_RUN` is unset in the
environment — it is the env seed, not the live switch, and stays `active` after the dashboard's
Off switch has put Phase B in shadow. Whether a pump is actually being written is told by its
`/health.phase_b.lastResults` entry (`ok … (lease …m armed)` versus `DRY-RUN would send …`) and
by the `controller_status` heartbeat row the dashboard reads. Built 2026-07-14 and
dry-run-verified first.
Every poll (`POLL_SECONDS`, 300 s) `phaseb.ts runOnce` drives each pump in `PHASE_B_PUMPS`:

1. **Requires a fresh SensorLinx reading** (≤ 15 min, with a target) — otherwise it skips the
   cycle (`lastResults._skip`) rather than track stale data.
2. **Lead** = the max of: the *operative* target (the SensorLinx report, or the curve in force's
   output when `stale-target.ts` proves the report frozen after a lowering, #215); the plan's
   command for the block in force and the next block's curve output (`planLeadF`, #220); an
   identification probe target; a pending dashboard boost (#231, for at most 20 min); and, with
   `SHAPED_CURVE=1`, the device curve's output now and at the next hour's forecast outdoor
   (`curveLeadF`). Every term is shown at `/health.phase_b.lead`.
3. **Setpoint** = lead + 5 °F I1 margin, rounded up to whole °C (natural hysteresis), clamped to
   [45 °C, `PHASE_B_CAP_C`]. Above the cap it sends the cap and the standing I1 monitor alarms.
4. **Send** through the hub (`POST /api/command`, source `phase-b`) with `lease_minutes` = **90**
   — the `LEASE_MINUTES` constant in `phaseb.ts`, not an env variable. Renewals are free on the
   Pi (same value = lease refresh only, no EEPROM write). Before every send it re-checks, fresh
   from the DB row, that this instance holds the writer lease (when `WRITER_LEASE_ENABLED`) and
   is not shutting down; otherwise the result is `skipped … writer lease not held / handing over`.
5. **Verify what the Pi did, not what was asked** (FINDING-1b): after the sends it reads the hub
   state and rewrites each result to `ok 63°C (lease 62m armed)` from `remote_lease_until`, or to
   `— ⚠ NO LEASE ARMED`. The Pi arms a lease only when its `baseline_setpoint_c` is set
   (FINDING-1, closed 2026-10-18: baseline 52 °C, `lease_max_minutes` 180).

Engineer alerts, all edge-triggered and record-tier (owner 2026-10-21): "Phase B tracking
failing" after 3 consecutive write failures per pump (the lease lapses to baseline on its own —
house safe, savings paused) and "Phase B recovered" on the next accepted write; "Phase B: no
lease armed" after 3 consecutive verifies without a lease (one is usually the hub's pre-write
snapshot). Two sustained conditions also page the owner (`owneralerts.ts`, owner 2026-10-29):
"Heat-pump safety net is off" after > 30 min of accepted writes with no lease armed, and "A2W
can't control the heat pumps" after 7 failed cycles in a row, not counting a person's choice or
an unreachable Pi. Every attempt is logged in `phase_b_log`; `/health.phase_b` = `{mode, pumps,
lastRunAt, lastResults, fail_streak, lead, owner_alerts}`.

| Env | Default | Meaning |
|---|---|---|
| `PHASE_B_ENABLED` | off | `1` constructs the loop (needs `HUB_URL` / `HUB_CLIENT_TOKEN`). Set in production. |
| `PHASE_B_DRY_RUN` | off | Seeds `controller_flags.phaseb_dry_run` on first boot only; the dashboard Off/Armed switch owns it afterwards, and that switch sets the auto-pilot's `autopilot_dry_run` at the same time (there is no Phase-B-only switch). Dry-run computes, logs `DRY-RUN would send …` and sends nothing. `/health.phase_b.mode` reports this seed (`dry-run` / `active`), not the switch. |
| `PHASE_B_PUMPS` | `pump1,pump2` | Hub pump ids tracked. |
| `PHASE_B_CAP_C` | `75` | Planner-side cap (bridge config clamp — NOT the reg-2027 factory 55; the Pi's live bounds stay authoritative). |

**Rollback.** Either path stops the sends; the Pi then does the revert — the lease lapses within
its remaining minutes and `check_lease()` restores `baseline_setpoint_c` (52 °C). Nothing may hold,
queue or rate-limit that revert (#208).

- *Without a deploy:* flip the dashboard's Off/Armed switch to Off (`POST /api/autonomy` with
  `mode=off`). This is **not Phase-B-only**: it sets both `controller_flags.autopilot_dry_run` and
  `phaseb_dry_run`, so the auto-pilot also goes shadow and stops writing the HBX curve; the
  in-memory controllers are switched at once and the row is re-read every poll. No no-deploy switch
  stops Phase B alone — only unsetting `PHASE_B_ENABLED` does that. Setting `PHASE_B_DRY_RUN=1` on
  Railway does **not** do this on an already-seeded database (it only changes what
  `/health.phase_b.mode` reports).
- *With a deploy:* unset `PHASE_B_ENABLED` on the Railway service — a variable change redeploys
  the planner, so treat it as a deploying change (one at a time, verified, root `CLAUDE.md`). This
  is the only path that stops Phase B and leaves the auto-pilot live; `/health.phase_b` then reads
  `disabled`.
- *Confirm* by the per-pump results, not the mode field. After the Off path `/health.phase_b.mode`
  **still reads `active`** (it comes from the `PHASE_B_DRY_RUN` env seed, index.ts), so judge by
  `/health.phase_b.lastResults` showing `DRY-RUN would send …` for every pump, by the dashboard's
  controller status, and by the Pi's setpoints back at `baseline_setpoint_c` once the leases lapse.
  `scripts/drift-check.sh` does **not** confirm this rollback: its [2a] skips only on the dry-run
  result strings, and its [2b] lease check (with `HUB_CLIENT_TOKEN` set) keys on the `active` mode
  field and will report a false `phase_b is ACTIVE but … hold NO lease … baseline_setpoint_c is
  unset` failure once the leases have lapsed. That is the rollback working, not FINDING-1 re-opened.

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
| `SPAN_BACKUP_ALARM_KWH` | energy drawn in the trailing 60 min above which it pages (default `0.3`; a 16.5 kW element hits 0.3 kWh in ~65 s, an idle circuit adds ~0) |
| `SPAN_BUILDING_ID` | optional; auto-discovered from the account if unset |
| `SPAN_POLL_SECONDS` | poll cadence, own timer (default `60`) |

Auths with Cognito and polls each circuit's **day-cumulative** energy (the query asks
`measurementAggregation` for `duration: DAY / calendarWindows: true`, so the value is kWh so far
today — 0 at local midnight, the day's total at 23:00; #207). The alarm differences that running total
poll to poll and sums the increments of the trailing 60 minutes: it edge-alerts when the backup circuit
drew more than the threshold in any 60-minute window and clears once the trailing hour is back under
it (so a continuously running element pages once, not every hour). A drop in the counter is the
local-midnight rollover and is not an increment. `/health.span.cloud.backup_kwh_last_hour` is the
number compared; `backup_kwh_today` is the raw reading. Detection lags SPAN's cloud aggregation by
however often it refreshes — fine here: the element runs for hours, and `backup_called` is the instant
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

Tables: `zone_floor_snapshots` (one row per shadow run when a floor was proposed);
`zone_call_samples` (one compact row per feed refresh, every poll ≈ 5 min: `ts`, `calling_zone_ids text[]`
(NULL = call feed unhealthy), `n_zones`, `source` = calls | cached | stale; self-pruned at 60 days. Lets an
analysis say whether a zone was drawing during a 5–20 min charge, which the hourly snapshot cannot).
`/health.winter_solver` = off | shadow | degraded.

## TempIQ COP mirror (`tempiq-read.ts` → `tempiq_cop_points`)

The hourly read mirrors TempIQ's hydronic COP measurements (`GET /api/insights/cop-measurements`) into
`tempiq_cop_points`; that table is the measured anchor for the winter DP (`getCopAnchor`), the realized-savings
ledger (`getRealizedDayInputs`) and the `/curve` chart. Since TempIQv2#2124 TempIQ's writer **defers** a point
until the charge's end is observable and **re-upserts its overlap day** on every hourly run, so the newest
mirrored point is not a safe cursor and a mirrored row can legitimately change. The mirror therefore:

- re-reads from `newest stored measured_at − COP_OVERLAP_DAYS` (default 3; 7 days back on an empty table),
- pages backwards with `before=<oldest received + 1 ms>` until a short page, so the endpoint's 2000-row cap never
  truncates (a row from the other pump that shares a page-boundary timestamp repeats and upserts as unchanged),
- UPSERTs on `(measured_at, system)`, touching a row only when a mirrored field moved; `lastResult` reads
  `cop: +3 new / 2 updated / 41 seen`.

A backfill older than the window (TempIQ wrote Sep 29 → Oct 27 on 2026-10-27) needs the one-off:

```
POST /api/tempiq/cop-refetch  {"since": "2026-09-29", "before"?: ISO}   Authorization: Bearer $PLANNER_API_TOKEN
  → {fetched, inserted, updated, pages, oldest, newest, truncated, durationMs, error}
  401 no bearer · 413 body over 4096 bytes · 422 malformed / future / > 400-day since, before ≤ since · 503 reader off · 409 one running · 502 a page failed
```

It runs inline on the request (same 20 s per-page timeout, 50-page bound) and the summary stays on
`/health.tempiq_read.lastCopRefetch`. Never a cron: the hourly window covers steady state.

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
is released and the auto-pilot re-commands its plan. The driver's own cleanup returns the plant to the
base through the guarded writer; when that is refused (a 429 inside 15 min of the probe write) it takes
the rate-limit-exempt **plan restore** (#232), and only an abort whose plan restore is refused too falls
back to the as-found curve (hotter is the safe direction; a normal end stays pending and retries).

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

Runs the **real planner** (`POLL_ONCE=1`, three polls — four when the scenario injects a boost) against a **local** Postgres with every upstream faked
— SensorLinx (device read + PATCH echo), the hub (state + leased commands), TempIQ (zones, calls,
identification plan, posts), open-meteo, NWS, OutageWatch — from a scenario JSON, then asserts what the
planner *did* (DB ledgers + the fake's request log), not what it logged.

```sh
scripts/rehearsal/run.sh cold-morning     # 22 °F falling to 12 °F, two zones calling, leases armed
scripts/rehearsal/run.sh warm-evening     # 62 °F, nothing calling, device already at 120 → must write NOTHING
scripts/rehearsal/run.sh tempiq-down      # cold morning, every /api/insights route 503 → winter-guard plan, held
scripts/rehearsal/run.sh forecast-down    # cold morning, open-meteo 503 → cached / no plan, nothing written blind
scripts/rehearsal/run.sh pi-offline       # hub unreachable (/api/state 503) → every write refused, no probe
scripts/rehearsal/run.sh pi-dropped-hub-up # hub UP, Pi gone 2 h: stale pumps[] + pi_connected:false → refused 503 (#167)
scripts/rehearsal/run.sh boost-expiry     # #232: as-found 165/145 in force at 40 °F, SHAPED_CURVE live; poll 2 writes the plan
                                          # curve, a real 128 °F boost is injected and expires → poll 3 restores the PLAN's
                                          # curve (never the as-found), auto-pilot holds, poll 4 Phase B leads 52 °C (four polls)
```

**Hour-independent by construction** (eval 2026-09-30, F1): the plan's daily 140 °F soak goes to the warmest
*remaining* hour of the local day (since 2026-11-24, with a readable plan history AND a measured dwell, the warmest
hour *after* the one in progress: a soak placed on the current block got ~15 min, never the 30-min dwell; a soak
already in progress keeps its hour until its dwell qualifies, also when the outdoor reading crosses 55 °F mid-soak
and the interval becomes 60 h; a new soak starts no later than 3.5 h before the interval runs out — else on the last
hour that does, or on the next hour if that limit has passed; at most 3 soak hours in a row; the soak is not due again
within 12 h of a qualifying dwell. With the dwell not measured the soak is placed as before, with no per-day memory;
with the dwell measured but the plan history unreadable it is placed as before too, and only the 12 h rest applies), so a falling
forecast run in the late afternoon would put the soak on (or right after) the current block — the driver then
refuses to draw beside it and the demand floor rides the soak's 145 °F ceiling; the harness
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
