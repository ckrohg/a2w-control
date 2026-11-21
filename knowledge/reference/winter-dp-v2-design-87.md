# Winter DP v2 (#87) — design note: TempIQ's required supply at FORECAST outdoor, consumed cost-first

> Design only, no code. Written 2026-11-20 against `planner/src/winterdp.ts`, `shadow.ts`,
> `demand.ts`, `forecast.ts`, `index.ts` (plan assembly ~1770–1960), the A-8 contract
> (`tempiq-demand-forecast-contract.md`, incl. the 2026-08-27 amendment) and the
> commissioning playbook (`winter-dp-commissioning.md`). The #89 numbers are the 2026-11-02
> restore check. Owner decisions relied on: 2026-11-20 "FORECAST_FETCH_ENABLED=1 after the
> merges" and the #89 brief's "flip fetch only, not pre-heat"; 2026-11-02 "the element never
> closes on the generator or an unknown supply" (#241/#273); the SPAN "Buffer Tank" breaker is
> kept OPEN (commissioning playbook, 2026-10-19).

## 0. Where we actually are (this changes #87's wording)

1. **The feed partly exists.** `GET /api/insights/zones/required-supply-forecast`
   (TempIQv2#2017) is live: each owner-verified hydronic zone's reset curve evaluated at the
   forecast outdoor, 48 h, weather vintage refreshed 6-hourly, provenance block included.
   `forecast.ts` already parses it, and `planPreheat` / `predictedCapRisk` are wired in
   `index.ts` behind two gates that default OFF. What **TempIQv2#2009 still owes** is: a
   `measured` design anchor (the U4 learner has zero readers), `delivery_type_source`
   (`deliveryTypeVerified` is never emitted), and `p_call` — which Phase 0 killed (STOP:
   1 of 7 zones predictable, the wrong one). `p_call` is not coming.
2. **So requirement 2 cannot read `p_call × confidence`.** The amendment replaced it with
   evidence: *only a zone that is CALLING NOW earns a forecast-driven raise, and only for its
   own requirement.* v2 keeps that. `PREHEAT_CONFIDENCE` stays a reserved, documented knob
   with no effect; if a predictability signal ever ships it plugs in there as a multiplier.
3. **#89 makes the shipped pre-heat unsafe to flip as-is.** `planPreheat` raises to TempIQ's
   raw number + 4.5 °F. TempIQ's anchor is now `demonstrated_max` (the plant's as-found p99,
   164.7 °F), and its ceiling sits above A2W's local model by:

   | outdoor °F | ≥ 60 | 50–55 | 40–45 | 35–40 | 30–35 |
   |---|---|---|---|---|---|
   | TempIQ ceiling − local | 12 | 18 | 26 | 31 | 32 |

   The ceiling crosses the 135 °F pump cap below about 41 °F outdoor. Flipping
   `FORECAST_PREHEAT_ENABLED` today would pin the tank at 135 °F whenever a baseboard calls
   on a sub-41 °F night. Both baseboard zones are comfort-only and normally OFF, so that is a
   pure cost regression on the nights that matter. Verdict on which model is right: unknown
   until a ≤ 20 °F test night. **v2 is the redesign that makes the flip safe.**

## 1. The one idea: the forecast number is a CEILING on the time axis too

Live floor today (#90, `costFirstAwtF`): start at the cheap local number, treat TempIQ's as a
ceiling, let room deficit or an unbroken call streak (+6 °F per hour after the first free
hour) decide where between them we sit. v2 applies exactly that function to future hours:

```
requirement(zone, hour h) = costFirstAwtF(
    localF   = requiredAwtF(type, forecastOutdoor_h),       // A2W's model at the FORECAST outdoor
    learnedF = TempIQ requiredSupplyWaterTempF for hour h,  // the feed; CEILING, never a floor
    roomF, setpointF,                                       // today's room evidence
    callMinutes                                             // today's unbroken streak
) + BUFFER_MARGIN_F,   then min(·, strictCapF)
```

What that buys:
- a brand-new baseboard call at 38 °F forecast raises H and H+1 to local+margin (≈ 112 °F),
  not 135 °F. The first hour of a call is free in `costFirstAwtF`, so a fresh call never
  pre-heats to the ceiling;
- a zone that has been calling 90 min and still is gets its streak carried forward (+3 °F),
  which is exactly what the live floor would say an hour from now if the call persists —
  anticipation of a ramp already in progress, nothing speculative;
- TempIQ's `demonstrated_max` can only ever bound the raise from above. It cannot pull the
  plan up on its own. That is how v2 avoids importing a possibly circular anchor as a floor
  (the anchor is a record of what the old HBX curve ran; if A2W followed it, A2W's own
  writes would become the next p99 — gtm#1601's ratchet).

Provenance gate on top: `forecast.ts` will parse `resetCurve.designSupplyFSource` per zone
(the payload carries it; we drop it today). `type_curve_default` and `demonstrated_max`
ceilings are **advisory** (ceiling only, as above). Only a `measured` anchor may, later, be
allowed to raise directly — and that is a separate owner decision after #2009 ships it.
Every decision in `meta.preheat.decisions` records the zone's `ceilingSource`, so the
two-week review can tell what the ceiling was made of.

## 2. The five requirements, v2 reading

**R1 — DP future floors may only RAISE relative to today's baseline.**
Today (`index.ts` ~1786): `floorF_h = min(strictCap, max(dhwFloor, allZonesLocal_h,
mimic_h, band.lo))`, with `proposeFloor(o, null)` = conservative all-zones LOCAL posture.
v2: `floorF_h' = max(floorF_h, preheatRequirement_h)` for the hours that have a pre-heat
requirement (the current block and the next, for calling zones only); every other hour is
byte-identical. The TempIQ number never enters `floorF` except through the cost-first
function above. Not changed: `capF`, the solver, the `WINTER_DP_ENABLED` gate (still OFF,
go-live criteria in the playbook still apply).

**R2 — pre-heat gate, H−1 lift, ordering.**
Gate = zone calling now (call feed healthy; `null` or `[]` → no raises, the deliberate
inversion vs `computeFloors`) AND forecast feed healthy (our fetch < 2 h old, weather vintage
< 8 h, `degradeReason` null). `planPreheat` already lifts block i to max(need_i, need_i+1),
so the hour before the rise (H−1 in #87's words) is covered and there is no sawtooth. It
runs LAST among the raise passes, sanitize blocks are skipped, storm raises on top are left
alone, the band ceiling bounds it, and strictCap bounds the band. The reactive live floor
(#136 per-poll re-check) is a separate pass on the current block and is never lowered by
any of this; pre-heat lifts are not written into `floorCadence.raises`. Where it bites: only
when a demand floor or shaped curve (#133) is in force. Under the plain winter-guard mimic
the plan already sits at the as-found curve and `need ≤ target` yields nothing.

**R3 — predictive cap-watch (afternoon, email tier).**
Today `predictedCapRisk` fires when TempIQ's raw number + margin > strictCap. With the #89
ceiling that is every night below ~41 °F: a daily page all winter, for a model we do not yet
trust. v2:
- **attention tier (one email, key `cap-predicted`)** when the *cost-first* projected need
  exceeds strictCap: local model at forecast outdoor + the escalation a zone carries right
  now + margin. With the baseboards OFF that happens when the local model itself crosses
  (≈ ≤ 10 °F outdoor), or when an already-escalated zone is projected to. Text unchanged in
  spirit: a capacity warning, not a call prediction; decision = seasonal cap raise.
- **record tier** (weekly digest line, no mail) when only TempIQ's ceiling crosses. That is
  the #89 question being asked of the data, not an owner action.
- **test-night notice, attention tier, once per season (key `cap-test-night`)**: the first
  forecast with a minimum ≤ 20 °F. "Tonight is the #89 test night: watch the baseboard
  rooms; `zone_floor_snapshots` will show whether 135 °F held them." This is the one event
  that actually resolves the verdict, so it earns the email.

**R4 — degraded-mode parity.**
Feed absent, our fetch ≥ 2 h stale, vintage ≥ 8 h, unparseable, or no zone with hours →
`forecastFeed.forecast()` is null → no pre-heat pass, DP floors as today, cap-watch as today.
"Byte-identical" is defined on the plan blocks and the commanded writes. `/health.
demand_forecast` and `meta.preheat` may differ (they report the degradation); nothing else
may. The same holds with the feed healthy and `FORECAST_PREHEAT_ENABLED` off: blocks
identical, decisions recorded with `skipped: "shadow mode"`.

**R5 — /hbx.**
Add a `preheat?: true` block flag (the existing `sani`/`bank`/`boost`/`storm` pattern; the
poster already classifies from reason text, which keeps "pre-heat:" / "forecast demand:").
The Practice-plan card on `analytics-mirror/app/hbx/page.tsx` already reads
`shadow_plans.meta`; show one "Forecast pre-heat" list from `meta.preheat.decisions`: hour,
from → to, zone, ceiling source, applied / why skipped, and the feed's vintage age from
`/health.demand_forecast`. Rows carrying the flag get a marker in the plan list. Nothing
else on the page moves.

## 3. Cap and element policy (consistent with the owner's rules)

- **The planner's commanded target never exceeds `strictCapF` (135 °F) from any forecast
  path.** Not the DP floor, not pre-heat, not the cap-watch. The sanitize soak's 140/145 °F
  is the only everyday excursion above it and is untouched.
- **Above 135 °F is a human decision, not a planner lever.** The playbook's rule stands:
  seasonal `strictCapF` raise in ≤ 5 °F steps after rooms are observed cold, never a relaxed
  I1. The forecast's job is to make that decision an afternoon email instead of a 2 am alarm.
- **The element is not a comfort lever.** TempIQ's ceiling below ~41 °F outdoor can only be
  met with the 16.5 kW element at COP 1. The SPAN "Buffer Tank" breaker is kept OPEN; A2W's
  backup gate closes it only when a pump has failed or both pumps cannot hold the tank, and
  **never on the generator or an unknown supply** (#241/#273). v2 adds no path from a
  forecast to the backup gate, and the DP keeps pricing anything above `capF` as unreachable
  rather than as COP-1 heat. If the ≤ 20 °F test night shows rooms cold at 135 °F, the
  answer is the cap decision above, or the baseboard thermostats (comfort-only zones), not
  the element.
- **Generator:** unchanged; on the generator the outage heat is both pumps and the
  pre-charged tank. A forecast raise is still bounded by strictCap, so it cannot add load the
  pumps cannot carry.

## 4. What builds now vs. what waits for TempIQv2#2009

Builds now, shadow-testable against the live feed once `FORECAST_FETCH_ENABLED=1` (owner,
2026-11-20), or against recorded fixtures if the endpoint turns out not to answer in prod
(`/health.demand_forecast.healthy` tells us within one cycle):
- provenance parsing in `forecast.ts`;
- the cost-first requirement replacing the raw number in `planPreheat`;
- the DP floor merge (R1);
- the cap-watch rework and test-night notice (R3);
- the parity test suite (R4);
- the block flag and the /hbx card (R5).

Waits for #2009:
- any treatment of TempIQ's number as more than a ceiling (`measured` anchor + owner
  decision);
- a `deliveryTypeVerified`-based hard gate (today the vouching signal is "TempIQ emitted a
  number"; keep that, plus `=== false` hard-blocks);
- any confidence multiplier in the `PREHEAT_CONFIDENCE` slot (no predictability signal
  exists).

Waits for weather: the ≤ 20 °F test night, which decides whether the 135 °F cap is a
problem at all.

## 5. Build plan (ordered) with acceptance tests

Each step is one small PR, pure functions first, `index.ts` wiring last. No new env knobs.

1. **Provenance in the forecast payload** (`forecast.ts`). Parse
   `resetCurve.designSupplyFSource` per zone into `ForecastZone.ceilingSource`.
   *Accept:* fixture with `demonstrated_max` → parsed; absent block → `null`; shape drift
   never throws.
2. **Cost-first pre-heat requirement** (`forecast.ts`, reuse `costFirstAwtF` and
   `requiredAwtF` from `demand.ts`). `planPreheat` takes room/setpoint/callMinutes per zone.
   *Accept (unit):* (a) calling baseboard, fresh call, 38 °F forecast → block raised to
   local + 4.5, not to TempIQ's number; (b) same zone at 90 min streak → +3 °F on top;
   (c) 2 °F room deficit → +12 °F, clamped at TempIQ's ceiling; (d) ceiling above strictCap
   → raise stops at the band ceiling, `skipped: "at band ceiling"` recorded; (e) hotter
   non-calling zone → no raise; (f) call feed `null` → `[]` decisions; (g) sanitize block
   untouched; (h) a block already above the requirement is never lowered; (i) decision
   carries `ceilingSource`.
3. **DP floor merge** (`index.ts` dpHours, via a small pure helper). *Accept:* with no
   calling zones or an unhealthy feed, `dpHours` deep-equal to today's; with a calling zone,
   only the current and next hour differ, and only upward; never above strictCap.
4. **Cap-watch rework** (`forecast.ts` + `index.ts`). *Accept:* 38 °F forecast with a
   demonstrated_max ceiling of 150 °F and no escalation → no attention page, one record line;
   5 °F forecast → attention page (local model crosses); escalated zone at 25 °F forecast
   projecting > 135 → attention page; forecast min 18 °F → test-night notice exactly once
   until the season resets (latch cleared when the forecast min stays > 32 °F for 7 days).
5. **Degraded-mode parity suite** (planner test over the plan-assembly path). *Accept:* four
   feed states (absent; fetch 2 h + 1 min stale; vintage 8 h; `zones: []`) each produce plan
   blocks deep-equal to the no-feed baseline. Fresh feed with pre-heat OFF → blocks identical
   and `meta.preheat.decisions` non-empty. Fresh feed with pre-heat ON → only flagged blocks
   differ.
6. **Block flag + /hbx card** (`shadow.ts` type, `index.ts` sets it, `hbx/page.tsx`).
   *Accept:* a plan with two applied and one skipped decision renders three rows and two
   markers; a plan with no `meta.preheat` renders no card; page still renders when the
   planner `/health` fetch fails.
7. **Shadow period** (operations, not code). `FORECAST_FETCH_ENABLED=1`, pre-heat OFF, ≥ 2
   weeks of nights < 50 °F per the playbook. Weekly: `meta.preheat.decisions` vs
   `zone_floor_snapshots` for the same hours. *Accept before any flip:* at least one real
   baseboard call in the record; every shadow raise ≤ what the live floor actually commanded
   for that hour + 5 °F; zero decisions driven by a zone that was not calling; feed healthy
   > 90 % of cycles; the attention-tier cap page fired at most once per cold episode.
8. **Flip** `FORECAST_PREHEAT_ENABLED=1` — owner decision, rollback = unset. Watch
   `autopilot_log` for pre-heat-reason writes and confirm the reactive floor still fires
   after a pre-heat sometimes (a head start, not a replacement).

Out of scope (settled): TempIQ commanding A2W; new transport/auth; touching the DHW floor,
I1, I4, the sanitize soak or the backup gate; `WINTER_DP_ENABLED` go-live (own criteria).
