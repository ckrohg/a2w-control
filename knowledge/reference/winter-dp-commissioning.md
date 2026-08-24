# Winter DP commissioning + go-live playbook (#59)

The winter solver v1 (24 h cost DP, PR #69/#72, 2026-08-06) is deployed **shadow-first,
flag-off**. This runbook is the watch-and-decide half of winter readiness: what to review as
the shadow record accumulates, how to validate the 135 °F cap, and the criteria for flipping
`WINTER_DP_ENABLED=1`. The *alerting* half is `winter-drill.md` (run that drill in late fall
first). Companion analysis: `winter-safe-floor-analysis.md` (the Phase-2 floor values, LOW
confidence — this playbook is where they get validated).

## What runs by itself (no action needed)

- **First forecast hour < 55 °F** (≈ late Sept): the DP starts solving every shadow cycle.
  Trajectory + savings estimate land in every plan's `meta.winter_dp` and `/health.winter_dp`.
  Commanded targets are NOT affected until the flag is set.
- **First hour < 50 °F**: the demand floor (binding calling zone → tank floor) enters plans
  and ACTUATES via the live autopilot. Emitter-aware floors are already verified: TempIQ's
  learned per-zone supply temps (baseboard 120 °F, radiant 85 °F) drive the live floor
  (`ZoneFloor.learned` in zone_floor_snapshots); unverified zones use the local parametric
  model.
- **Cap watch** (latched urgent alert, ntfy + email): outdoor < 35 °F AND plan pinned at the
  135 °F strictCap AND the same hydronic zone calling ≥ 3 h → "zones may need more than
  135 °F". If this ever fires, see "cap decision" below.

## Shoulder-season review (October — ~15 min, weekly)

```sql
-- newest DP shadow: what would it have done, what did floor-following cost
SELECT computed_at, meta->'winter_dp'->>'saved_pct' AS saved_pct,
       meta->'winter_dp'->>'dp_kwh' AS dp, meta->'winter_dp'->>'floor_kwh' AS floor,
       meta->'winter_dp'->>'cop_anchored' AS anchored
FROM shadow_plans WHERE meta ? 'winter_dp' ORDER BY computed_at DESC LIMIT 5;
```

Healthy looks like: `saved_pct` 0–5 % (deep-cold days ≈ 0 is CORRECT — the 110 gal tank
stores ~40 min of design load, so LWT discipline beats banking; the DP refusing to bank is
the physics, not a bug), banking appearing only in the hours just before evening cold,
`cop_anchored: true`. Red flags: floors in the trajectory below the demand floor (never
happened in tests — would be a solver bug, don't go live), or wild bank peaks on heavy-load
days.

Also check `plan_scores` (gap_f): plan-vs-actual through shoulder season is the evidence the
go-live decision rests on.

## First sub-50 °F week = commissioning window (active watch)

Daily, ~10 min:
1. **Comfort ground truth first**: any room cold? Any TempIQ zone calling > 3 h continuously?
2. `/health`: `winter_solver.mode: shadow` + healthy, `winter_dp` computing, `writer_lease.held`,
   Phase B both pumps ok. Comm quality (weekly digest tile): if #76 (Aug-5 flap degradation)
   isn't fixed yet, expect I1 races/stale-write refusals — fix that BEFORE trusting cold-week
   evidence.
3. `zone_floor_snapshots`: binding zone sane (baseboard binds cold nights), `learned` floors
   present, no UNVERIFIED binding zone (console warns; verify the type in TempIQ if so).
4. Cap check even without the alert: if the plan holds 135 and rooms are fine → the cap is
   adequate (TempIQ's corrected baseboard=120 says it should be); log it and move on.

**Cap decision (only if the watch fires or rooms run cold):** the fix is a deliberate
seasonal raise of `strictCapF` (Phase B actively manages setpoints now — the cap's "until
Phase B" condition is met; I4 as-found ceiling permits up to the 145–165 °F regime). Owner
decision; raise in ≤ 5 °F steps and re-observe. Never relax I1.

## Go-live criteria for `WINTER_DP_ENABLED=1`

Flip when ALL of:
1. ≥ 2 weeks of shadow trajectories with zero floor violations and sane banking;
2. plan_scores show the DP trajectory would not have under-served any hour the floor logic
   served (gap analysis, not vibes);
3. comm quality restored (#76 done) — the DP's raises depend on Phase B leading reliably;
4. the winter-drill.md alert drill has passed this season;
5. **the idle-baseboard cost is understood and accepted** (see below).

### 5. What the conservative DP floor costs on idle-baseboard nights

The DP's per-hour floors are built with `demandFeed.proposeFloor(o, null)` — the `null` is
the CONSERVATIVE all-zones posture, because future calling state is unknowable. So every
future hour is floored at the *baseboard* requirement whether or not the baseboards will
actually call. That is the right default for a solver, and it is inert today (the DP is
shadow-only; the LIVE plan uses the reactive call-driven floor — 620/621 floor snapshots
over the 30 days to 2026-08-23 were `insights+calls`, with exactly one binding zone ever,
at 112.5 °F, already under the 120 °F DHW floor).

**It becomes live behavior the moment this flag flips**, since DP targets apply as raises.
On a cold night with no baseboard calling, expect the floor to sit ~5–10 °F above the DHW
floor — an efficiency cost, bounded by strictCap, never a safety issue. Before flipping,
quantify it from the shadow record: compare `winter_dp` trajectory floors against the
`zone_floor_snapshots` binding zone for the same hours.

The real fix is the A-8 demand forecast (#87 / TempIQv2#2009): replace "assume every zone
may call" with "these zones will probably call." Safe as a relaxation *because the reactive
floor is an independent guarantee* — a missed prediction degrades to today's reactive path,
not to something colder. If A-8 lands before the DP goes live, prefer sequencing it first.

Mechanics: `cd planner && railway variables --set "WINTER_DP_ENABLED=1"` (auto-redeploys).
Effect: DP targets apply as RAISES ONLY above the floor logic, band-clamped; sanitize
outranks; storm raises on top. Rollback: unset the flag. First 48 h after the flip: watch
autopilot_log for DP-reason writes and I1 rejection rate (a burst of I1 races that doesn't
self-clear within a cycle = pause and investigate Phase B lead timing).

## A-8 demand forecast (#87) — flipping the two gates

The consumption code shipped 2026-08-23 (PR #88), both gates OFF. Sequence once
TempIQv2#2009 Phase 1 is live:

1. `railway variables --set "FORECAST_FETCH_ENABLED=1"` — records what predictions WOULD
   have done in `/health.demand_forecast` and every plan's `meta.preheat.decisions`.
   Nothing actuates. Let it run ≥ 2 weeks.
2. Review: were predicted floors real? Cross-check `meta.preheat.decisions` (predicted
   zone + hour) against `zone_floor_snapshots` (what actually bound that hour). A
   prediction that never matched a real call is a reason to raise `PREHEAT_CONFIDENCE`,
   not to actuate.
3. `FORECAST_PREHEAT_ENABLED=1` — predictions may now raise commanded targets. Raises
   only, band-clamped, sanitize outranks, verified zones only. Rollback = unset.

Watch after step 3: `autopilot_log` for pre-heat-reason writes, and whether the reactive
floor still fires *after* a pre-heat (it should sometimes — pre-heat is a head start, not
a replacement).

## Standing hardware items before real cold

- **#76** comm degradation (Aug 5 onset, both pumps) — root cause + fix; done = ≤ 1
  offline/pump/week for 7 days.
- **HP2 E21 history** — cleared 2026-08-06 but ran 2 silent weeks in July; winter
  failure-to-start is HP2's known pattern. Fault emails now page same-day. Winnie follow-up
  drafted (`winnie-followup-draft.md`): E21 semantics + forced-defrost register + serial.
- **SPAN element breaker** ON + backup alarm armed (physical checklist in winter-drill.md).
