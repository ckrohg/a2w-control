# Dependency graph — W0 wave (winter solver + storm mode, plan §6.9–6.11)

Owner-approved direction 2026-07-14 ("get started on this plan — dep-graph wave").
Issues #8–#13; specs in `specs/w0-*.md`; evals in `eval/build/`.

## Graph

```
#8  w0-1-store          (store.ts tables/helpers)          [no deps]
#9  w0-2-demand         (demand.ts — NEW file, pure+client) [no deps]
#10 w0-3-storm          (storm.ts — NEW file, pure+fetchers)[no deps]
#11 w0-4-winter-shadow  (shadow.ts + index.ts wiring)       [#8, #9]
#12 w0-5-storm-wiring   (index.ts + shadow.ts wiring)       [#8, #10, #11]*
#13 w0-6-dashboard      (analytics-mirror surface)          [#11, #12]
```

\* #12's dep on #11 is a **file-exclusivity** dependency (both modify `index.ts` +
`shadow.ts`), not a logical one — sequential dispatch avoids the merge conflict.

## Value scores (V impact 1–5 × U unlocks / C cost in rounds)

| Issue | V | U | C | V×U/C | Notes |
|---|---|---|---|---|---|
| #9 demand | 5 | 2 | 2 | 5.0 | the §6.9 engine; binding-zone math is the product |
| #8 store | 3 | 3 | 1 | 9.0 | trivial but unlocks two branches |
| #10 storm | 4 | 2 | 2 | 4.0 | pure state machine + three fetchers |
| #11 winter-shadow | 5 | 2 | 2 | 5.0 | turns §6.9 on (shadow, flag-gated) |
| #12 storm-wiring | 4 | 1 | 2 | 2.0 | notify-first per open owner question |
| #13 dashboard | 3 | 0 | 2 | 0 (leaf) | owner-visible surface |

## Execution order (sequential — shared index.ts/shadow.ts forbid parallel here)

`#8 → #9 → #10 → #11 → #12 → #13`

(#8/#9/#10 are mutually parallel-safe on disjoint files; running sequentially anyway per
the build-agent skill default — single PID, single log, deterministic.)

## Safety rails carried by every spec
- Winter solver: SHADOW-ONLY, flag `WINTER_SOLVER_SHADOW`, degraded mode = today's behavior.
- Storm mode: notify-first (`STORM_MODE_ENABLED` default off), only-raises, I4 clamp last.
- No write-path changes anywhere in this wave; I1/I4/I7/I8 untouched.
