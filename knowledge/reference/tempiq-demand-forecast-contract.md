# TempIQ demand-forecast contract (A-8) — predicted zone calls feeding A2W winter planning

> **STATUS 2026-08-24: the prediction core is DEAD — Phase 0 ran and the gate said STOP.**
> TempIQ executed the backtest (TempIQv2#2009): hourly per-zone calls from Nest-derived
> `readings`, chronological split, scored against *persistence* (the right bar, since A2W
> already reads live calls) with a moving-block bootstrap. Result: **1 of 7 zones has real
> skill, and it is the wrong one.** Master Bathroom (the only robust signal) runs 74.9%
> duty — already always calling, so pre-heating buys nothing — and is unverified, so A2W's
> own rule forbids acting on it. Living Room Baseboard, the zone this entire contract was
> motivated by, has no predictable structure at any horizon. Outdoor regression had
> essentially zero skill everywhere, refuting the "the signal is in the outdoor half"
> hypothesis. Phase 2 setback-recovery is empty on this house: `detected_schedules` is 25
> `constant_hold` + 1 `programmatic`, i.e. flat setpoints 24/7 — there are no setbacks to
> recover from.
>
> **Do not build `p_call`, `expected_runtime_min`, or Phase 2.** A2W's consumption code
> (PR #88) is merged with both gates OFF and stays off; its raises-only / degraded-parity
> scaffolding is reusable for whatever we consume next.
>
> **What replaced it** (see the revised asks on TempIQv2#2009, authoritative over §"What
> A2W needs from TempIQ" below):
> 1. **Curve parameters + provenance** — per zone `minSupplyF`/`designSupplyF`/
>    `designOutdoorF`/`wwsdOutdoorF` and *where designSupplyF came from*
>    (`type_curve_default` | `demonstrated_max` | `measured`). Now the #1 ask, because of #89.
> 2. `delivery_type_source` (migration 0162, currently dead) — A2W leans a safety gate on
>    provenance it cannot see; `/api/insights/zones` does not emit `deliveryTypeVerified` at all.
> 3. `required_supply_f` at forecast outdoor — still wanted for the DP's future floors, but
>    only AFTER (1), or it propagates #89's divergence 167 h into the planning horizon.
> 4. Wiring U4 (`supply-water-requirement-learner.ts`, zero readers) — the real fix.
>
> **Caveat worth keeping:** this is a finding about *this pilot* (one property, ~32 days of
> clean per-zone coverage, Feb-2026 ingestion outage). A house that actually runs setbacks
> would likely show real time-of-week skill. Re-run in Oct/Nov on a full heating season.

Owner direction (2026-08-23): "Ideally TempIQ … has a good sense of what will be running
(predicted demand / predicted schedule) — that should feed into how the A2W system is
prepping / operates."

This is the successor to TempIQ#1470 (insights API, shipped) and TempIQ#1632 (learned
supply temps, shipped + consumed in a2w#72). Same integration shape as both: **TempIQ
stays a read-only insights provider on the surface-token API; A2W keeps all decision +
actuation authority.** Predictions are enrichment, never a dependency — A2W must behave
exactly as today when the forecast is absent, stale, or low-confidence.

## Why (the gap this closes)

A2W's demand floor is REACTIVE: it serves zones that are calling *now* (learned
required-supply at *now* outdoor, a2w#72). The winter DP is predictive only about
weather/cost; its per-hour future floors use the local parametric model with no idea
*which zones will actually call in which hours*. Three consequences:

1. **Floor-raise latency.** A rarely-used baseboard zone's first call on a cold night
   lifts the tank target only at the next hourly plan recompute + curve adoption — up to
   ~1 h of reduced output while the tank climbs from the 120 °F DHW floor to ~125–133 °F.
   Setback recovery (6 am, thermostat schedule) is the classic worst case: the demand
   spike is *scheduled* and therefore perfectly predictable, yet today A2W learns about
   it reactively.
2. **DP banking is demand-blind.** It banks against forecast cold, not against "the
   baseboard wing runs 6–9 pm most winter evenings."
3. **Cap-adequacy is discovered live.** The 135 °F cap-watch fires after 3 h of a pinned
   zone call; with predicted calls × forecast outdoor, "tonight will need ≥ cap" is
   knowable by mid-afternoon.

## What A2W will do with it (consumption contract — a2w side)

- **Raises-only asymmetry (safety invariant):** predictions may PRE-heat (lift a future
  plan block's floor before the call starts); they may NEVER lower or suppress the
  reactive floor from a live call. A wrong prediction costs a few kWh, never comfort.
- **Confidence-gated:** pre-heat only when `pCall × confidence` clears a threshold
  (planner env, start ~0.5) for a zone whose required supply exceeds the standing floor.
- **Degraded mode:** endpoint absent/stale > 2 h → today's behavior exactly (parametric
  future floors, reactive live floor). Mirrors the DemandFeed three-state contract.
- **Predictive cap-watch:** afternoon alert when predicted binding supply at forecast
  outdoor > strictCap, so a deliberate seasonal raise can happen before, not during, a
  cold night.

## What A2W needs from TempIQ

> ⚠️ Everything from here to "Non-goals" is the ORIGINAL ask, kept for the record.
> Phases 0-2 are settled: Phase 0 RAN and returned STOP; Phases 1-2 are not to be built.
> Three premises below were also disproven against prod — "learned reset curve" (it is a
> static type curve with two per-property scalars; the real learner has zero readers),
> "≥4 weeks of zone-call history" (no call table exists; `energy_calls` is empty globally —
> the usable signal is Nest-derived `readings`), and "setback recoveries are near-
> deterministic" (this house runs flat setpoints).

### Phase 0 — predictability analysis (cheap, do first; TempIQ-side analysis only)

Backtest over ≥ 4 weeks of zone-call history: per zone, per hour-of-week × outdoor-bin,
how well does a simple predictor (time-of-week frequency + outdoor regression) forecast
"zone calls in this hour"? Publish per-zone hit-rate/Brier so we know where prediction is
worth acting on (a Xmas-Room mini-split may be pure noise; setback recoveries should be
near-deterministic). If nothing is predictable, stop here and say so — A2W stays
reactive and loses little. Note: heating-call history is thin in August; the backtest
gets meaningful with shoulder-season data (Oct) — Phase 0 can ship on last winter's data
if retained, else runs in early October.

### Phase 1 — forecast endpoint (minimum viable)

`GET /api/insights/demand-forecast?hours=24` (surface-token auth, same as `/zones`):

```jsonc
{
  "generatedAt": "2026-11-12T18:00:00Z",
  "basis_window_days": 28,
  "zones": [{
    "id": "e849e306…",
    "name": "Living Room Baseboard",
    "hours": [{
      "start": "2026-11-12T22:00:00Z",
      "p_call": 0.72,                 // probability the zone calls in this hour
      "expected_runtime_min": 35,
      "required_supply_f": 124.5,     // at TempIQ's forecast outdoor for THAT hour
      "basis": "history",             // history | schedule | recovery
      "confidence": 0.8
    }]
  }],
  "dhw": [{ "start": "…", "p_draw": 0.6, "expected_kwh": 0.4 }]   // optional; aggregate exists
}
```

Field semantics that matter to A2W:
- `required_supply_f` must be the learned reset curve evaluated at the **forecast**
  outdoor for that hour — not now-outdoor. If evaluating server-side is awkward,
  alternatively expose the learned curve parameters per zone (points or slope/intercept)
  and A2W evaluates against its own forecast; either satisfies the contract.
- `basis`/`confidence`/provenance discipline as in #1508: A2W will refuse to pre-heat on
  a zone whose delivery type or curve is unverified, exactly as the live floor does.
- Zones with nothing predictable: omit hours or send `p_call: 0` — never fabricate.

### Phase 2 — deterministic signals (highest value per bit)

- **Thermostat schedule / setback-recovery events**, where TempIQ can see them:
  `{"zone", "recovery_start", "target_delta_f"}`. A scheduled 6 am recovery is a
  certainty, not a probability — these alone capture most of the pre-heat win.
- **Occupancy/away state** (if available): away → A2W can relax pre-heating and let the
  demand-aware sanitize cadence stretch.
- Optional: whole-house `heat_load_btu_hr` per forecast hour (TempIQ's UA + gains models)
  to ground the DP's drain model.

## Non-goals (settled, don't reopen)

- TempIQ does NOT command A2W (no setpoint/target writes; the lease/guardrail
  architecture is unchanged). "TempIQ autopilot" here means *TempIQ predicts, A2W acts*.
- No new transport/auth: same surface-token read API as #1470/#1632.
- A2W's reactive floor, DHW floor, I1/I4/cap guardrails: untouched by any of this.

## Paired work

- TempIQ build: filed as a TempIQv2 issue referencing this doc (Phase 0 → 1 → 2).
- A2W consumption (blocked on Phase 1): planner issue — DP future floors from forecast,
  confidence-gated pre-heat, predictive cap-watch, degraded-mode parity tests.

---

## AMENDMENT 2026-08-27 — the survivor shipped, and it changed the gate

TempIQ shipped gtm#1591 as **TempIQv2#2017**, and A2W's consumption side was rewired onto it
(a2w#87). This section is authoritative over everything above it that describes the endpoint
or the pre-heat gate.

**What exists now:** `GET /api/insights/zones/required-supply-forecast` — for each
owner-verified hydronic zone, the same reset curve `/zones` emits, evaluated at the FORECAST
outdoor of each persisted hour. Live shape, verified against prod:

```jsonc
{ "generatedAt": "…",                                  // when the RESPONSE was built
  "forecast": { "hoursAvailable": 48, "oldestVintage": "…", "newestVintage": "…",
                "degradeReason": null },               // weather vintage; refreshes 6-hourly
  "zones": [{ "zoneId": "…", "zoneName": "…", "deliveryType": "baseboard",
              "omittedReason": null,                   // "no-curve" | "unverified"
              "resetCurve": { … },                     // gtm#1593 block, incl. provenance
              "hours": [{ "targetTimestamp": "…", "outdoorF": 18.4,
                          "requiredSupplyWaterTempF": 143.2,
                          "forecastGeneratedAt": "…" }] }] }
```

Two traps worth writing down:

- **`generatedAt` is not the vintage.** It is when the response was built, so it is always
  fresh and useless as a staleness check. The weather vintage lives in
  `forecast.newestVintage` and is legitimately up to ~6 h old. The client's old 2 h window
  applied to the wrong field would have read as permanent degraded mode.
- **`omittedReason` is TempIQ's verified gate, expressed as an omission.** A zone with hours
  has passed their check; 4 of 7 hydronic zones here qualify. We keep our own verified gate
  anyway (TempIQ#1508 defence in depth).

**The gate changed, and this is the part to not undo.** Everything above describes
`p_call`-gated pre-heat. There is no `p_call`. Deleting the gate and keeping the mechanism
would have converted pre-heat into *the conservative all-zones future floor* — the hottest
verified emitter's requirement, every hour of the day — which is precisely the idle-baseboard
cost named as winter-DP go-live criterion 5. The replacement is the #90 doctrine on the time
axis:

> **Only a zone that is CALLING NOW earns a forecast-driven raise, and only for its own
> requirement.** Not a prediction that a call will happen — an anticipation of the ramp of a
> call already in progress.

Consequences, all test-pinned in `planner/src/forecast.test.ts`:

- Nothing calling, or the call feed unhealthy (`null`) → **no raises at all**. Note the
  deliberate inversion vs `computeFloors`, where a null call feed conservatively treats every
  zone as calling: there the fallback is a live requirement (safe); here the raise is
  speculative, so the safe fallback is to do nothing.
- A hotter **non-calling** zone can never move the plan.
- `predictedCapRisk` stays deliberately **ungated** by live calls — it commands nothing, and
  gating a capacity warning on what happens to be calling this minute would silence it in
  exactly the mild hours when it is still actionable. Its alert text now says explicitly that
  it is a capacity warning at the forecast outdoor, not a prediction that the zone will call.
- `PREHEAT_CONFIDENCE` is **gone**; setting it has no effect.

Unchanged: raises only, never past the band ceiling, sanitize blocks untouched, both gates
(`FORECAST_FETCH_ENABLED`, `FORECAST_PREHEAT_ENABLED`) default OFF, and full degraded-mode
parity when the feed is absent.
