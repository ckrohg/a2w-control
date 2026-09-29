<!--
@purpose Assessment of whether A2W is ready to heat EFFICIENTLY this winter under TempIQ-driven
per-fixture control: DHW-optimal when nothing calls, correct per-emitter target when something
does, and a defensible answer when several fixture types call at once. Requested 2026-09-27
("figure out if the a2w system is actually ready to heat efficiency ... driven by TempIQ ... radiant
floors need different target [lower] than the base board systems ... TempIQ would get smart and
also be able to understand the most efficient temp to heat using each fixture").

Written against the RUNNING system (planner /health 2026-09-27 23:19Z, Railway flag values, planner
source at d3418af) and the cross-repo issue trail, not against the design docs. Where a claim is
inferred rather than measured it says so. Companion docs: cross-system-optimization-plan.md (the
design this is scored against), eval-2026-09-26.md (the general end-to-end eval), #89 +
cold-snap-baseboard-test.md (the supply-temp sizing question), winter-dp-commissioning.md (go-live).
-->

# TempIQ-driven heat efficiency — readiness assessment, 2026-09-27

**Season note:** the request said "this summer". Everything it describes — heat demand, radiant vs
baseboard targets — is winter, and heating season began ~2026-09-23. This assesses winter 2026-27.

---

## 0 · Verdict

**Not ready — but far closer than the docs imply, and the blocking items are not the obvious ones.**

Per-fixture control is **built and in the live control path**. What is not ready:

1. Nothing in this system has ever run below **48.1 °F** outdoor (`slx_readings`: 0 rows under 40 °F).
2. The number that decides baseboard supply temp is **unmeasured on all three candidate sources** (#89).
3. TempIQ's per-fixture efficiency learner **exists and has zero readers** (gtm#1595).
4. Two states are actively wrong for cold weather *right now*: `lagT=180` (#132) and the flat-curve
   single point of failure (#133).

And there is a structural point (§2) that reframes the whole ask.

---

## 1 · What is actually live — measured, not claimed

Planner `/health` and `/api/readiness`, 2026-09-27 23:19Z; flags read from the Railway service.

| subsystem | state |
|---|---|
| autopilot (writes the HBX tank target) | `AUTOPILOT_ENABLED=1`, `AUTOPILOT_DRY_RUN=0` — **live** |
| Phase B (pump setpoints track the target) | **live**, both pumps, 61 °C / 141.8 °F |
| demand floor (per-fixture) | **live** — folded into the plan the autopilot writes |
| TempIQ `/zones` + `/calls` | both healthy; 18 zones, 0 calling, 38 spatial edges |
| winter DP | `idle`, `enabled: false` — shadow only |
| demand forecast | `idle`; `FETCH`/`PREHEAT` both off |
| storm | `idle`, enabled; `STORM_CAP_F` 135 |
| hygiene | auto-sanitize on (runtime flag, not env), 60 h summer interval, last dwell 225 min |
| tank / target / outdoor | 126 °F / 135.2 °F / 58.3 °F |
| `writer_lease` / `i1` | held / not violated |
| **`/api/readiness`** | **`ready: false`, `blocking: ["failsafe"]`** (FINDING-1) |
| **Phase B per-pump** | **`"ok 61°C — ⚠ NO LEASE ARMED"`** on both |

Two things worth correcting in the record:

- **`WINTER_SOLVER_SHADOW=1` is a misnomer.** It gates only the *feed*. The emitter-aware floor it
  produces goes `computeFloors` → `computeShadowPlan` → `autopilot.applyLatestPlan()` → a real
  guarded HBX write. Per-fixture targeting is **not** in shadow; the winter **DP** is.
- **The 135.2 °F target is the tail of storm shaping, not a plan value.** At 58.3 °F outdoor with
  nothing calling the plan wants 120 (`dhwFloorF`). Reproducing `setTarget`'s solve for `target=135,
  dot=5, wwsd=125` gives `dbt=137 / mbt=133` → output **135.22** at 58.3 °F — an exact match, so the
  commanded value is `STORM_CAP_F`. `lastShadowAt` 22:32Z predates the stand-down; the next hourly
  replan should relax it. *(Inferred from the solve, not confirmed against `autopilot_log`.)*

---

## 2 · The structural point that reframes the ask

**You cannot deliver two temperatures from one buffer.** Radiant wants ~105 °F, baseboard ~135 °F,
and there is one tank — so the tank serves the **max**. That is physics, not a software gap.

So "know which fixture is calling and deliver the correct target" is *already* as solved as a single
buffer permits. The real optimization is **"arrange for the expensive fixture to stop binding."**

### How often the expensive fixture actually binds

Per-zone duty, Nov 2025 – Jan 2026 (TempIQv2#2009 Phase 0, from Nest `hvacStatus='HEATING'`):

| zone | type | verified | duty |
|---|---|:--:|---:|
| Master Bathroom | radiant | ❌ | **60.5 %** |
| Mud Room | radiant | ✅ | 25.8 % |
| Upstairs Bathroom | radiant | ❌ | 24.3 % |
| Dining | radiant | ✅ | 5.1 % |
| **Living Room Baseboard** (a DISTRIBUTED loop: Den/Office + Xmas Room + entryway — owner, 2026-09-29) | **baseboard** | ✅ | **4.7 %** |
| **Upstairs Baseboard** | **baseboard** | ✅ | **4.4 %** |
| Kitchen Radiant | radiant | ❌ | 2.0 % |

**Only 2 of 18 zones are baseboard, and they call in ≲9 % of hours.** For ~91 % of heating hours
nothing on the plant needs baseboard water.

### What that is worth — CORRECTED 2026-09-27 (the first pass overstated it)

The first version of this section compared a 107 °F tank against 135 °F and claimed ~+30 % COP for
~91 % of heating hours. **That was wrong**, because `dhwFloorF` = 120 °F is held in EVERY hour of the
year (`computeShadowPlan` starts each block at `max(idleF, dhwFloorF)`; the demand floor only raises).
The tank is never at 107. Corrected, with A2W's own local model:

| outdoor | radiant + 4.5 margin | baseboard + 4.5 margin | tank actually commanded |
|---:|---:|---:|---|
| 30 °F | 107.0 | 117.4 | **120** — the DHW floor governs *both* |
| 27.3 °F | — | 120.0 | 120 — where baseboard first bites |
| 10 °F | 110.0 | 135.3 | 135 (`strictCapF`) |

Three consequences, all of which reorder the roadmap:

1. **Arbitrage is DHW-floor-bounded.** Moving a baseboard space to its Kumo cannot take the tank below
   120 °F, so the available gain is 135 → 120, not 135 → 107:
   at 30 °F, `(579.67/90)/(594.67/105)` = **+13.7 %**; at 10 °F, **+10.8 %** — and only in the hours
   the tank is actually pegged.
2. **The hour-weighting was optimistic too.** 4.7 % + 4.4 % is a sum, not a union, and baseboard calls
   cluster in the coldest hours, which carry disproportionate load. The prize must be computed
   **energy-weighted** before anyone funds actuation.
3. **The crux is #89, not arbitrage.** Under the local model the tank rides ~120 °F for most of
   winter and the baseboard question barely matters. If escalation walks toward TempIQ's ceiling
   instead, the floor pegs at 135 °F from **46.4 °F outdoor** — nearly the whole season. Those are two
   different winters, and that gap *is* the savings case. Everything else is second-order to it.

**And it promotes a different top lever.** Because the DHW floor governs most hours, *measuring* it
(#138.2) is worth more than the arbitrage card: 120 → 112 °F is ≈ +8 % COP at 30 °F
(`(571.67/82)/(579.67/90)`) plus a quadratic cut in standby loss, applied to ~every hour of the year
rather than to ~9 % of them. One thermometer, no code.

Caveat on all of the above: it is computed with A2W's local model, which is itself unmeasured. That
is the point of item 3 — the arithmetic cannot settle which winter we are in, only #89's cold-snap
evidence can.

### Ways to relax the max, once #89 says the max matters

1. **Verify the radiant manifolds have tempering/injection.** Assumed, never inspected, after two
   months in §10 — and the tank has run 150 °F+ into those loops for years. If mixing exists,
   radiant is decoupled and only the baseboards ever justify a hot tank. → #138 item 1.
2. **Source-substitute the baseboard spaces on design-cold days.** Living Room Baseboard is one loop
   through Den/Office + Xmas Room + an entryway (owner, 2026-09-29), so relieving it takes the
   Den/Office AND Xmas Room Kumos together, not one head. → #22.
3. **Add injection mixing on the baseboard loop.** Hardware; the honest third option.

---

## 3 · Scoring the three asks

### 3.1 "No heat demand → optimize for efficient DHW" — ◐ works, not optimized, burning COP-1 heat

Live: a flat 120 °F DHW-ready floor every hour (`idleF == dhwFloorF`, deliberate — "draws possible
any hour"), a live draw-window learner (`dhw.ts`; 133 events / 14 d, `max_gap_h` 16.9), one
warmest-hour bank block (`BANK_F=8` → 128 °F), and a 140 °F pasteurization soak every 60 h summer /
26 h winter.

Two real problems:

- **The floor is unmeasured.** 120 °F = desired delivery + an *assumed* 5–8 °F coil approach. The
  mixing-valve output and tank-vs-coil temps have never been measured (eval G6 = `?`). It is held
  every hour of every day, so if the true floor is 112 °F the waste is continuous. → #138 item 2.
- **The floor is too thin, and the element paid for it.** Journal `2026-08-07T02:07`: hard draws sag
  the tank to **102–117 °F with both pumps at full call**, and the HBX then joined the 16.5 kW
  element for 10–35 min every other day — **~21 kWh/wk at COP 1.0**. The fix applied was to make the
  element *slower* (`lagT` 60→180), not to stop the shortfall. Anticipation (§6.6) is designed and
  **not built**; the `prechargeLookbackH` branch in `computeShadowPlan` is structurally dead
  (`if (warmest.target < opts.dhwFloorF)` can never fire once `idleF == dhwFloorF`). → #135.

Today's DHW regime is "hold a flat floor and let resistance heat absorb the shocks."

### 3.2 "Heat demand → which fixture, correct target" — ✅ built, ⚠️ the number is a guess

`demand.ts` is good code and does what was asked:

- `requiredAwtF()` — per-emitter physics. Baseboard `roomF + (135−roomF)·f^(1/1.35)` with a 108 °F
  fin-tube convection floor; radiant `95 → 110 °F`.
- `/api/insights/calls` gives live per-zone `HEATING`/`OFF` from the Nest `ThermostatHvac` trait, so
  only *calling* zones bind. (Contract verified: TempIQ emits the literal strings `'OFF'|'HEATING'`
  in `zoneCallSignals`, which is what `deriveCallingZoneIds` matches.)
- Three-state safety contract: `null` calls-feed → conservative all-zones; `[]` → nobody calling;
  stale `/zones` → degrade to the HBX curve. A2W never depends on TempIQ to heat the house.
- `escalate` (#90): start cheap, treat TempIQ's number as a **ceiling**, let room deficit
  (6 °F supply per °F) or call-streak (+6 °F/cycle) buy more. Owner-confirmed 2026-09-16.

The defect is #89: **none of the three candidate numbers is measured.**

| outdoor | TempIQ ceiling (baseboard, anchored 164.7) | A2W local | gap |
|---:|---:|---:|---:|
| 50 °F | 127.7 | 108.0 | 19.7 |
| 46.4 °F | 130.5 | 108.0 | 22.5 ← peg point |
| 30 °F | 143.2 | 112.9 | 30.3 |
| 10 °F | 158.7 | 130.8 | 27.9 |

TempIQ's is a generic textbook curve whose anchor is this plant's own p99 (partly *"what we used to
run"*); A2W's is an unvalidated fin-tube parametric; TempIQ's `ua_btu_hr_f` is `source='default'`,
confidence ≤0.15. History cannot settle it — there is no cold data. #101 now persists `roomF`,
`setpointF`, `localF`, `ceilingF`, `ceilingSource` per zone, so **the first cold snap with a
baseboard calling answers it automatically** (`cold-snap-baseboard-test.md`).

Two live consequences found by this review:

- **The escalation is structurally inert on the 3 unverified hydronic zones** — including Master
  Bathroom at 60.5 % duty. TempIQ only emits `requiredSupplyWaterTempF` for verified zones; with it
  null, `ceilingF = localF` collapses `Math.min(localF + bump, localF)` to `localF`. Zero degrees
  reachable, at any deficit, for any streak. → #134.
- **The room-deficit channel is unproven.** `demand.setpointF` is null whenever a Nest is in OFF
  mode (gtm#1594, open, root-caused in their connector). It *should* populate once the Nests are in
  HEAT, but it has never been observed populated in a heating season — so today the policy rests
  entirely on the `callStreak` backstop. Verify on the first real call. → #134.
- **Response is slow:** floors recompute hourly (`SHADOW_EVERY_MIN=60`) and escalate +6 °F per
  cycle, so worst case is ~1 h latency plus a 4–5 h ramp. → #136.

### 3.3 "Multiple fixtures/types running → optimize" — ✗ `max()` only

`computeFloors` takes the max over calling zones. No arbitrage, no capacity term, no per-source
dispatch. Two halves are missing:

- **Temperature.** Can the max be *relaxed*? §6.10 mini-split assist is #22 (`priority:low`,
  recommend-only, never built). Adjacency borrowing exists as a shadow only
  (`ADJACENCY_SETBACK_SHADOW`, not set in production).
- **Capacity.** Several zones calling is a *power* problem, not a temperature problem — and `lagT`
  was raised 60 → 180 min in August for summer reasons, so the second compressor is **three hours**
  away on a design-cold day. The journal entry's own follow-up ("winter revisit of lagT=180") landed
  in no playbook and no issue. → #132.

### 3.4 "TempIQ learns the most efficient temp per fixture" — ✗ the learner exists and is dead

`server/services/thermal/supply-water-requirement-learner.ts` + migration `0158` fit precisely this:
**the lowest AWT at which a zone holds setpoint without railing runtime**, per outdoor band, with
identification gates (≥40 samples, ≥8 °F AWT spread, two-sided evidence) and experiment quarantine.
Its own header says it has no readers. **gtm#1595 is open** and is exactly the ask.

The leverage: U4's gates need AWT **spread**, which passive observation here never produced (the
plant ran pinned at 150–165 °F for years). **A2W's autopilot is what makes U4 identifiable.** The
corollary is gtm#1596 (open): A2W has been moving the tank since 2026-07-16 and TempIQ's learners
have ingested it as natural behaviour for ~2 months. Excluded-from-passive-fit and
ingested-as-labelled-experiment are one payload — design once, serve both. → #137.

---

## 4 · Findings this review produced

1. **`lagT=180` has no winter decision**, and the journal's own committed follow-up appears in none
   of `winter-dp-commissioning.md`, `winter-drill.md`, `backup-control-design.md`. → #132
2. **The planner is a single point of failure for weather compensation.** `setTarget` writes a
   near-flat curve (`SPREAD=4` over a 120 °F outdoor span); the only `restore()` triggers are boost
   expiry and the dashboard button; the planner dead-man pages and restores nothing. Degradation
   ladder rung 3 ("Pi dead → HBX curve, exactly today's system") no longer means what it says — the
   curve it falls back to is ours, and it is flat. Same class as FINDING-1, other actuator. → #133
3. **The cost-first escalation cannot lift the 3 unverified zones**, including the 60 %-duty binding
   zone; and the `MODEL DIVERGENCE` warning gates on `bindingZf?.learned`, so it is structurally
   unable to describe the zones that have no ceiling. → #134
4. **The DHW pre-charge branch is dead code** with a misleading reason string, and the element was
   the de-facto shock absorber for the 120 °F floor until `lagT` hid it. → #135
5. **The arbitrage prize is real but smaller than first stated, and DHW-floor-bounded** —
   ~+11–14 % in pegged hours, not +30 % across 91 % (§2, corrected). It is also downstream of
   #89: under the local model the tank rides ~120 °F most of winter and the baseboard question
   barely bites. The card is still worth promoting because this is the only clean measurement
   window for its counterfactual — but **energy-weighted, not hour-weighted**. → #22 comment
6. **Prediction is correctly dead and should not be rebuilt.** TempIQ's Phase 0 (chronological
   split, 2000-resample moving-block bootstrap) found skill in 1 of 7 zones — and that zone runs
   74.9 % duty, so pre-heating it buys nothing, and it is unverified so A2W may not act on it.
   Prediction skill is anti-correlated with pre-heat value here. `FORECAST_*` staying off is right.
7. **gtm#1614 is an open P1 on the forecast itself** — served forecast 2.2 °F *worse* than flat
   persistence at 4 h, regressed since heating started ~09-23. Anything forecast-driven (pre-boost,
   DP, storm shaping) inherits it. Fix before flipping `FORECAST_FETCH_ENABLED`.

---

## 5 · Ranked winter risks

| # | risk | state |
|---|---|---|
| 1 | **FINDING-1 unarmed, day 11** — `baseline_setpoint_c` unset → `remote_lease_until: null` → revert, its alert and the 15-min warning cannot fire. `/api/readiness` red. Pi is LAN-only. | #117 |
| 2 | **`lagT=180`** — second compressor 3 h away on a design-cold day | #132 |
| 3 | **Flat curve + no restore** — planner death removes weather compensation | #133 |
| 4 | **#76 comm degradation** — observed live during the eval (pump2 offline 30 min on a 55 °F day) | #76 |
| 5 | **#89 unsettled** — blocks `WINTER_DP_ENABLED` and any `strictCapF` raise; now self-answering on the first cold snap | #89 |
| 6 | **A9 winter floor** (`unattended_min_setpoint_c`) still `None`, pending a cold-weather capacity test | eval A9 |
| 7 | **Backups unrestorable** (Keychain passphrase) — also blocks the #76 data work | eval F4 |

---

## 6 · What the optimal product looks like

Three regimes on one tank, one learning loop underneath.

- **DHW-only (nothing calling):** ride a *measured* floor, not 120 by assumption. Learned windows
  drive an anticipatory pre-boost in the best-COP lead hour, sized so the **trough** stays above the
  floor and the element never joins. Fewer, deeper charges (~1 kWh/cycle overhead). The I8 soak
  folds into the pre-boost — one charge, two jobs.
- **One fixture calling:** tank = that zone's **measured** requirement + margin. *Measured* means
  U4, per zone, per outdoor band, with provenance — not a type curve and not a fin-tube guess.
- **Several calling:** two decisions, not one. *Temperature* = max over calling zones, **after**
  asking whether the max can be relaxed (mini-split assist on the binding space; adjacency
  borrowing). *Capacity* = stage both compressors early enough that resistance heat is never the
  answer.
- **Underneath all three:** the planner writes a **demand-shaped reset curve**, not a flat one — so
  the HBX weather-compensates autonomously between writes and after a planner death, write frequency
  drops from hourly to a few times a season, and the curve is legible on the wall controller.
  Hour-of-day shaping (bank / soak / storm) rides on top as short bounded excursions — machinery
  that already exists as `boost()` with durable `restore_at`. This makes #127 (Set & forget) nearly
  free: same mechanism, different author of the curve.
- **And a closed evidence loop:** A2W posts its write windows to TempIQ as a fourth `ArmLogSource`;
  TempIQ quarantines them from passive fitting *and* ingests them as labelled dose-response for U4.

---

## 7 · Build plan

### Physical / owner — gates everything else, all cheap

| item | issue |
|---|---|
| Arm FINDING-1 from the house LAN | #117 |
| Radiant manifold tempering/injection — inspect + record the valve setpoint | #138.1 |
| Mixing-valve output + tank-vs-coil → the real DHW floor; confirm no downstream potable storage | #138.2 |
| SPAN element breaker state + a recorded decision either way | #138.3 |
| Winter `lagT` decision | #132 |

### A2W, in build order

1. **#132** — winter `lagT`, recorded in the playbook and asserted by `drift-check.sh`.
2. **#133** — planner-death curve fallback. Prefer the demand-shaped curve; note it forces I1 and
   Phase B's lead to be evaluated against the curve's *output*, which is the real work.
3. **#135** — DHW anticipatory pre-boost. Build **before** #132 lowers `lagT`, so element protection
   does not depend on a timer winter wants shorter.
4. **#137** — post write windows to TempIQ's quarantine seam + backfill July→now. Unblocks gtm#1595.
5. **#134** — surface the inert-escalation case now; hold the behaviour change until cold data.
6. **#136** — decouple floor detection (5 min) from replanning (hourly), raises-only, and make
   `ESCALATE_STEP_F` time-based *first* or +6 °F/h silently becomes +6 °F/5 min.
7. **#22** — promote; build the recommend-only card this winter while the counterfactual is clean.

### TempIQ — all open, all are the "get smart" ask

| ask | issue | why |
|---|---|---|
| **Wire U4** | gtm#1595 | the measured per-zone requirement. The one to fund. |
| `delivery_type_source` (migration 0162, dead) | gtm#1590 | `verified` means "somebody PATCHed it" — and it is gating out 60 % of the demand |
| Nest setpoint when mode is OFF | gtm#1594 | restores the room-deficit evidence channel |
| Design-anchor ratchet guard | gtm#1601 | the anchor now computes off a p99 A2W is deliberately driving down — it fails toward a cold house |
| Forecast regression | gtm#1614 | P1; everything forecast-driven inherits it |

Do **not** rebuild per-zone call prediction (gated STOP, §4.6).

### Sequence for the next week

1. Arm FINDING-1 — the only red item on `/api/readiness`.
2. Decide `lagT` and write it where a drift check can see it.
3. On the first day below ~35 °F with a baseboard zone calling, let #101's capture answer #89.
4. Fund gtm#1595 **with** gtm#1590 — without the latter, U4 cannot reach the highest-duty zone.

---

## 8 · What this assessment could not see

- **A live read of the per-zone insights payload** — blocked by the sandbox's production-read guard.
  The 4-of-7 verified split and `ceilingSource: demonstrated_max` come from the recorded 2026-08-27
  verification plus current code, **not** from a reading taken today.
- **The database.** Whether the element is still assisting, what `autopilot_log` shows for the
  135 °F target, and the current `zone_floor_snapshots` contents are all unread. The Monday digest
  answers the first.
- **The Pi's live `~/bridge-data/config.yaml`** — only what `/health` reports about it.
- **The HBX's live config** beyond what the poll loop records: `lagT=180` and `numStg=2` are from
  journal entries, not from a reading taken today. Drift detection is relative, so a *change* would
  have alerted; a deliberately-wrong value is invisible.

---

## 9 · Revised scope after W0 — 2026-09-29

Written after W0 ran. W0 was budgeted as the small wave; it absorbed a full session because every
layer under it was broken. The dependency graph changed shape as a result.

### 9.1 What W0 found (each verified read-only against prod)

1. **U4 — the per-zone supply-water learner — had written 0 rows since July**, for three independent
   reasons: its duty CTE matched four signal keys that exist nowhere in `readings`; its setpoint CTE
   INNER-joined on `thermostat_heat_setpoint`, which is 0 rows for all 7 hydronic zones; and the query
   could not finish (below). Any one alone yields zero rows for ever. gtm#1595 implemented as
   specified would have wired an empty table and closed clean.
2. **Repaired, U4 returns the wrong answer.** Replayed over the as-found era it "identified"
   151.6–164.4 °F — the as-found tank temperature read back. Passive AWT variation is *endogenous*:
   the buffer sags because demand is high, so low water and high duty share a cause. **A working U4
   on observational data is more dangerous than a broken one.** It now refuses to fit any sample not
   marked as a deliberate, externally-commanded perturbation (`exogenous`), and refuses thin
   one-sided evidence (≥5 samples and ≥2 distinct levels each side of a threshold).
3. **`public.readings` (58.6M rows, 33 GB) heap-fetched every row on every index-only scan.** Recent
   data never received visibility-map bits — the insert autovacuum trigger needed ~11.7M new rows
   to fire. Every trailing-window learner paid ~4–6 ms per row. Catch-up VACUUM (owner-authorised,
   took 28 s): 7-day probe **23.9 s → 0.16 s**. Migration 0188 fixes the cadence. **gtm#1615.**
4. After (3), the remaining U4 cost was planner choice: the `COALESCE(signalKey, metricType)`
   alias predicate matches no index, so the plant CTEs scanned the whole window by timestamp.
   Zone CTEs went 162k → 3–14k cost once `equipment_id` was pre-resolved; tank/outdoor needed the
   exact single-key predicate (single-sourced from `plant-anchor.ts`). Measurement in flight.

### 9.2 What W0 changes in the plan

- **W3 (wire U4) is hard-blocked on W2 (the experiment)**, not merely sequenced after it.
- **gtm#1596 inverted**: from "quarantine A2W's perturbed windows" to "those windows are the *only*
  valid identification data." It moves from companion to prerequisite.
- **"Commanded" ≠ "exogenous."** The planner raises the target *because* zones call, so its writes
  are demand-responsive. W2 must be a true switchback with a recorded randomised assignment, and the
  arm log must carry assignment mechanism, commanded target, schedule/probability, achieved-AWT
  compliance and washout. This also kills most of #137's *backfill* value — July→now writes are
  quarantine data, not identification data.
- **The down-probe safety envelope is computed, not a threshold** (owner direction 2026-09-28):
  time-to-deficit from learned UA, thermal mass, tank C_eff, room margin, outdoor forecast and
  emitter curve, refused when shorter than abort latency + recovery. Recorded on a2w#137.

### 9.3 Decisions taken

| decision | outcome |
|---|---|
| catch-up VACUUM on `readings` | run 2026-09-29 05:23Z, 27.8 s, acceptance passed |
| gtm#1594 (Nest setpoint on OFF) | **Option 3** — emit both bounds tagged `resumeTarget`, mode-aware reader, control path byte-identical. PR TempIQv2#2044 |
| #132 `lagT` | keep 180 until #135 pre-boost is live and proven, then 60 |
| W2 probe floor | no hard-coded outdoor threshold; physics-derived `safe_to_probe` |

### 9.4 Three tiers of "ready", with dates

| tier | meaning | deadline |
|---|---|---|
| **Safe** | no cold house, failsafes armed, alerts reach a human | before sustained cold — **~Nov 15** |
| **Learning** | randomised perturbation live, arm log flowing, U4 identifying cold bands honestly | infrastructure live by **Nov 15**; Dec–Feb is the only window that produces cold-band data |
| **Optimised** | measured per-zone requirements driving the curve; arbitrage relaxing the max | **next winter** — cannot precede the data |

### 9.5 Remaining scope (revised estimate: 75–110 focused hours, not 50)

- **W0 finish** (~3 h + CI): merge TempIQv2#2043; verify the nightly run writes
  `attempted_none_identified` honestly; confirm the 30-day window fits the 290 s cron budget.
- **W1** (~15–20 h, TempIQ): gtm#1594 (PR open), gtm#1590 provenance (unlocks Master Bathroom,
  60 % duty, no ceiling today), and the **mini-split co-serving map** — `space_service_weights`
  has 0 rows; seed from the 38-edge spatial graph + owner confirmation. Least-started, load-bearing.
- **W2** (~20–28 h, highest risk): gtm#1596 arm-log seam with the randomisation record and the
  quarantine split; identification-plan endpoint with computed `safe_to_probe`; #137 (A2W half);
  the switchback driver — randomised two-sided steps ≤5 °F, up-first in cold bands, abort on room
  deficit / call streak, DHW windows as blackouts, mini-split-aware, on `/autopilot` before
  shipping. Owner chose **armed-from-start**; the care goes here.
- **W3** (~6–8 h, blocked on W2 + cold data): gtm#1595 precedence with a higher bar for
  `duty_only`; refuse `endogenousOverride`; gtm#1601 ratchet guard.
- **W4** (~25–30 h, one planner deploy): #133 shaped-curve fallback; #134 escalation headroom;
  #135 DHW pre-boost (before #132's `lagT` drop); #136 floor cadence; #22 recommend-only,
  energy-weighted.
- **W5** (~8 h): scoreboard + go-live gates.
- **Owner, gating tier 1**: #117 FINDING-1; #138 physical measurements; `RESEND_*` repo secrets;
  #76; backup restore.

Critical path to **tier 1 by Nov 15**: W0 merge → gtm#1594/1590 → #133/#135/#132 → owner items.
Tier 2 adds the whole of W2.

## 10 · Status 2026-09-29 (evening) — W0 done, W1 done, W2 built, first live seams

Everything below was verified against the running systems, not inferred.

### 10.1 Landed

| where | what | proof |
|---|---|---|
| TempIQ | #2043 U4 repaired (dead duty predicate, absent setpoint channel, unfinishable query) + exogeneity guard; #2044 Nest OFF-mode setpoints; #2045 provenance tier; #2046/#2047 zone-requirements + spaces repair; #2048 early-return diagnostics; **#2049 U4 hoisted** (the 4th independent cause: deadline-starved); **#2050 Part C** (`awt_perturbation_windows`, `POST /experiment-windows`, U4 exogenous join, exclusion 4th source) | U4 phase ran 3× today (31–93 s) and wrote **7 `supply_water_requirement` rows** (one per hydronic zone, all `no_exogenous_variation`) — `/zone-requirements` is `attempted_none_identified`, the honest state, instead of `no_rows` |
| TempIQ | **#2051 Parts A+B** — `GET /identification-plan` + computed `safeToProbe` (no outdoor threshold: time-to-deficit over window + recovery vs abort + reheat; unknown inputs fail closed) | four Codex adversarial passes (NaN fail-open, forecast continuity, nested bounds, safety horizon, hours off-by-one) → **approve**; prod replay: 35 cells, acceptance #1 holds |
| A2W | **#139 merged + live** — the quarantine poster (`tempiq-windows.ts`, one window per commanded-target episode, foreign-write closers, dose fields, July→now backfill) | `TEMPIQ_WINDOWS_ENABLED=1` at 18:29Z; first tick **HTTP 413** (500-window batch ≈ 200 KB > body limit) → #142 batches of 100; nothing lost |
| A2W | **#140 merged** — deploy-gate deadline 900→1500 s | the #139 deploy measured a 20-min lease handover (old container + 12-min freshness + 5-min poll); the gate's REGRESSION was false |
| A2W | **#141 open** — the identification driver (`identify.ts`) | two Codex passes: driver-owned durable cleanup, `pending_write` state, settled operative base, audit reconciliation on restart, permanent-vs-transient cleanup; third pass running |

### 10.2 Findings that changed the plan

1. **Every hydronic zone's envelope resolves to resolver DEFAULTS.** The `zone_envelope` rows exist (2026-09-28) but carry confidence 0.007–0.02, under the learned threshold → UA ~60–90, C 800. Part B refuses every down-probe as `envelope_unlearned` (fail closed). Radiant zones probe **up** from the 120 °F floor — safe, and the first live probes.
2. **Baseboard sits AT the 135 °F cap in every band ≤ 45 °F** — the up arm was unwritable, the down arm unpriceable: the a2w#89 cells had **no safe arm**. Owner decision: identification probes may exceed strictCap up to sanitizeCapF **145** (I1 + rate limit still guard); the driver writes them with that ceiling. Everyday cap stays 135.
3. `getZoneStatesForProperty` costs 10–13 s per call (18 zones) — the plan endpoint (and `/zones`) pay it; loads are now concurrent (28.8 → 10.3 s). A TempIQ follow-up.
4. `[reset-params]` reports the plant anchor 52 h old — another phase the starved scheduler is not reaching; post-loop `PL:*` phases are `aborted` even in succeeded cycles.

### 10.3 What "ready" looks like now

| tier | state 2026-09-29 |
|---|---|
| **Safe** | unchanged: #117 FINDING-1 (no lease armed on the Pi — still visible in every Phase B log line), #138 measurements, #133/#135 still open |
| **Learning** | seam live (poster), instrument built (plan + safety), driver built (#141) — armed once #141 deploys, `IDENTIFICATION_ENABLED=1`, a day in shadow, then armed. Cold-band baseboard evidence needs the 145 headroom (in) **and** a learned envelope (TempIQ follow-up) before down-probes can ever be priced |
| **Optimised** | next winter, as before |

Next: merge #2051 → gate-merge #142 → #141 → shadow → armed; a2w pushes `tank_reheat_rate_a2w` (unblocks priced down-probes); TempIQ envelope-learner confidence for hydronic zones; gtm#1617 co-serving learner + UI; then W4 (#133/#134/#135/#136/#132).

### 10.4 Addendum — later on 2026-09-29

| what | state |
|---|---|
| **#141 identification driver** | **merged 19:37Z** after eight Codex adversarial passes (driver-owned durable cleanup; `pending_write`; settled operative base; per-window audit tokens; idempotent ALTERs + one-time backfill; cleanup reads the LIVE device curve; foreign drift recorded before the controllers run). Rollout: `IDENTIFICATION_ENABLED=1` → shadow → armed. |
| **Reheat rate** | a2w #144 (rising-run scanner, conservative p25 + per-band) and TempIQ #2052 (ingest) merged — the number Part B prices down-probe recovery from. |
| **τ prices Part B** | TempIQ #2053 (stacked on #2051): every hydronic zone has a learned thermal time constant (0.79–0.91) though no learned UA/C; with the inferred design load C cancels, so τ alone determines the deficit trajectory. Replay: `tau_learned 7 / default 0`. Mild-band down-probes now bind on the DHW floor (the honest reason). |
| **#133 (b) shaped curve** | built as #145 (flag-off). Design correction: the I4 lower bound pins any 5 °F endpoint at 135, so the design point *moves* to forecast-min − 10 °F; `wwsd` never moves. Codex pass 1: classify before the scalar hold, validate against the live `wwsd`, refuse to move `dot` the baseline cannot restore, flag-off byte-identical — fixed; pass 2 running. Live acceptance #1/#2 after shadow. |
| **Quarantine seam** | live; backfill drained in one tick: 427 windows, 0 rejected (autopilot 216, bank 148, sanitize 57, manual 5, storm 2). |
| **Ops findings** | Railway created no deployment for the #142 merge (a docs push minutes later was evaluated and SKIPPED) → planner nudge #143 and a README rule. The deploy gate's 900 s handover deadline was a false regression (measured 20 min) → 1500 s (#140). TempIQ's CI workflow cancels in-progress runs per PR: re-running an *old* run cancels the *newer* one — rerun the latest only. An open-meteo 429 after three deploys in an hour aborted the whole hourly chain (pushes included) → #145 decouples the steps. |

### 10.5 Addendum — 2026-09-29 night: live seams, shadow driver, co-serving learner

| what | state |
|---|---|
| **Identification driver** | **live in SHADOW** since 20:18Z (`IDENTIFICATION_ENABLED=1`, `POST /api/identification {mode: shadow}`). Ticks so far idle on `sanitize/bank/storm block within 3 h` — `planConflictAhead` runs before the plan fetch, so `planFetchedAt` stays null until a conflict-free 3-h window; the first fetched plan and first shadow draw are still to be observed. Armed follows a day of clean shadow draws. |
| **Plan endpoint** | live on Vercel with **τ pricing** (TempIQ #2051 + #2053): 35 cells, `envelopeSources {tau_learned 7, default 0}`, reheat 32.4 °F/h from `a2w_push`, 16 safe suggestions, 20 unidentified, **15 `not_probeable = delivery_type_not_owner_verified`** (Master Bathroom, Upstairs Bathroom, Kitchen Radiant — an owner action in TempIQ, gtm#1590), `zonesWithLiveSetpoint 0` (Nests OFF, gtm#1594) so no down-probe is priced before heating season. |
| **#133 (b) shaped curve** | #145 merged 20:53Z (clean bracket, handover 1097 s) after a GitHub-side stale PR head produced a phantom conflict (fixed with an empty commit). The auto-pilot is **live** (`AUTOPILOT_ENABLED=1`, `DRY_RUN=0`), so `SHAPED_CURVE=1` would have written the first shaped curve within a poll → **#146 adds `SHAPED_CURVE=shadow`** (compute + stamp + `/health.curve.plan_implies.would_write` via the auto-pilot's own `curveAlreadyInForce`, no write). `SHAPED_CURVE=shadow` set with `--skip-deploys`; #146 through the gate. Acceptance #1/#2 are read from `/health.curve` for a day before `1`. |
| **Forecast fragility** | four deploys in two hours → open-meteo **HTTP 429** → `shadow failed` → no plan, no demand-floor refresh, `winter_solver degraded (zoneCount 0)` for the hour on the new instance. **#147** caches the last good forecast (≤ 6 h) and falls back to it; the plan's `meta.forecast_source` and `/health.forecast` record live vs cached. |
| **gtm#1617 co-serving learner** | TempIQv2 **#2054** (five Codex passes so far): temperature co-movement (detrended r₀ + best lag, contiguous runs only), heating response (Δslope around clean switch-ons), load sharing (OLS t on the head's on-fraction with outdoor covariate); missing evidence scores **zero**, temperature required, `high` needs two signals. Record `co_serving_candidates` (proposed/confirmed/rejected; confirm records the room as owner truth + a 50/50 weight proposal, reversible by recorded row version). UI `/co-serving`. Consumers: plan `co_serving_active` from **confirmed** pairs only; U4 drops buckets with a confirmed head heating. **First dry run on prod ranked Living Room Baseboard ↔ Xmas Room first** (r₀ 0.67; the only pair > 0.6 of 70) — the owner-confirmed loop, found from data. The 34 GB `readings` table is IO-bound (a 30-day re-scan took 17 min) → the learner materialises its 10-min buckets in SQL into `co_serving_series` in 7-day chunks under a budget with a durable contiguous coverage range per zone × signal; an incomplete window writes no candidate. |
| **Owner actions surfaced** | (1) verify the delivery type of Master Bathroom / Upstairs Bathroom / Kitchen Radiant in TempIQ (unlocks 15 plan cells); (2) after #2054 lands: run a 365-day scan on `/co-serving` and confirm/reject the proposals — Living Room Baseboard ↔ Xmas Room should be there; add Den / Office by hand (the Nest sits in the Xmas room, so temperature alone cannot find it; load sharing will, once the loop calls). |
