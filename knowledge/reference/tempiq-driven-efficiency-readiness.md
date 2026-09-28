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
| **Living Room Baseboard** (= the Xmas Room) | **baseboard** | ✅ | **4.7 %** |
| **Upstairs Baseboard** | **baseboard** | ✅ | **4.4 %** |
| Kitchen Radiant | radiant | ❌ | 2.0 % |

**Only 2 of 18 zones are baseboard, and they call in ≲9 % of hours.** For ~91 % of heating hours
nothing on the plant needs baseboard water.

### What that is worth

At 30 °F outdoor, 107 °F tank (radiant local model + 4.5 margin) vs 135 °F (`strictCapF`, where the
floor pegs whenever a verified baseboard zone calls):

    ((107+459.67)/77) / ((135+459.67)/105) = 7.359 / 5.663 = 1.30

**≈ +30 % COP, for ~91 % of heating hours** — larger than anything else on the roadmap, including
the winter DP (whose own shadow record shows `saved_pct` 0–5 %, correctly: a 110 gal tank stores
~40 min of design load, so LWT discipline beats banking).

Three ways to collect it, and only one is software:

1. **Verify the radiant manifolds have tempering/injection.** Assumed, never inspected, after two
   months in §10 — and the tank has run 150 °F+ into those loops for years. If mixing exists,
   radiant is decoupled and only the baseboards ever justify a hot tank. → #138 item 1.
2. **Source-substitute the baseboard spaces on design-cold days.** Living Room Baseboard *is* the
   Xmas Room and it has its own Kumo. → #22, re-motivated with these numbers.
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
5. **The arbitrage prize is ~+30 % COP for ~91 % of heating hours** and the card is `priority:low`.
   This winter is the only clean measurement window for its counterfactual. → #22 comment
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
