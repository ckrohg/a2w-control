# Backup element (16.5 kW) — control design

**@purpose** How the resistive backup should be governed once the autopilot runs the buffer target.
Settled principle: the element is a **failsafe, not a heat source** — it fires only when genuinely
needed, and we spend our effort *avoiding* needing it (cheaper) rather than *using* it. Drafted
2026-07-16, after autopilot went live.

## TL;DR
1. **The winter over-calling was a deadlock artifact, and autopilot already fixes it.** Old settings
   held an unreachable ~164°F target → HP stages pinned ON forever → the `bkLag`=230-min timer
   expired over and over → 969 phantom *calls* (call-time, not delivery). The HPs were actually keeping
   the house comfortable — which is why the owner never noticed and safely kept the SPAN breaker OFF.
   Autopilot commands **reachable** targets (120–140°F) → stages cycle off → `bkLag` never expires
   falsely → phantom calls stop. The "bad HBX settings" were really the unreachable target.
2. **After that fix, the as-found `bkLag`=230 becomes CORRECT** — it now only trips when both HPs are
   genuinely maxed ~4 h and still losing ground = a real capacity shortfall = when you actually want it.
3. **The element's real job is CAPACITY (and failure) backstop, not efficiency.** It's COP=1; a working
   EVI heat pump is almost always COP>1, so the element is almost never *more efficient* — only in the
   rare deep-cold/hot-tank sliver where HP COP dips toward 1 (see `bkTk`, below).
4. **Re-enable the SPAN breaker** once a bit of cold confirms the phantom calls are gone — otherwise
   there's no freeze/failure backstop at all. The planner's R3 element-accounting alert pages on ANY
   element runtime, so a stray call is caught immediately, not silently billed.

## Response hierarchy for "the HPs can't keep up" (cheapest → most expensive)
The element is the LAST rung. Prefer everything above it:
1. **Anticipate + pre-heat** (§6.6, TempIQ forecast) — bank heat into the buffer at the day's *best COP
   hour* BEFORE a predicted cold snap / big draw. COP 3–4 pre-heat beats COP-1 resistance later. The
   single biggest lever; this is the "more cost-effective way" — don't get into the hole.
2. **Mini-split assist** (§6.10 source arbitrage) — shift SPACE-heat load onto the Kumos (COP 2–3 by
   band) during a hydronic peak, freeing the buffer/HPs for DHW. Cheaper than resistance for space heat.
   (Mini-splits can't make DHW — see rung 5.)
3. **House thermal-mass float** (±1–2°F, TempIQ chokepoint) — ride the fabric to shave the peak; free.
4. **`bkTk` COP-crossover** — on the coldest days where HP COP actually crosses 1, split the lift
   (below). Marginal gain, rare.
5. **Resistive element** — true last resort: (a) HP failure, (b) sustained shortfall threatening **DHW
   comfort** (rooms can float; a cold shower can't — see owner note), (c) freeze backstop.

## The `bkTk` COP-crossover (worked through) — winter, flag-gated
`bkTk` = HBX "Backup-Only-Tank": HPs are capped at a tank temp, the element finishes the lift above it.
Set it to the tank temp where HP COP crosses backup's COP=1, so each source does the part it's better at.

```
each plan block, if PHASE_D_BKTK_ENABLED and outdoor < DEEP_COLD (~15°F) and COP surface trustworthy:
    T_x = tank temp where COP_surface(outdoor, tank) == COP_CROSS   # COP_CROSS ~1.1 (cushion over 1.0)
    required = winter-solver target (binding baseboard zone)
    if required > T_x:                       # demand needs water hotter than the crossover
        write HBX bkTk = clamp(T_x, DHW_FLOOR, required)   # HPs to T_x (COP>1), element T_x→required
    else:
        write HBX bkTk = as-found/disabled   # HPs do it all efficiently
```
Guards (same discipline as every write): outdoor-gated (only where COP<1 is physically plausible);
never cap below the DHW/sanitize floor; I4/rate-limit/audit; reversible (unset → bkTk as-found);
R3 accounting confirms the element runtime matches the *intended* crossover, not a bug.

**Reality check (be honest):** the Arctic MAHRW030 are EVI cold-climate units — they likely hold
COP>1.5 even at design-day 5°F, so this crossover may **rarely or never trigger** in practice, and the
gain when it does is small (COP ~0.9 → 1.0). Winter COP measurements decide whether it's worth enabling.
Design it for completeness + HP-degradation insurance; don't expect it to be a big lever.

## Failsafes that must ALWAYS hold (independent of any optimization)
- **Freeze protection**: HBX P17 anti-freeze — never touched, always on.
- **HP-failure backstop**: element fires if the HPs are down (`bkTemp`/`bkDif` as-found) — needs the
  **SPAN breaker ON**.
- **DHW-comfort backstop** (owner ask): on a *sustained* shortfall where the HPs can't recover DHW,
  the element ensures hot water. Ideally pre-empted by anticipation (rung 1); the element is the net.
- **Element accounting (R3)**: ntfy on ANY element minute — legitimate on design-cold, a bug otherwise.
- **Degradation ladder**: dead planner → Pi baseline → HBX curve + wall controllers (today's system).
- **Reachable targets (R1)**: autopilot never commands a target the HPs can't reach in `bkLag`, so the
  timer never expires falsely. This is the load-bearing false-trigger prevention.

## Phasing
- **Now (summer):** nothing — autopilot handles it; the element is a non-issue.
- **First cold weather:** verify phantom calls are gone (`bkRun` vs SPAN ≈ 0) → **re-enable the SPAN
  breaker** → element is a true, rarely-firing backstop.
- **Winter build:** the anticipation/pre-heat + mini-split assist (rungs 1–2) are the real cost lever —
  build with TempIQ. `bkTk` COP-crossover (rung 4) is a flag-gated refinement, low priority, gated on a
  trustworthy winter COP surface.

## TempIQ collaboration (the "avoid it" direction)
The cost-effective failsafe is *not needing* the element. TempIQ should feed: (a) an hourly demand +
cold-snap forecast → autopilot pre-heats at best COP; (b) per-zone required supply temp
(`requiredSupplyWaterTempF`, filed TempIQv2#1632) → the winter solver sizes charges to avoid the
unreachable-target trap; (c) mini-split COP-by-band + space→source map (§6.10) → shift space-heat off
the buffer during peaks. Resistance is the backstop for when all of that still isn't enough.
