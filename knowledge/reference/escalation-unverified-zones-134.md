<!-- @purpose Design note for #134 (cost-first escalation inert on zones with no TempIQ ceiling): the mechanism on main, three options with their risks, the smallest recommended step, the evidence and thresholds that decide, and a test plan. No code is changed by this note. -->

# #134 — the cost-first escalation and zones without a ceiling

Written 2026-11-21 against main at `7d64e75`. Design note only. Nothing under `planner/src` changes.

## 0 · Read this first: two facts that change the issue

**The three zones are no longer unverified, according to this repo's own records.** The issue (filed
2026-09-28) names Master Bathroom (60.5 % duty), Upstairs Bathroom (24.3 %) and Kitchen Radiant (2.0 %) —
duties from `tempiq-driven-efficiency-readiness.md:83-91`. The journal entry of 2026-10-30 and
`tempiq-data-deep-dive-2026-10-19.md:288` record that all three were written to TempIQ prod as
owner-verified radiant floor on 2026-10-29. I could not query production from this sandbox, so that is a
record, not a live check. It is consistent with what #300 showed at merge: `unverified_binding` null and
`unverified_binding_7d` `[]`. The headers of `unverified-binding.ts:8-9` and `index.ts:181-182` still say
"three zones are still unverified", which the records above contradict.

**Verifying a radiant zone did not give it any headroom.** The same deep dive measured the two radiant
zones that were already verified in October (`:87-91`): at ~40 °F outdoor the local model said 97.4 °F
and TempIQ's ceiling was 90.4–91.1 °F (`type_curve_default`, radiant 85→110 °F). A ceiling *below* the
local number cannot be escalated toward. So the wave-plan row N6o ("verify → the escalation gains a real
ceiling", `wave-plan-2026-10-18.md:37`) delivered a ceiling but zero degrees of reach. §1 shows why in
the code. Whether TempIQ's radiant curve ever crosses above the local one at colder outdoors is not
measured here; the two curves share the same top (110 °F), so it is unlikely.

The rest of this note treats #134 as what it now is: **no radiant zone, verified or not, can escalate
above its local model number**, and asks whether that matters.

## 1 · The mechanism (file:line on main)

| step | where | what happens |
|---|---|---|
| ceiling read | `planner/src/demand.ts:338` | `requiredSupplyF: num(o.requiredSupplyWaterTempF)` — null when TempIQ omits it (unverified type, or no fresh outdoor data: `demand.ts:21-25`) |
| gate | `demand.ts:225` | `useLearned = learnedSupply && localF !== null && z.requiredSupplyF != null` |
| null ceiling | `demand.ts:232-239` | `useLearned` false → the `else` branch: `awtF = localF`. `costFirstAwtF` is **never called**; `escalatedF` and `deficitF` stay 0 (`:230-231`), `learned` false, `ceilingF` null (`:242-243`) |
| same result inside | `demand.ts:188`, `:199` | even if it were called: `ceilingF = learnedF ?? localF`, then `Math.min(localF + bump, Math.max(localF, ceilingF))` = `localF` |
| ceiling below local | `demand.ts:197` | no evidence: `awtF = Math.min(localF, ceilingF)` — the floor sits at the *lower* TempIQ number |
| | `demand.ts:199` | any evidence: `Math.max(localF, ceilingF)` = `localF` — one jump up to local, then stuck. `escalatedF = max(0, awtF − localF)` = 0 (`:200`), so the snapshots cannot show it |
| local radiant model | `demand.ts:115-117` | `95 + ((55 − clamp(outdoor, 5, 55)) / 50) × 15` → 95 °F at ≥55 °F outdoor, 110 °F at 5 °F |
| live call | `index.ts:1618` | `proposeFloor(outdoorF, undefined, true, DEMAND_FLOOR_POLICY, zoneCallMinutes)`; policy defaults to `escalate` (`index.ts:321`) |

Run through the real functions (`node --import ./hub/node_modules/tsx/dist/loader.mjs -e …`):

```
costFirstAwtF(99.5, null, 60, 70, 600)  → { awtF: 99.5, escalatedF: 0, deficitF: 10 }   null ceiling, 10 °F deficit, 10 h calling
costFirstAwtF(97.4, 91,   70, 70, 0)    → { awtF: 91,   escalatedF: 0 }                 verified radiant, no evidence
costFirstAwtF(97.4, 91,   65, 70, 600)  → { awtF: 97.4, escalatedF: 0, deficitF: 5 }    verified radiant, 5 °F deficit
computeFloors(Master Bathroom, unverified, 40 °F, room 60 / setpoint 70, 600 min) → awtF 99.5, tank 104, learned false
```

**What tells nobody.** The MODEL DIVERGENCE warning needs `bindingZf?.learned` (`index.ts:1754`) and a
gap ≥ 10 °F (`:1756`). A null-ceiling zone is never `learned`; a verified radiant zone is ~6.5 °F apart.
Neither logs. The per-cycle UNVERIFIED warning is `index.ts:1738-1740`.

**What #300 added (1f449af, surface only).** `UnverifiedBindingWatch` (`unverified-binding.ts:81-149`),
stepped once per hourly plan cycle at `index.ts:1776-1782`, exposed at `index.ts:2724`. It opens an
episode when the binding zone has `verified === false` AND (deficit ≥ `DEFICIT_F` 1.0 °F OR binding for
≥ `STREAK_CYCLES` 6 cycles) (`:20-22`, `:71-74`); clears after `CLEAR_CYCLES` 3 false cycles or a
binding change. Three limits matter for §4: it returns false for `verified === true` and for `null`
(`:72`); it sees only the *binding* zone; and the week list is in memory, lost on every redeploy
(`index.ts:2723`).

### 1.1 The part the issue missed: the radiant floor does not set the tank

The demand floor only raises the plan target when it exceeds what is already there
(`shadow.ts:424-426`), and the result is clamped to the I4 band (`shadow.ts:460-462`; `bandFor`,
`shadow.ts:194-210`: lower line 95 °F at ≥55 °F outdoor → 135 °F at 5 °F; upper = as-found curve + 3,
capped at `strictCapF` 135, `shadow.ts:178`). With the DHW floor at its default 120 °F:

| outdoor °F | radiant local AWT | tank floor (+4.5) | I4 lower | what governs | bump needed before the tank moves |
|---:|---:|---:|---:|---:|---:|
| 55 | 95.0 | 99.5 | 95 | 120 (DHW) | 20.5 |
| 40 | 99.5 | 104.0 | 107 | 120 (DHW) | 16.0 |
| 30 | 102.5 | 107.0 | 115 | 120 (DHW) | 13.0 |
| 20 | 105.5 | 110.0 | 123 | 123 (I4 lo) | 13.0 |
| 10 | 108.5 | 113.0 | 131 | 131 (I4 lo) | 18.0 |
| 5 | 110.0 | 114.5 | 135 | 135 (I4 lo) | 20.5 |

(Computed from `requiredAwtF`, `bandFor`, `DEFAULT_OPTS`.) At every outdoor temperature the tank is
already held **13–20 °F above** what a radiant zone's floor asks for. The deep dive measured the same
thing: binding requirement 95–102 °F while the HBX held 120–140 °F, and "the demand floor has never
bound" (`tempiq-data-deep-dive-2026-10-19.md:93-95`). The escalation rate is 6 °F per °F of deficit and
6 °F per extra hour of calling (`demand.ts:157-161`), so a radiant zone would need a > 2 °F room deficit
or > 3 h of unbroken calling before a ceiling of any height changed a single tank target.

So today the inert escalation costs the house nothing: a radiant room that runs cold is running cold
with 120 °F+ water available to it, and more supply temperature from this code path is not what it is
missing. This holds while `DHW_FLOOR_F` stays near 120; the owner decides that around Nov 28, and the
env allows 112–125. At 112 the "bump needed" column drops by up to 8 °F in mild weather (5 °F at
30 °F outdoor, where the I4 lower line takes over) and not at all below ~24 °F.

## 2 · Options

No radiant slab temperature limit exists anywhere in this repo. Whether the radiant manifolds have a
tempering valve has never been inspected (#138 item 1, `tempiq-driven-efficiency-readiness.md:134-136`).
If one exists, tank temperature does not reach the slab and options A–B do nothing for a radiant room.
If none exists, the slabs already see 120 °F every hour, the 128 °F bank, 129–134 °F pre-boosts and the
140 °F soak. Either way the options below add no slab exposure the plant does not already have, as long
as their cap stays at or under those numbers.

### Option A — bounded synthetic ceiling for radiant zones

In `computeFloors`, when a radiant zone's ceiling is null or below local, use
`min(localF + N, CAP)` as the ceiling and let the existing `costFirstAwtF` run (deficit and streak).

- **Effect:** with N = 10 it never moves the tank (table above). To do anything N must be ≥ 16–20, i.e.
  radiant AWT up to ~120 °F, tank ~124.5 °F.
- **Slab:** no new exposure below ~125 °F tank, per the paragraph above.
- **I4:** unaffected; the clamp at `shadow.ts:462` and the writer's guard are downstream.
- **Cost:** the streak channel is the problem. Slab zones call for hours by design; Master Bathroom ran
  60.5 % duty last winter. "Still calling after 60 minutes" (`demand.ts:161`) is normal for it, so the
  streak would walk it to the cap and hold it there most of the season. Roughly 1 % COP per °F of tank
  (`tempiq-driven-efficiency-readiness.md:124`), on nearly every heating hour, on no evidence of a cold
  room. That is the outcome #90 was written to prevent.

### Option B — room-deficit evidence only, hard cap

As A, but radiant zones ignore the streak: only `setpoint − room` buys supply, capped at
`min(localF + 20, 120)` AWT.

- **Slab / I4:** as A.
- **Cost:** bounded by real deficits. Zero in a week with no deficit above 2 °F.
- **Risk:** the deficit channel is thin. `setpointF` is null whenever a Nest is OFF; Master Bathroom
  reported a setpoint in 0 of 97 October snapshots (`tempiq-data-deep-dive-2026-10-19.md:46`). With no
  setpoint this option is also inert, silently. A setback recovery (setpoint stepped up 4 °F) reads as a
  deficit and would buy a tank raise that a slab cannot use for an hour anyway.
- **Size:** about ten lines in `demand.ts` plus tests; it adds an emitter-type branch to a function that
  has none.

### Option C — owner verifies the delivery type in TempIQ (no code)

Done on 2026-10-29. Result, per §0: a ceiling arrives, it is below the local number, reach is still
zero, and with no evidence the zone's floor *drops* ~6 °F to TempIQ's number (harmless: §1.1). There is
no further owner step that creates headroom. Asking TempIQ for a higher radiant curve is out of scope
(TempIQv2 is not to be touched) and would be a generic curve, not a measurement.

### Option D — leave the code alone, keep #300 as the tripwire

- **Risk:** a radiant room falls behind and the planner does not respond. It would be visible in
  `zone_floor_snapshots` (room, setpoint, calling per zone, hourly) but not paged.
- **Cost:** none.

## 3 · Recommendation

**Option D now. Option B only if §4's trigger fires. Never A.**

1. Change no behaviour. The verification step is done, and §1.1 shows that any bounded headroom would
   be invisible to the tank at today's DHW floor. A fix that cannot change an output is not worth a
   deploy.
2. Re-scope #134 from "three unverified zones" to "radiant zones cannot escalate above local; held
   until a radiant room is measured falling behind", and note there that N6o did not create headroom.
3. Before any code: answer #138 item 1 (tempering valve). If a valve exists, B is pointless and the
   issue closes.
4. Two small follow-ups, each separate from this note and each optional: correct the stale "three zones
   are still unverified" comments (`unverified-binding.ts:8-10`, `index.ts:181-182`); re-read §1.1 if
   `DHW_FLOOR_F` is lowered on ~Nov 28.

If the trigger fires and there is no tempering valve, build B exactly as described: radiant only,
deficit only, cap `min(localF + 20, 120)`, behind an env flag that defaults off for the first week.

## 4 · Evidence and thresholds

**`unverified_binding_7d` cannot choose between A and B for these three zones**, because the watch
returns false for a verified zone (`unverified-binding.ts:72`). With the zones verified it will stay
`[]` all winter. What it can decide:

| reading of `/health.winter_solver.unverified_binding_7d` | meaning | action |
|---|---|---|
| `[]` for 7 days that include a night below 30 °F, while snapshots show the three zones `verified: true` | the unverified class is gone | re-scope #134 (rec. 2) |
| ≥ 1 episode, any zone | a zone is `verified: false` again, or a new unverified zone binds | owner re-verifies in TempIQ (C); not a code change |
| episode with `max_deficit_f` < 1.0 (opened on the 6-cycle streak only) | a slab calling for hours with the room at setpoint | none — this is the case that makes A wrong |
| ≥ 2 episodes in 7 d, each `max_deficit_f` ≥ 2.0 and `cycles_at_close` ≥ 6, `cleared_by: "condition_false"` or still open | an unverified radiant zone genuinely behind for 6 h, twice | C first; B only if it repeats after verifying |
| `cleared_by: "binding_changed"` with `cycles_at_close` < 6 | binding churn | none |

Read it before each gate-merge: the list is lost on redeploy, and this planner deploys several times a
week. An empty list after a deploy is not seven clean days.

**What decides D → B** is the same measurement taken from `zone_floor_snapshots.zones` (per-zone
`roomF`, `setpointF`, `calling`, `verified`, `localF`, `ceilingF`), which covers verified zones and
survives deploys. Trigger, all of:

- a radiant zone calling with `setpointF − roomF` ≥ 2.0 °F for ≥ 6 consecutive hourly snapshots (2.0
  because the tank only moves above ~2.2–3.4 °F of deficit at 6 °F/°F; 6 to match `STREAK_CYCLES`);
- on ≥ 2 separate nights within 7 days;
- the setpoint unchanged over those hours (not a setback recovery);
- the tank at or above its target in those hours (not a Pi dropout, pump fault or recovery);
- #138 item 1 answered "no tempering valve".

Anything less: stay on D. If rooms fall behind with the tank already at 120 °F+ *and* a tempering valve
exists, the fix is at the valve or the flow, not in the planner.

## 5 · Test plan

**For this note (done):** the four results in §1 and the table in §1.1 were produced by the real
`costFirstAwtF`, `computeFloors`, `requiredAwtF` and `bandFor` on this branch. Not done: no live
`/health` or TempIQ read (no network), so the verified state of the three zones rests on the journal.

**To confirm §0 on production (read-only, anyone with access):**

1. `/health.winter_solver.unverified_binding` and `_7d`.
2. Latest `zone_floor_snapshots` row: for the three zones, `verified`, `learned`, `ceilingF`, `localF`.
   Expect `verified: true`, `learned: true`, `ceilingF` below `localF`.
3. On the local restore: count snapshots since 2026-10-29 where any radiant zone has `ceilingF > localF`.
   If that is ever true, §0's second fact is wrong at that outdoor and option C has some reach after all.
4. Same restore: count radiant rows since 2026-10-29 with `ceilingF` null (TempIQ feed gaps; the
   baseboard zones had 142 such rows since Oct 1). That is the size of the remaining null-ceiling path.

**If option B is ever built** (`planner/src/demand.test.ts`, same assert style):

- radiant at 40 °F outdoor, null ceiling, deficit 3 °F → `awtF = localF + 18`, `escalatedF` 18;
- radiant, ceiling 91 < local 97.4, deficit 3 °F → the same, not stuck at local;
- radiant, 600 calling minutes, no room telemetry → `escalatedF` 0 (streak ignored for radiant);
- radiant, deficit 10 °F → capped at `min(localF + 20, 120)`; at 5 °F outdoor (local 110) the cap is 120;
- baseboard, null ceiling, deficit 10 °F → still `localF` (the existing assertion at
  `demand.test.ts:119-120` must keep passing unchanged);
- baseboard with a ceiling → every existing #90 / #136 assertion unchanged;
- mini-split → still no floor;
- flag off → byte-identical `computeFloors` output to main on a recorded snapshot;
- `shadow.test.ts`: a radiant floor escalated to the cap at 5 °F and at 40 °F outdoor still yields a
  plan target inside `bandFor` and ≤ 135 °F;
- `unverified-binding.test.ts` unchanged — the watch reads `roomF`/`setpointF`, not `escalatedF`.

Then a week in shadow with the flag off, comparing the would-be floor against the snapshots, before the
owner decides on the flag.

## 6 · Restore check, 2026-11-23 (§5 steps 2–4, owner chose "accept D + confirm on restore")

Run on a local restore (`scripts/analyze-local.sh`, snapshots up to 2026-11-23 03:05 ET), over hourly
`zone_floor_snapshots` since 2026-10-29: 608 per radiant zone.

| zone | verified | null ceiling | ceilingF > localF | mean localF − ceilingF | calling, deficit ≥ 2 °F |
|---|---:|---:|---:|---:|---:|
| Upstairs Bathroom | 586 | 153 | 0 | 7.3 | 73 |
| Master Bathroom | 586 | 153 | 0 | 7.3 | 32 |
| Kitchen Radiant | 586 | 153 | 0 | 7.3 | 0 |
| Dining | 608 | 131 | 0 | 7.3 | 0 |
| Mud Room | 608 | 131 | 0 | 7.3 | 0 |

- **§0 holds.** The three zones are verified in every row after 2026-10-29 20:36 ET (the 22 unverified rows are all
  from Oct 29). The TempIQ ceiling was **never** above the local number, so verifying them bought zero reach.
- **The null-ceiling path is real: about 25 % of hours** (131–153 of 608), from TempIQ feed gaps, so §1's
  `useLearned` false branch still runs one hour in four.
- **The D → B trigger has not fired.** There are five calling runs of 6 h or more with a deficit ≥ 2 °F, all in the bathrooms:
  Master Bathroom on Oct 31 (9 h) and Nov 1 (12 h), and Upstairs Bathroom on Nov 1 (25 h), Nov 2 (20 h) and Nov 22 (10 h). The
  setpoint changes inside every one of them (for example 70 → 73.8, 70 → 75.2, 70 → 72.7), which is the setback
  recovery the trigger excludes. No zone has two such nights within 7 days since Nov 2.
- **Watch Upstairs Bathroom.** It has the most deficit hours, and its Nov 22 run (10 h, up to 5.2 °F below) is
  the nearest to the trigger. The snapshot's `tank_target_f` (100–106 °F) is the floor-derived target, not the HBX
  tank, so these rows cannot show whether the tank was at target. The next look needs `slx_readings` for the same hours.

Status: **D stands.** #134 is re-scoped as in §3, rec. 2. #138 item 1 (the tempering valve) is still open.
