<!--
@purpose The empirical test that settles #89's sizing question. Written in shoulder season
(2026-09-16) deliberately, so it is ready before the first cold snap rather than being
improvised at 2 am in January. Most of it now happens AUTOMATICALLY -- see "What #101 already
captures" -- so this is the fallback + the interpretation guide.
-->

# Cold-snap baseboard test — does the emitter actually deliver at 135 °F?

## The question, narrowed

#89 frames this as "baseboard linear footage vs room heat loss, which nobody has quantified".
Two facts narrow it a long way:

1. **Only 2 of 18 zones are baseboard** — `Upstairs Baseboard` and `Living Room Baseboard` —
   and those are exactly what drive the floor divergence. Nothing else needs testing.
2. **None of the three candidate models is measured.** TempIQ's curve is anchored to
   `demonstrated_max` (circular). A2W's local model is a fin-tube parametric topping at 135 °F.
   TempIQ's per-zone `ua_btu_hr_f` is `source='default'`, confidence ≤0.15. All three are
   assumptions.

So the test is: **on a cold day, with a baseboard zone calling, does the room hold setpoint
when the supply sits near the local model's number rather than TempIQ's?**

## What #101 already captures automatically

`zone_floor_snapshots.zones` now persists `roomF` and `setpointF` per zone alongside `awtF`,
`localF`, `ceilingF` and `ceilingSource`. So for every hour of the first real cold snap you
get, per zone: what supply was commanded, what the two models each wanted, and **whether the
room held**. In most cases that answers the question with no manual intervention at all.

Query it with:

```sql
SELECT ts, z->>'name' AS zone,
       (z->>'awtF')::real  AS commanded,
       (z->>'localF')::real AS local_model,
       (z->>'ceilingF')::real AS tempiq,
       (z->>'roomF')::real AS room,
       (z->>'setpointF')::real AS setpoint,
       (z->>'roomF')::real - (z->>'setpointF')::real AS held_by
FROM zone_floor_snapshots, jsonb_array_elements(zones) z
WHERE z->>'deliveryType' = 'baseboard' AND (z->>'calling')::boolean
ORDER BY ts DESC;
```

**Read it as:** sustained `held_by >= 0` while `commanded` tracks `local_model` (well below
`tempiq`) is direct evidence the local model is sufficient and TempIQ's curve is over-specified.
Sustained `held_by < 0` is evidence the opposite way.

## The manual test, if the automatic capture is inconclusive

Only needed if the cold snap never coincides with a baseboard call, or the room data is stale.

**Preconditions:** outdoor ≤ 35 °F, sustained ≥ 4 h, one of the two baseboard zones calling.
Do NOT run this during an occupancy-sensitive period; a failed test means a cool room.

1. Record the starting state (the query above).
2. Hold the tank target at **120–125 °F** — the band where the two models disagree most
   sharply but which is still well above any freeze concern.
3. Hold for **≥ 3 hours**, long enough for the room to reach equilibrium rather than coast on
   thermal mass.
4. Record room temp vs setpoint every 15 min.

**PASS** (local model sufficient): room holds within 1 °F of setpoint for the final hour.
**FAIL** (TempIQ's higher curve justified): room drifts > 2 °F below setpoint and keeps falling.
**INCONCLUSIVE:** room drifts but stabilises — repeat colder; you are near the crossover.

**Abort** at any point if the room drops > 4 °F below setpoint; restore the normal floor.
The result is still informative — it bounds the answer.

## What a result unlocks

- **PASS** → keep `DEMAND_FLOOR_POLICY=escalate`, consider lowering `strictCapF`, and treat
  TempIQ's curve as advisory-only. The winter savings case holds.
- **FAIL** → the emitters really do need the higher supply; the honest conclusion is that this
  house needs more baseboard, not hotter water, and the project's savings ceiling is lower
  than assumed.

Either way it converts #89 from an argument between two unmeasured models into a measurement.
