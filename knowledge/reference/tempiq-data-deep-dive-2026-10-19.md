<!--
@purpose Deep dive, requested 2026-10-19: does A2W have the right understanding and data from TempIQ on
(1) when a hydronic zone kicks on, (2) the supply temperature it needs, (3) how the plant performs and
how to optimise it, and (4) whether A2W + TempIQ can know the operating cost accurately given the moving
variables (COP, rate, which pump, which fixture). Grounded in the RESTORED mirror database (backup
a2w-db-2026-10-20T014442Z, via scripts/analyze-local.sh — no production query), the live planner /health
at 2026-10-20 02:42Z, planner source at 31c5d28, TempIQv2 source at b2d41ff7 (2026-10-18), and the
knowledge docs. Nothing was written to any live service. Where a mechanism is inferred from code rather
than observed in TempIQ's own database it says so. Companion: tempiq-driven-efficiency-readiness.md
(the design and the September verdict), eval-2026-10-18.md (the first cold night).
-->

# TempIQ data deep dive — zone calls, required supply, performance, cost (2026-10-19)

## 0 · Verdict

| question | understanding | data | verdict |
|---|---|---|---|
| when a zone kicks on | right | adequate, two blind spots | ✅ usable; two of seven hydronic zones are invisible because their Nests are OFF |
| the temp it needs | right model, right policy | **none yet** | ◐ the demand floor has never bound this season; the DHW floor (120 °F) governs every hour |
| how it performs | right design | **COP feed dead since Sep 28** | ✗ self-inflicted: A2W's quarantine windows cover 96.7 % of hours and TempIQ's COP learner drops every quarantined charge |
| cost, across both systems | right doctrine | **wrong numbers in both systems today** | ✗ A2W's realized ledger inflates energy ~14×; TempIQ prices hydronic heat at COP 1.0; the two use different $/kWh |

The short version: the control path is reading the right signals and making the right decisions, but
the *measurement* path — the thing that would tell us whether those decisions are cheap — has been
broken since the day the quarantine seam went live, and both systems' dollar figures are currently wrong
for independent reasons. None of it is a comfort problem. All of it is what "accurately know cost" needs.

---

## 1 · When a hydronic zone kicks on

**Pipeline (verified in both codebases):** Nest → Google SDM → TempIQ `readings` (`signalKey
thermostat_mode`, `metadata.hvacStatus`) → `GET /api/insights/calls` (`zoneCallSignals`: the newest
reading per zone within the last 60 min; hydronic zones only, by `systems.type = heat_pump_a2w`) →
A2W `DemandFeed` every 5 min (#136 cadence) → `deriveCallingZoneIds` = `hvacStatus == HEATING`.
Latency is SDM polling plus the 5-minute re-check, so ~5–10 min. Fine.

**Measured, Oct 16–19 (97 floor snapshots, first calls of the season):**

| zone | type | verified in TempIQ | snapshots calling | room °F (mean / min) | setpoint seen |
|---|---|:--:|---:|---|---|
| Upstairs Bathroom | radiant | ❌ | **73** | 69.1 / 66.5 | 91 of 97 |
| Kitchen Radiant | radiant | ❌ | 7 | 70.1 / 69.4 | 37 |
| Mud Room | radiant | ✅ | 4 | 69.4 / 65.5 | 96 |
| Master Bathroom | radiant | ❌ | 0 | 67.7 / 66.3 | 0 |
| Dining | radiant | ✅ | 0 | 62.9 / **58.4** | 0 |
| Living Room Baseboard | **baseboard** | ✅ | 0 | 60.5 / **56.4** | 0 |
| Upstairs Baseboard | **baseboard** | ✅ | 0 | 68.4 / 65.6 | 0 |

Three things to know:

1. **Two zones are invisible: Living Room Baseboard and Dining have their Nests OFF.** `setpointF` is
   null in all 97 snapshots for both (gtm#1594's mode-aware reader emits no setpoint when the mode is
   OFF), the rooms sit at 56–63 °F, and an OFF Nest never reports HEATING, so the loop never calls. The
   TempIQ scoreboard already shows it: Living Room Baseboard 57 and Dining 45 "cold hours below 66 °F" of
   136 sampled last full week. This is eval F7 in the data. It may be deliberate (unoccupied rooms), but
   it means the baseboard loop — the only emitter whose requirement changes what the tank costs — has
   produced zero evidence this season.
   **Owner, 2026-10-19:** both zones will be used, for comfort only. The baseboard loop needs the
   hottest water and is the most expensive emitter, so it runs when someone wants those rooms warm,
   never as a cost play; Dining is radiant and cheap to serve (below the DHW floor, §2) but rarely
   occupied. So the OFF Nests are deliberate, the scoreboard's cold-hour counts for these two zones are
   a setback artifact to read past (TempIQ counts hydronic zones in `coldHoursBySystem`; it exempts
   only set-back mini-split rooms), TempIQ's heating-readiness notifier will keep naming them, and #89
   gets answered the first time a comfort call happens — the #101 capture handles that automatically.
2. **There is no hydronic-side confirmation of a call.** HBX `hd_active` reads 1.00 in every sample
   (`permHD = 1`), and the `relays` field is a constant 16. No zone-valve end switch, no circulator
   current, no per-zone relay reaches either system. The Nest is the only source. Note the failure
   shape: a `/calls` HTTP error degrades to the conservative all-zones floor, but a Nest that simply
   stops reporting reads as `hvacStatus: null` → *not calling*. Silence looks like "no demand", not like
   "unknown".
3. **Three zones are still unverified** (Upstairs Bathroom, Kitchen Radiant, Master Bathroom — the
   owner item from September). Upstairs Bathroom bound the floor in 73 of 97 snapshots and, being
   unverified, has no TempIQ ceiling, so the cost-first escalation is structurally inert on it (#134).
   Escalation delivered 0 °F on every zone in every snapshot (`escalatedF` max 0.0; the only room deficit
   seen was 2.1 °F on Mud Room).

---

## 2 · The temperature a zone needs

**What A2W computes** (`demand.ts`, policy `escalate`): start at the local parametric model, treat
TempIQ's `requiredSupplyWaterTempF` as a ceiling, let room deficit or call persistence buy more. At the
~40 °F outdoor of the last four days:

| emitter | local model | TempIQ ceiling (provenance) | floor used |
|---|---:|---:|---:|
| radiant, verified (Mud Room, Dining) | 97.4 | 90.4–91.1 (`type_curve_default`: radiant 85→110 °F, exp 1.1) | **91** — the ceiling is *below* the local number, so it binds downward |
| radiant, unverified (3 zones) | 97.4 | none | 97.4, no escalation possible |
| baseboard (2 zones) | 108.0 (fin-tube floor) | 129.7–130.9 (`demonstrated_max` — the plant-p99 anchor now works; gtm#1599 is fixed) | 108 until escalation |

**What the plant actually ran:** across all 48 calling hours the binding requirement was 95–102 °F
(tank target 100–107 °F after the 4.5 °F margin), while the HBX held 120–140 °F: the 120 °F DHW floor
every hour, the 128 °F afternoon bank, 129/134 °F pre-boosts, and the 140 °F soak. **The demand floor
has never bound.** The `demand_floor_cadence` raised nothing in the window ("within 3 °F" / "no zone
calling"). So for five of the seven hydronic zones — every radiant zone — the required temperature is
academic this winter: 120 ≥ their requirement at every outdoor temperature seen, including the 28.9 °F
night. The readiness doc's §2 conclusion ("the DHW floor governs; measuring it is worth more than any
per-zone number") is now confirmed by the first cold data.

**The baseboard question (#89) has no data,** because neither baseboard zone has called: Living Room
Baseboard's Nest is OFF, Upstairs Baseboard held 65.6–68.4 °F without calling.

**Identification (U4) — armed Oct 17, seven windows so far**, all the Mud Room cell in the 30–45 °F
band, all *up* probes from a base of 120/121 °F by +5 or +8 (`baseAwtClampedBy: dhw_floor`): three
completed, two holds, two aborted by the 140 °F soak moving the plan. The cell holds 10 of the 40 samples
U4 needs. Structurally: a down-probe below the DHW floor is impossible, so U4 can only ever learn that
radiant needs *no more than* 120 °F — which we already know. Identification changes a decision only for
the two baseboard zones, and only when they call with the tank above 120 °F.

**Two more gaps in the number itself:**

- `BUFFER_MARGIN_F = 4.5` (tank → emitter drop) is assumed. Both sides of the comparison now exist in
  the mirror (`readings.outlet_c` at 60 s, `slx_readings.tank_f` at 5 min) and have never been compared.
- **The SensorLinx-reported target has sat at 139.9 °F since the 14:09 ET soak on Oct 19** — 12+ hours
  — while the planner commanded 120 °F at 15:04 and every hour after, the tank coasted 141 → 127 °F, and
  the HBX called no stage. Either the device really holds 139.9 and is not calling (implausible with
  `htDif = 4`), or the cloud's reported target is stale. The identification driver is stalled on it
  ("last command 119 °F not yet adopted, operative 139.9 — base not settled") and `plan_scores` is
  scoring the plan against it. Needs a look; it is the read path the whole write-verify loop trusts.

---

## 3 · How the plant performs — and why we cannot currently say

### 3.1 Electrical input: three sources, one usable

| source | state | verdict |
|---|---|---|
| Modbus regs 2063/2088 (`readings.power_w`) | 20–35 W while heating; `POWER_SCALE = 1.0`, units unconfirmed | **unusable** — that is not compressor power (real peaks are 5.8–6.4 kW) |
| SPAN **local** (`span_readings`, 25 s, in the mirror since Oct 12) | Air-Water 1/2 + Buffer Tank, consumption reported negative (#202) | **the accounting source, and A2W already has it** — integrated: Oct 18 = 36.1 + 16.3 = 52.4 kWh; week of Oct 12 = 120.4 kWh vs TempIQ's scoreboard 123.9 kWh (3 % apart) |
| SPAN **cloud** (`span_energy` via spanwatch) | one row per hour holding SPAN's *day-cumulative* kWh (0.0 at 00:00 → 49.9 at 23:00 on Oct 18) | fine as a counter; **mis-read by the realized ledger** (§4.1) |

Nothing in A2W computes a COP from the local SPAN stream. The data to do it is sitting in the same
database as the tank temperature.

### 3.2 Thermal output: calorimetry only

There is no flow meter. Delivered heat can only be inferred from tank temperature rise × C_eff during
charge windows, confounded by zone draws and DHW draws in the same minutes. TempIQ does exactly this
(pure-charging COP, session calorimetry in `hydronic-cop-calculator.ts`) with tank mass from
`hvacSystemConfig.learnedThermalMassGallons`, defaulting to `EFFECTIVE_THERMAL_MASS_GALLONS = 150`.
A2W measured C_eff = 110 gal [90, 125] (`ceff-resolution.md`). Whether TempIQ's learned value is 110 is
not visible from here; if it is still 150, every TempIQ hydronic COP is overstated by ~36 %.

### 3.3 The COP feed is dead since Sep 28 — and it is our doing

- `tempiq_cop_points` newest point: **2026-09-28 20:30 ET**. Every read since reports `cop: +0`.
  TempIQ's winter scoreboard `copByBand` is `{}` for the weeks of Oct 5, 12 and 19.
- **Mechanism (code-confirmed, timing matches):** the quarantine seam (#139) went live 2026-09-29 18:29Z.
  TempIQ's writer path calls `learnSystemMetrics(…, { excludeExperiments: true })`
  (`learning-scheduler.ts:4970`); `experiment-exclusion.ts` quarantines *every* a2w window kind except
  `awt_identification` — bank, sanitize, autopilot, boost, storm, manual; and the hydronic COP v3 session
  path drops any charge session overlapping a window (`hydronic-cop-calculator.ts:1681–1691`, "Session
  quarantine: dropped N perturbed session(s)"). Measured in the mirror: since Sep 30, **96.7 % of hours
  (466 of 482) fall inside a bank, sanitize or autopilot window** (105 bank windows = 320 h, 33 sanitize
  = 110 h, 18 autopilot = 41 h). There is no un-quarantined charge left to measure.
- The quarantine is *correct for U4* — a2w-driven AWT is endogenous there (TempIQv2#2043). Applying it
  to COP measurement is a category error: a charge's COP at its sink temperature is a valid measurement
  whoever set the target, and a2w's deliberate sink variation is the best COP-vs-water-temperature data
  this house will ever produce. The design in `cross-system-optimization-plan.md` §6.2 assumed TempIQ's
  `cop_measurements` would keep flowing *because* A2W was varying the sink.
- The one thing not checked here: TempIQ's own worker log line for the dropped-session count.

### 3.4 What runs on the dead feed

- A2W's `cop_anchored: true` is a 60-day energy-weighted anchor over September's mild-weather points
  (outdoor 56–75 °F, sink ~100–115 °F) Carnot-extrapolated to 30 °F. The winter DP's `saved_pct`, the
  realized ledger's `copNow` (every October day is `confidence: modeled`), and the /curve iso-COP
  background are all this extrapolation. **There is no measured COP in heating conditions.**
- The winter DP's load term uses `tempiq_zone_physics` UA — all 18 zones are `source = default`,
  confidence 0.0035–0.35. Shadow only, but `dp_kwh` forecasts nothing.

### 3.5 What *is* measured, and good

- Daily pump energy per circuit from SPAN local (above). The Oct 18 cold night (avg 40.4 °F, min
  28.9 °F): 52 kWh, stage 1 called 36 % and stage 2 17 % of samples, backup 0, tank recovered on pump 1
  alone most of the night.
- TempIQ's scoreboard intensity: 2.43 kWh/HDD65 (week of Oct 5), 2.62 (week of Oct 12), against last
  winter's 2.3–6.1. Metered, weather-normalised, the claim-grade number by the net-accounting doctrine.
  It needs no COP. It is the one cost signal that is currently honest.

---

## 4 · Cost — can A2W + TempIQ know it accurately?

Not today. Four independent defects, in order of how easy they are to fix.

### 4.1 A2W's realized-savings energy basis is ~14× too high (bug, one line)

`store.getRealizedDayInputs` sums `span_energy.kwh` per day, but spanwatch stores SPAN's
*day-cumulative* kWh in each hourly row. The sum of 24 cumulative values is not a day's energy:

| day | ledger `actual_elec_kwh` (sum) | true (max of the day) |
|---|---:|---:|
| Oct 16 | 255.9 | 18.1 |
| Oct 17 | 299.9 | 27.4 |
| Oct 18 | 686.1 | 49.9 |

Every `energy_metered` day since 2026-07-19 (47 of 94 ledger days) is inflated, and `savedUsd` scales
with it: the ledger claims $41.00 saved on Oct 18 at a modeled COP. The dashboard savings card reads
this table. Fix: `max(kwh)` per day instead of `sum(kwh)`, then recompute the 45-day window.

### 4.2 TempIQ prices hydronic heat at COP 1.0 (TempIQ-side)

`/api/insights/zone-energy` → `costAttribution` for all seven hydronic zones: `systemCOP: 1`,
`copProvenance: identified_hydronic`, `copIsMeasured: true`, giving `costPerDegree` $0.51–1.71/°F and
`sustainingCostPerHour` up to $0.80/h — the house priced as resistance heat. Likely mechanism, from
code and the mirrored points (not confirmed against TempIQ's database): `getHydronicCalorimetricCOP`
reads the last 120 days of `cop_measurements`, which after Sep 28 is only September's 50–60 °F bands; its
Carnot-fraction path is clamped `max(1.0, …)`, and the 50 °F band's energy-weighted fraction is dragged
down by charge sessions recorded with 61–64 °F sink temperatures (0.24 with them, 0.31 without, in the
mirrored copy). Whatever the arithmetic, a COP that equals the clamp floor is surfacing as *measured*;
the certificate layer (`cop-measurement-certificate.ts`) exists to stop exactly that.

### 4.3 Two rates

A2W: `ELECTRIC_RATE_USD_KWH` (default $0.30). TempIQ: `utility_config` (flat $0.15 when no row exists;
the commissioning item "set the real $/kWh from the bill in TempIQ" in `cross-system-optimization-plan.md`
§10 is still unchecked). Flat rate + 1:1 net metering means there is exactly one number, and it belongs
in both places.

### 4.4 No measured COP in heating conditions (§3.3)

Even with 4.1–4.3 fixed, "$ per delivered BTU this winter" is a Carnot extrapolation from September
until the quarantine is lifted from COP measurement.

### 4.5 What accurate looks like, with data already flowing

- **Electrical** from SPAN local per circuit (pumps, element, circulators — the ledger set of §8.1).
- **Thermal** by tank calorimetry at C_eff 110 during charges, with zone-draw subtraction — *or*, more
  honestly, no per-charge COP at all for the headline: the weather-normalised daily ledger (kWh per HDD
  vs the 2025-26 baseline) is the claim-grade number, and COP stays diagnostic.
- **COP measurement un-quarantined** from a2w's bank/sanitize/autopilot windows (keep the quarantine for
  U4), so TempIQ's band COPs and A2W's anchor are measured at the sink temperatures we actually run.
- **One rate**, from the bill, in both systems.

---

## 5 · Ranked next actions

Mine, small PRs, mild-day deploys through the gate:

1. `getRealizedDayInputs`: sum → max of `span_energy.kwh` per day; recompute the ledger (§4.1).
2. File on TempIQ: COP measurement must not quarantine a2w's bank/sanitize/autopilot windows (U4 keeps
   them); and a calorimetric COP at the 1.0 clamp must not surface as `copIsMeasured: true` (§3.3, §4.2).
3. A2W's own per-charge COP from `span_readings` + `slx_readings` tank rise at C_eff 110, shadow,
   diagnostic — the inputs are already in the mirror (§3.1).
4. Compare `readings.outlet_c` with `slx_readings.tank_f` during charges to measure `BUFFER_MARGIN_F`.
5. The stale 139.9 °F operative target (§2) — it is blocking identification and skewing `plan_scores`.

Owner:

- ~~Decide whether Living Room Baseboard and Dining should be heated by the loop.~~ **Answered
  2026-10-19: comfort-only, occasional (§1).** One consequence to know before the first baseboard call:
  a Nest switched to HEAT at 68 °F in a 56 °F room is a 12 °F deficit, and the deficit channel grants
  6 °F of supply per °F of deficit (`ESCALATE_F_PER_DEG`), so the tank goes to the 135 °F cap at once and
  stays there until the Xmas Room recovers. Pre-warming Den/Office and the Xmas Room with their Kumos
  first, then enabling the loop, is the cheaper path — exactly the #22 recommend-only card, which needs
  a live hydronic COP to price (§3.3). The "is baseboard ever the cheapest source" question is the same
  computation: TempIQ's mini-split COP by band (~2.6 at 46 °F for that cluster, Bayesian) against the
  hydronic COP at 135 vs 120 °F; it probably only flips in deep cold when the splits derate and defrost.
- Verify the three delivery types in TempIQ (unchanged since September; Upstairs Bathroom binds 75 % of
  calling hours with no ceiling).
- Put the real $/kWh in TempIQ `utility_config` and the planner's `ELECTRIC_RATE_USD_KWH`.
- Measure the DHW floor (#138.2). It is the number that actually governs the tank, every hour.

## 6 · What this could not see

TempIQ's production database (calorimetric band rows, `learnedThermalMassGallons`, `utility_config`),
the Pi, and the HBX panel itself. Everything above is from the a2w mirror restored from the
2026-10-20T01:44Z backup, the planner's public `/health`, and source in both repositories.
