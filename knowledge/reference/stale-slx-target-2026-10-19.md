# The SensorLinx-reported HBX target is a frozen snapshot, not the operative target (2026-10-19)

**Question.** On 2026-10-19 the planner commanded the 120 °F curve at 15:04 ET (and every hour after), yet
SensorLinx reported the tank target as 139.9 °F — the 14:09 sanitize soak — for the next 12+ hours while the
tank coasted 141 → 127 °F and the HBX called no stage. The identification driver stalled on it ("last command
119 °F not yet adopted, operative 139.9 — base not settled") and `plan_scores` scored the plan 20 °F off.
Deep dive §2 (`tempiq-data-deep-dive-2026-10-19.md`) flagged it; this is the answer.

**Verdict.** Device/cloud behaviour, not a planner bug, and the planner was reading it wrong. The field the
planner stores as `tank_target_f` (`temps.temp1.target`) is refreshed by the device **while a stage is called
and at call boundaries; while the device is idle it freezes** at the last value it computed. After a
*lowering* command the device stops calling at once — it is on the new curve — but keeps *reporting* the old,
higher target until the tank has decayed to the **new** call threshold, which after a soak or bank is 7–16 hours
later. The "adopts on the next reheat cycle" model in `writes.ts` and the 2026-07-16 memory described the
**report**, not the device. Since 2026-07-16 there have been 54 such stretches of ≥ 3 h, every one after a
soak or bank, and `adoption_pending` was true for 49 % of the samples in the identification driver's first three
armed days. The fix (this doc's PR) makes the driver, `plan_scores` and the identification-window compliance
recognise a provably stale report and use the curve in force instead. Nothing on the device side can be
changed: the device object carries no second target field.

Everything below is from the local restore of `a2w-db-2026-10-20T014442Z` (`scripts/analyze-local.sh`; data
to 21:44 ET Oct 19), the live planner `/health` at 03:48Z Oct 20, and the planner source at `8f93b19`. No
production query was run.

---

## 1 · The Oct 19 afternoon, sample by sample

| ET | event | reported target | tank | stages | source |
|---|---|---:|---:|---|---|
| 14:04 | auto-pilot sanitize 140 °F **rejected**: I1, pump2 at 125.6 °F | 119.5 | 119.9 | — | `hbx_writes` 1370 |
| 14:09:18 | `set_target` 141/137 (output 140 at 54 °F) **accepted**, echo verified | 119.5 | 119.8 | {f,f} | 1371, `hbx_config_versions` 903 |
| 14:14 | report refreshed, stage 2 called | **139.9** | 118.2 | {f,**t**} | `slx_readings` |
| 14:44 | call ends at 142.6 °F (= target + htDif/2) | 139.9 | 142.6 | {f,f} | |
| 15:03–15:04:09 | one-sample stage-2 closure; pump2 "heating" for one 60-s frame, outlet 145 °F | 139.9 | 141.0 | {f,t} | `slx_readings`, Pi `readings` |
| 15:04:13 | `set_curve` 120/118, dot 28 **accepted**; the device reconnected 13 s before the PATCH (`connectedAt` 19:03:38Z, `updatedAt` 19:03:51Z) | 139.9 | 141.0 | | 1372, version 904 |
| 15:19:15 | `set_target` 129/125 ("afternoon bank to 128 °F") accepted | 139.9 | 139.8 | {f,f} | 1373 |
| 15:24 | tank crosses 137.9 °F = 139.9 − htDif/2, the threshold a device *at* 139.9 must call at | 139.9 | 136.8 | {f,f} | |
| 15:29 → 21:44 | 77 samples: tank 133.9 → 126.9, `hd_active` true, `backup_called` false, **no stage called**; both pumps idle at 60 s (checked 15:06–15:42) | 139.9 every sample | | {f,f} | |
| 16:04 … 19:04 | `set_curve` 120/118 at :04 and `set_target` 129/125 at :19–:24, every hour, all accepted | 139.9 | 130 → 129 | {f,f} | 1374–1380 |
| 03:48Z Oct 20 | `/health`: `curve.in_force` = {dot 29, wwsd 125, dbt 120, mbt 118, output 119.7}, `identification.lastResult` still "not yet adopted (operative 139.9)" | 139.9 | | | live |

The HBX's hot-tank differential is `htDif` 4, centred: in the same morning's data calls began at tank
117.1–118.7 °F against a 119.5 °F report and ended at 121.5–122.2 °F. A device genuinely driving to 139.9 °F
would therefore have called from 15:24 on. It never did, with heat demand present (`permHD` 1, `hd_active`
true in every row), WWSD far away (125 vs 44–54 °F outdoor) and no backup. With the tank at 127–133 °F the
device was satisfied against the 120 curve (output 119.5) or the 128 bank — exactly what the planner had
written. **The operative target was the command; the report was stale.** The 60-s pump telemetry rules out
even a short unobserved call between 15:06 and 15:42, when the tank passed the old threshold.

The 15:03 stage-2 closure (tank 141.0, above the target) preceded the write by four seconds and is unexplained;
seven of 22 call starts at :03–:05 since September began with the tank above the report, against 57 of 345 at
other minutes, so it is not a planner artefact worth chasing here.

## 2 · How often, and when (since 2026-07-16)

**When does the report change?** Of 715 changes of `tank_target_f` in 26,244 connected samples:

| moment | changes |
|---|---:|
| at a stage-call **start** (previous sample idle) | 420 |
| at a call **end** | 47 |
| **mid-call** (a stage on in both samples) | 223 |
| idle, no stage transition | 25 — six of ≤ 0.3 °F (outdoor drift), 18 of > 1 °F, none within 6 min of a planner write |

Mid-call, the report tracks planner writes within one poll in **both** directions (58 mid-call jumps ≥ 3 °F,
e.g. 10-15 17:05 125 → 120 five minutes after a `set_curve`, 10-18 06:05 132.5 → 121). So the device adopts a
PATCH promptly whether or not it is calling; only the *report* depends on calling. A raise therefore looks
instant — the tank is usually below the new threshold, a call starts within a poll and refreshes the report —
and a lowering looks like a multi-hour "adoption lag".

**Stale stretches.** Reported target > command + 3 °F, tank < reported − 2 °F, no stage called, grouped into
runs:

| run length | runs |
|---|---:|
| 30–60 min | 18 |
| 1–3 h | 24 |
| 3–6 h | 25 |
| ≥ 6 h | 29 |

All 54 runs of ≥ 3 h are reported-above-command: post-soak values of 137–140.6 °F or post-bank values of
126–128.5 °F against the 119–121 °F floor curve (the 128 °F bank in a few). Every one ends at the next call,
which starts with the tank at 112–121 °F — the **command's** threshold, not the report's. The longest: 16.2 h
(08-11 19:53 → 12:03), 15.5 h (08-15), 13.5 h (09-10), 13.4 h (09-17). The reverse case — report *below* the
command, a raise not yet reported — is 0.3–0.9 % of samples; three stretches ≥ 1 h since September, two of them
an odd exact **110 °F** report (09-27 12:33–14:23, 10-05 → 10-06 04:25) that no write explains.

**Share of time `adoption_pending` is true** (`|midpoint − reported| > 3`):

| period | samples | pending | report above command | below |
|---|---:|---:|---:|---:|
| 2026-07-16 → 08-31 | 12,141 | 32.5 % | 32.3 % | 0.3 % |
| 2026-09-01 → 10-16 | 13,257 | 40.8 % | 39.9 % | 0.9 % |
| 2026-10-17 → 10-19 (identification armed) | 841 | **49.0 %** | 48.5 % | 0.5 % |

**One more quirk**, seen whenever a call refreshes the report right after a `set_target`: the first refreshed
value is often `mbt`, the second the curve output (04:34 131 then 05:34 134.4 for 135/131; 10-18 07:10 124 then
07:15 127.5 for 128/124). If the call ends between the two, the report sits at `mbt` for the next idle stretch
(07:49–08:49: 125 for the 129/125 bank, output 128.5). Harmless, but it is why a "settled" report can read
3 °F under the command.

## 3 · Is there a field that distinguishes the latched target from the curve output?

No. In all 16 `hbx_config_versions.raw` / `reread_raw` objects, `temps.temp1.target`, `temperatures[0].target`,
`tB1[2]` and `temperatureBox1[2]` are the same number. The current objects also carry `hotTankSetpointMax` /
`hotTankResetMin` (= `dbt` / `mbt`) and `dhwTarget` (= `dhwT`): aliases of the config, not a computed output.
`drift.ts` reads only the config fields, so the drift detector is unaffected. The curve output has to be
computed (`curve.ts curveOutputF`, `shadow.ts curveTargetF`), which `/health.curve.in_force` and
`writer.status().curve_in_force` already do.

## 4 · What read the report as the operative target, and what changes

| consumer | before | after (PR) |
|---|---|---|
| `identify.ts maybeStart` — "base settled" gate | idles while `adoption_pending`, i.e. ~half the time, and all evening after a bank/soak | when the physics **prove** the report stale — report > command + 3, tank below report − (htDif/2 + 1) and at or above the command's own threshold, heat demand present, no call for three consecutive polls — the base is the curve output at the live outdoor (`status().curve_in_force.output_at_live_outdoor_f`, else the midpoint). An unproven report still idles the driver, and `lastResult` says which piece of the proof is missing |
| `plan_scores` (`store.hourlyActuals`, `index.ts scoreOnce`) | `actual_target_f` = hourly mean of the report; `gap_f` = report − plan (+19.9 °F for 15–18h on Oct 19) | new columns `commanded_target_f` (the curve in force at each sample's outdoor, hourly mean) and `reported_stale` (the hour's samples prove the report frozen); `gap_f` scores against the operative basis. `actual_target_f` keeps the report. The hourly rescan covers the last 26 h, so the two dashboards' "avg gap 24 h" (`hbx`, `savings`) correct themselves on deploy |
| `store.windowStats` compliance (identification windows and quarantine windows posted to TempIQ) | sample compliant iff `|report − command| ≤ 3` → an up-probe written during a stale stretch posts compliance 0 | a sample is also compliant when the report sits above the command and the device is provably not driving to it (same proof, per sample). The proof can only *disprove* the report, never the command: with the tank satisfied, an idle device is consistent with any command below it, and the single-writer invariant leaves no third candidate |
| `writer.status()` | — | adds `ht_dif_f` (the live differential) so the margin follows the device's setting |

The pure predicate lives in `planner/src/stale-target.ts` (constants: 3 polls, 20-min span, margin htDif/2 + 1 °F,
default htDif 4 → 3 °F) with `stale-target.test.ts`; the driver cases are in `identify.test.ts` §9; the SQL is
proven by `scripts/stale-target-local-check.ts`, which replays the real 14:00–19:00 series into a scratch
database and asserts the stale hours, the compliance values and the plan-score round trip.

**Left as they are, deliberately:**

- `index.ts checkAdoption` (the "HBX target not adopted" alert). Its raise-only backstop (owner, 2026-08-06)
  was right for a reason this doc now states exactly: after a lowering the device *is* on the new target, so
  nothing is wrong. Signal (a), "a reheat ran while still diverged", fires only when a call fails to refresh
  the report — which is a real failure. No change.
- `writer.status().adoption_pending` and the dashboard chip "adopting next cycle" (`control-client.tsx`). Still
  true as a description of the report; a cosmetic follow-up is to run the same proof in `status()` and show
  "report frozen, device on the curve".
- `checkI1` (`index.ts`) compares the *report* + margin against pump setpoints. A frozen high report makes it
  stricter, never looser; the write path's own I1 check uses the commanded target.
- `writes.ts` header and the 2026-07-16/17 memories: "adopts on the next reheat" is now known to describe the
  report. Not rewritten here; this doc is the correction they should point at.

## 5 · Found on the way, not fixed

- **The auto-pilot alternates two writes an hour after the soak.** 15:04 `set_curve` 120 ("DHW window
  floor"), 15:19 `set_target` 128 ("afternoon bank to 128 °F"), 16:04 curve again, 16:19 bank again — eight
  accepted writes in four hours (ids 1372–1379), the device flipping 120 ↔ 128 each time, invisible in the
  report. The hourly plan apply and the bank path disagree about the same hour. Worth its own issue: it burns
  the 15-min write slot and makes `commanded_target_f` a 50/50 blend in those hours.
- The exact **110 °F** report (three idle refreshes, July–October) and the 15:03 stage-2 blip are unexplained.
- Whether the device adopts a lowering at the PATCH or at the end of a call in progress cannot be told apart
  from this data (both predict what was seen). It does not matter for anything above.

## 6 · What this could not see

The backup ends at 21:44 ET Oct 19, so the end of this particular stretch (the next call, expected once the
tank reaches ~118 °F) is not in the data; `/health` at 03:48Z Oct 20 showed it still open. The planner's own
`autopilot_log`/`hbx_writes` show it kept commanding the plan throughout; the house was never under-heated by
this — the tank sat 7–13 °F above the floor the whole time.
