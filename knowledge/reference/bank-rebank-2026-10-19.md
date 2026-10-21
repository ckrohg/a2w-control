# The afternoon bank re-planned onto the current hour — 2026-10-19, and most afternoons since Aug 6

**Status:** fixed in the planner (this PR — deploys the planner, owner gate-merges with
`scripts/deploy-gate.sh merge <pr>`). Root-caused once before, on 2026-08-08 (journal: "warmest-REMAINING-hour +
hourly recompute = one bank per hour, not per day"), measured again on 2026-08-11, and left for "#58's owner".
Separate from the stale SensorLinx target (PR #215, `stale-slx-target-2026-10-19.md`), which found this.

## What happened on 2026-10-19 (ET)

Eight accepted writes in four hours (`hbx_writes` 1372–1379), the device flipping 120 ↔ 128 every hour:

| time  | plan in force          | its block for this hour                        | auto-pilot (autopilot_log) | write |
|-------|------------------------|------------------------------------------------|----------------------------|-------|
| 14:09 | 2317 (computed 13:19)¹ | 14:00 = 140 soak (sani)                        | set 140                    | 1371 set_target 141/137 |
| 15:04 | 2318 (14:19)           | 15:00 = 120 "DHW window floor"                 | set-curve                  | 1372 set_curve 120/118 |
| 15:19 | 2319 (15:19)           | 15:00 = 128 bank "warmest hour, 58°F outdoor"  | set                        | 1373 set_target 129/125 |
| 16:04 | 2319 (15:19)           | 16:00 = 120 "DHW window floor"                 | set-curve                  | 1374 set_curve |
| 16:19 | 2320 (16:19)           | 16:00 = 128 bank "warmest hour, 57°F"          | set                        | 1375 set_target |
| 17:04 | 2320 (16:19)           | 17:00 = 120 floor                              | set-curve                  | 1376 set_curve |
| 17:24 | 2321 (17:19)           | 17:00 = 128 bank "warmest hour, 55°F"          | set                        | 1377 set_target |
| 18:04 | 2321 (17:19)           | 18:00 = 120 floor                              | set-curve                  | 1378 set_curve |
| 18:19 | 2322 (18:19)           | 18:00 = 128 bank "warmest hour, 52°F"          | set                        | 1379 set_target |
| 19:04 | 2322 (18:19)           | 19:00 = 135 winter guard                       | set-curve                  | 1380 set_curve |
| 19:19 | 2323 (19:19)           | no bank (5 h of day left)                      | held-curve                 | — |

¹ 2317 (13:19) and 2318 (14:19) both had the soak on 14:00 and, being soak-day plans, no bank at all.

## Mechanism

- `shadowOnce` (index.ts) runs every 60 min from boot — at :19 since the 2026-10-18 deploy, :33 / :35 / :00 on earlier
  boots. `fetchForecast` keeps the current partial hour, so the horizon always starts at the current hour.
- `computeShadowPlan`'s #58 bank picks **the warmest of the REMAINING hours of each local day**. On a falling afternoon
  the warmest remaining hour is always *now*, so every hourly recompute re-banks the current hour. The plan computed the
  hour before said this hour was the floor; the auto-pilot (5-min poll) writes that floor at the hour rollover (:04)
  and writes the bank the moment the new plan lands (:19). The hour-boundary drop to the floor is correct on its own;
  the defect is re-banking afterwards. It stops when fewer than six hours of the day remain (`ds.length < 6`) — plan
  2323 at 19:19, exactly where production went quiet.
- **Neither auto-pilot path is wrong for its input.** Not the floor cadence (raises only, below the winter guard, and
  the outdoor was 52–58 °F), not the shaped-curve `would_write` predicate (it correctly saw a non-excursion block at
  :04 and an excursion block at :19). The *plan* changes for the same hour between :04 and :19.
- **Why a soak day banked at all:** "soak day IS the bank" (`ds.some(d => d.sani)`) only sees the soak while the soak
  hour is still in the horizon. From the 15:19 recompute on, 14:00 is gone, so the day looks like a non-soak day.

## Frequency (local restore a2w-db-2026-10-20T014442Z; no production query)

Since 2026-09-01 (49 days to Oct 19):

| measure | value |
|---|---|
| bank `set` decisions in autopilot_log | 145, on 43 days |
| of which re-banks (2nd+ bank of the same local day) | 102 |
| bank sets preceded **within the same hour** by a write back to the floor | 101 (57 flat `set_target` 120 before the shaped curve went live 2026-09-30; 44 `set_curve` after), on 41 days |
| gap between the floor write and the bank write | 15–45 min, mean 28 — the offset between the hour-rollover poll and the hourly re-plan |
| the stricter predicate "set_curve → bank within 30 min" | 6 (Oct 13, 18, 19 only — the offset was 35 min until the Oct 18 redeploy moved the plan to :19) |
| plans that banked their own current hour | 71 of the 486 plans carrying a bank |
| local days with a current-hour excursion in the plan history | 21 — 18 banked more than one distinct hour, 8 banked after that day's soak |

Cost per re-bank: two writes per hour instead of one (each burns the 15-min slot), an 8 °F swing on the target twice
an hour, and `plan_scores.commanded_target_f` becomes a blend of two commands for that hour. The 2026-08-11
measurement (bank sets 2/3/5/2/4 per day, "roughly half of all tank-target writes") is the same defect.

## The fix

- `shadow.ts`: `ShadowOpts.priorExcursions` and `priorExcursionsFromPlans(plans, nowMs)` — the bank / soak blocks the
  plan history already placed at hours that have **started**, newest plan per hour winning (a bank an older plan placed
  and a newer plan moved never happened). In the bank loop, per local day: a bank at a *past* hour, or a soak at any
  started hour, means the day's deliberate charge is **spent** (no bank); a bank on the *current* hour is **kept** there
  (reason "…; kept from the previous plan"), even with fewer than six hours of day left, so the hour the bank was
  written in cannot drop it; otherwise the warmest-hour choice is as before. The bank is chosen once per local day.
- `index.ts shadowOnce`: `store.recentPlans(26)` → `priorExcursions`, stamped in `shadow_plans.meta.prior_excursions`.
  A history read failure means no memory (the pre-fix plan), never a skipped plan.
- The auto-pilot, the writer and the floor cadence are untouched.
- Tests: `planner/src/bank-memory.test.ts` — the defect documented (no memory → banks 14, 15, 16, 17, 18 in turn), the
  memory (one bank, kept while current, spent after, carried through plans that carry no bank), soak-then-bank, the
  <6 h pin, soak-over-pin, per-day / per-hour / newest-wins semantics, and an end-to-end auto-pilot rehearsal of the
  afternoon (before: 128 at 14:04 then curve/bank pairs every hour; after: 128 at 14:04, curve at 15:04, nothing more).
- Replay of the 24 stored Oct 19 plans (forecast rebuilt from each plan's blocks, windows / pre-boosts from meta, the
  as-found curve): the old code reproduces every stored same-day bank; with the memory, plans 2319–2322 bank no current
  hour (0 instead of 4). The afternoon would have been one write — the 15:04 curve after the soak — instead of eight.

## Not changed, worth knowing

- The soak has the same rolling-horizon shape (warmest *remaining* hour). It is guarded by `sanitizeDueNow` going
  false once the 30-min dwell is met, so it only re-lands on the current hour while the dwell is not yet achieved,
  which is arguably wanted. Untouched here.
- A bank that was planned but never executed (held for a boost, I1-rejected for the whole hour) still counts as spent:
  one deliberate charge per day is the #58 contract, and the plan is the record. The old behaviour would have retried
  it every hour, which is the defect.
- A floor-cadence raise strips the block's `bank` flag (`store.raiseLatestPlanBlock`), so a floor-raised bank hour is not
  remembered; below the winter guard the floor outranks the bank, so a later re-bank would be a no-op below the floor.
- `tempiq-windows` posts each bank `set` as its own quarantine window; after this the window count per day drops to one.
