# Element-night runbook — independent hazard review (tenet delegate, account B, read-only, 2026-11-21 15:05 ET)

Reviewed: `knowledge/drafts/element-night-runbook-20261104.md` (last edited 2026-11-11) against main at c545001 and
journal entries through 2026-11-21. Requested by the Pi/ops/reviews session for the hydronic session, which runs
the night (Sun 2026-11-22 22:30 → Mon 03:00 ET). Nothing was run or changed.

**Verdict: READY WITH FIXES.** The breaker steps and the shadow gate and fallback match main. Five things need changing before 22:30 Sunday: the boost-retry path (step 3), the timeline, the 4-hour deadline, a deploy freeze, and a generator abort.

## 1. Live-surface steps vs code on main

I couldn't read git history (the objects are compressed), so "changed since 11-11" is inferred from journal entries 506–539.

| Step | Code path | Still matches? |
|---|---|---|
| 1, 9: pumps OFF/ON | `deliberate_stop.py:DeliberateStops`, `self_heal.py:_watch_all_down` (returns if any pump is stopped), `stagewatch.ts` `STOPPED_REMIND_MS`=4 h, `housepages.ts:unservedCall`, `phaseb.ts` excused | Yes. **Changed since 11-11:** `self_heal.py` (#292) is on main but **not on the Pi**, which still runs `release-20261102-1`. |
| 3: boost | `index.ts` `/api/hbx/boost` → `writes.ts:boost`/`armBoost`/`retryPendingBoost` | **No.** A rate-limited boost now returns **202 "arming"**, not 429. `retryPendingBoost` only writes once *online* pumps cover the boost. With both pumps off it never lands and quietly gives up after 20 min (`PENDING_BOOST_MAX_MS`). #294 (bad bodies now get 400/413) is cosmetic. |
| 3–8: autopilot yields | `autopilot.ts` `holdForBoost`; `identify.ts:539/754` | Yes. **Changed (#298):** `shadow.ts` keeps the pre-boost, but its winter guard only acts below 50 °F. |
| 4–6: Buffer Tank close/open | `backupgate.ts:step` (shadow is virtual), `backup_fallback.py:pump_state` (deliberate stop = "off"), `span_local.py:_set_relay_sync` (close-only), `_evaluate_arm` | Yes. Nothing in A2W can OPEN it (reopen is off by default). |
| 4: spanwatch email | `spanwatch.ts:tick`, email-only "attention" tier | Yes (#305 is not merged). |
| 8: restore | `writes.ts:restoreSerial("plan")` | **Partly.** It restores the plan block in force. At 02:15 that may be a 02:00 DHW pre-boost at a flat ~130 °F, not "the plan curve". |
| Deploys | `shutdown.ts`, `.railway/railway.ts` | **Changed (#293, #180 applied 11-21):** handover now takes about 20 s. A deploy still resets in-memory state: the spanwatch alarm, the gate clocks, page edges and any pending boost. |
| lagT, SPAN local | drift-check [9]/[8], `span_local.py` | Nothing in the journal since 11-11. |

## 2. Hazards

**(a) Element left ON**
- Only a person opens the breaker.
- If the Pi's arm intent were ARMED with `arm_live` on, `_evaluate_arm` would re-close the breaker within 300 s of the owner opening it.
- If someone set `BACKUP_GATE=live`, the gate's 90-min clock (running from the 00:45 boost) could close the breaker, and it can never re-open it.
- I can't verify from this repo the claim that 6bb has no breaker automations. SPAN-app schedules aren't checked anywhere either.

**(b) Spurious or suppressed pages**
- If the Pi goes blind for more than 10 min, `VERDICT_MAX_AGE_S` lets the deliberate stops lapse. The Pi's old self-heal can then page **URGENT both pumps down** with no all-clear, the same failure as the 11-13 incident.
- If the planner can't verify the Pi for about 45 min, its suppression lapses and "no heat" pages.
- If the element run slips, a shadow "WOULD close" email is possible around 02:15.
- If the pumps are still off at 03:00 while the HBX calls, the 4-hour stopped reminder pages.

**(c) Generator**
- A manual close bypasses every #241 rule.
- The outage feed is email-based (`generator.ts`) and can't see the first minutes of an outage, so the runbook's "feed reports an outage" abort trigger is too slow.
- 16.5 kW plus house load on a 20 kW generator will overload it.

**(d) Measurement**
- If the boost doesn't land (see step 3), the target stays at about 126–131 °F and the rise is small.
- The boost itself starts a fresh HBX call at 00:45, and the backup stage (lagT 60) may not come until **about 01:45**, not 01:00.
- Before 00:45, an identification probe or a pre-boost block can raise the target.
- Sanitize runs in the warm afternoon (`hygiene.ts`), so it's not a risk tonight.

## 3. Missing or stale steps

- **Boost:** on 202, treat it as no boost. Wait until 15 min after the last HBX write, then POST again (a new request replaces the pending one). Only accept HTTP 200 with `/health.curve.active_boost.target_f`=135.
- **Hard deadlines:** no element draw by 02:05 → open the breaker and abort; pumps back ON by **02:50**.
- **Generator abort:** if lights flicker or the generator starts, open Buffer Tank at once.
- **Read-back after opening:** the Buffer Tank relay reads `OPEN` and 0 W on both the Pi (`/api/health.span`) and the planner (`/health.backup_gate.relay`), plus the SPAN app, twice 5 min apart. Name the owner as the person who opens it.
- **Deploy freeze 22:00–03:30:** #303, #304, #305 and `FORECAST_FETCH_ENABLED` belong to the other session. Tell it in writing; no Railway variable changes or `railway redeploy` either.
- **Journal entries:** at go/no-go, at every timestamp in §4, and at close-out.
- **Stale content:** the Wi-Fi line is out of date (BSSID pinned 11-13, dropouts 0–2 a day since); §4 should use `scripts/element-calibration.ts` and `element-night-local-check.ts` (#301); the glycol factor is 0.875 in §4 but the 11-20 correction uses ÷0.89; the window is now 22:30–03:00.

## 4. Pre-flight checklist (18:00 ET Sunday)

1. `/health.backup_gate.mode`=`"shadow"`, `config_errors`=[]
2. `/health.backup_gate.pi_fallback.live`=false. On the Pi, `/api/health.backup_fallback.mode`=`"shadow"`
3. `/api/health.span`: arm `armed`=false and `live`=false. Buffer Tank `relay_state`=`OPEN`, 0 W
4. `/health.backup_gate.generator.supply`=`"grid"` and `supply_why` doesn't say "assuming"
5. Hub `/health`: `pi_connected`=true and `pi_dropouts_24h` ≤ 1. `/api/health.version` matches the Pi's release
6. `scripts/drift-check.sh` all green, including [8] (SPAN) and [9] (lagT = 60)
7. `/health.curve.active_boost`=null. Writer `pending_boost`=null. Plan blocks from 22:00 to 03:00 show no soak, bank or pre-boost; note any 02:00 lead block
8. `/health.identification`: no arm planned before 03:00
9. `/health.span.cloud.last_error`=null and `backup_alarmed`=false
10. `gh pr list` and the journal: no planner/hub merge or Railway variable change after 18:00; other session told

**TENET context relied on:** journal entries 506–539 (owner's 11-21 GO on Option A; Pi still on `release-20261102-1` with #292 not deployed; the 11-13 false both-down page and the Wi-Fi pin; #293/#180 handover now about 20 s; #298, #300, #301, #302; #303/#304/#305 and the forecast flag left with the other session; the 0.89 glycol correction), the kanban backlog (#241, #199) and memory entries on #241 shadow mode.
