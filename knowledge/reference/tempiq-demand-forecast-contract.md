# TempIQ demand-forecast contract (A-8) — predicted zone calls feeding A2W winter planning

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
