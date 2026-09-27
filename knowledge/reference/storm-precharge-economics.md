<!--
@purpose Quantify the storm pre-charge trade at 6 Black Brook Rd: what a hotter buffer actually
buys in an outage vs what COP degradation and standing loss cost to get and hold it. Written
2026-09-25 for the 2026-09-26/27 High Wind Warning, in answer to the owner's question — "there's
a balance between COP degradation and heat loss (cost) and knowing the tank would stay hotter
longer if we lost power completely." Supersedes the dismissive framing in #114's comment, which
was right about storm mode's +3 °F and wrong to generalise that to "hotter is pointless."
-->

# Storm pre-charge: what a hotter tank buys, and what it costs

## Constants — all from the planner, not assumed

| | value | source |
|---|---|---|
| `C_EFF_BTU_PER_F` | 917 Btu/°F (110 gal × 8.34) | `winterdp.ts:20` |
| tank UA (live measured) | `tank_ua 0.01879` → **17.24 Btu/hr·°F** | `/health.winter_dp`, 2026-09-25 |
| time constant τ = 1/UA_ratio | **53.2 h** | derived |
| `AMBIENT_F` | 65 °F mechanical room | `winterdp.ts:25` |
| `LEAD_F` | 5 °F (LWT ≈ target + 5) | `winterdp.ts:26` |
| `dhwFloorF` | 120 °F | `shadow.ts:49` |
| `strictCapF` / `sanitizeCapF` | 135 / 140 °F | `shadow.ts:63` |
| as-found (pre-A2W) curve | 145–165 °F buffer, 160 °F setpoints | `hbx_config_versions` seed; [[buffer-control-via-pump-setpoint]] |
| COP model | `modelCop(outdoor, sink)` | `realized.ts:54` |
| measured draw rate | 128 events / 14 d = **9.1/day**, max gap 16.9 h | `/health.hygiene.draws` |

Assumptions stated so they can be argued with: outdoor **55 °F** (the storm's actual temperature),
electricity **$0.30/kWh**, a hold window of **20 h** (Sat 13:00 → Sun 09:00 EDT), and one shower =
20 gal at 105 °F from 55 °F mains = 8,340 Btu = **9.1 °F of buffer**. Coast times are
standing-loss only — no draws, no space-heat load.

## The table

Charge and hold costs are marginal over holding 125 °F (the live `bank_peak_f`).

| tank | sink | COP | coast to 120 °F | showers above floor | charge kWh | extra hold kWh/day | total $ |
|---|---|---|---|---|---|---|---|
| **125** (today) | 130 | 3.09 | 4.6 h | 0.5 | — | — | — |
| 128 (**storm mode's +3**) | 133 | 3.01 | 7.2 h | 0.9 | 0.27 | 0.12 | **0.11** |
| 131 | 136 | 2.94 | 9.7 h | 1.2 | 0.55 | 0.25 | 0.23 |
| **135** (`strictCapF`) | 140 | 2.85 | **12.8 h** | **1.6** | 0.94 | 0.43 | **0.39** |
| 140 (`sanitizeCapF`) | 145 | 2.74 | 16.5 h | 2.2 | 1.47 | 0.66 | 0.61 |
| 145 (as-found low) | 150 | 2.65 | 19.9 h | 2.7 | 2.03 | 0.92 | 0.84 |
| 165 (as-found high) | 170 | 2.33 | 31.8 h | 4.9 | 4.61 | 2.08 | 1.90 |

COP penalty vs the 125 °F regime: **8 % at 135, 14 % at 145, 24 % at 165.**

## What the table says

**The economics do not argue against a hotter tank.** Going 125 → 135 °F nearly triples the coast
time and adds about one full shower for **39 cents**. For a storm where NWS says "power outages are
expected," that is cheap insurance. The COP penalty is real but small at this end — 8 % — because
at 55 °F outdoor the lift is short and Carnot is forgiving.

**Cost per shower barely changes with temperature**, which is the counter-intuitive part:
125 → 135 is $0.35/shower, 135 → 165 is $0.46/shower. So there is no economic cliff. The argument
against going hotter is *not* cost.

**Storm mode's +3 °F is the thing that's genuinely marginal**: +2.6 h of coast, a third of a shower,
11 cents. That is #114's point and it stands. What does not follow — and what this document corrects —
is the generalisation that a hotter tank is pointless. It isn't; storm mode's *step size* is.

## So why not go hotter — the real reasons, in order

1. **Above 135 °F you leave the envelope.** `strictCapF` is the everyday ceiling every write path
   checks. The only routes past it are the sanitize path (scoped to 140) and `restore()` (`writes.ts:223`
   — "never rate-limited, never envelope-checked"). Both leave state behind that someone has to
   remember to undo; `restore()` in particular leaves the curve as-found until the next replan.
2. **The 160 °F regime carries a cleared risk that going back re-opens.** Phase C (2026-07-16)
   cleared the backup-element deadlock exposure (`bkDif=90`, historical `bkRun=969 h`) *by coming
   down* to 145 °F setpoints. Returning to the as-found regime returns to the operating point where
   that risk was live. [[buffer-control-via-pump-setpoint]]
3. **The coast column overstates the benefit, because draws dominate standing loss.** At 9.1 draw
   events/day the tank empties in showers, not hours. Above ~145 °F you are banking a 4th and 5th
   shower into an outage that the measured envelope says is bounded by **propane**, not stored heat
   ([[6bb-cold-outage-runtime]]: ~1.2 days storm / ~2.6 days survival heat).
4. **It only matters if the pumps are *shed*.** If the Kohler carries the heat pumps, the starting
   temperature is irrelevant — the buffer gets reheated and the only cost is propane. The pre-charge
   is insurance against the genset not carrying the pumps, which is plausible here (it is undersized
   against the heat pumps) but is not the base case.
5. **At 54–57 °F none of this is space heat.** There is no heating load to bridge. This is a hot-water
   play and should be argued on hot water. A winter version of this table would look completely
   different and is the one that should drive #114's gate.

## Recommendation

**Target 135 °F, not the as-found 145–165 °F.** It captures 40 % of the available coast for 20 % of
the cost, stays inside every existing guardrail, and leaves no state to clean up.

The no-deploy instrument is **Boost** on the dashboard Control page: `boost(135, 120)` — capped at
`strictCapF` and 15–120 minutes (`writes.ts:203`). Charging 10 °F is 9,174 Btu ≈ 25 min of pump
output, so 120 minutes is ample. Fire it **~3–4 h before onset** (≈ 16:00 Sat for an 18:00 onset);
after expiry the heat stays banked and coasts down on its own — nothing actively cools it.

**Wrinkle to know:** `expireBoosts()` calls `restore()`, which re-applies the **as-found** curve
rather than the pre-boost plan state, until the next autopilot replan takes the curve back. Brief
and harmless here (it errs hot), but it means a boost expiry is not a clean return to plan. Worth
its own issue if it surprises anyone again.

## What this implies for #114

#114's fork was "make the response real (bank the building) or admit it can't be (turn it off)."
This table adds a third option that was missed: **the buffer response is worth having — at a step
size of 10 °F to the strictCap, not 3 °F** — as a DHW-resilience measure, explicitly not as a
space-heat bridge. That is a smaller, cheaper change than banking the building and it is defensible
on measured numbers. The thermal-need gate is still needed, but to gate on *outdoor temperature and
DHW state* rather than to delete the mechanism.
