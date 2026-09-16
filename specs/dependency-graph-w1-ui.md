# Dependency graph — W1-UI wave (dashboard product-shell + polish)

Owner-approved 2026-07-15 ("tackle all of these using a dep-graph wave"). Source: the
Apple/Google-lens UI eval of `analytics-mirror/` (journal: "UI eval … 7 strong pages, no
product shell"). Owner decisions: product name **"A2W Control"** with subtitle
**"analytics & control"**; **Control sits in the primary nav**; full wave now.

All changes in `analytics-mirror/`. House idioms hold everywhere: every page/route exports
`runtime="nodejs"`, `dynamic="force-dynamic"`, `fetchCache="force-no-store"`; parameterized
`sql` tagged templates; try/catch degraded states; °F display; Eastern time via `@/lib/tz`.

## Why this wave is sliced by FILE, not by topic

Unlike W0 (disjoint pure modules `store/demand/storm.ts`), every UI finding wants the same
few files (`globals.css`, `layout.tsx`, the 5 page files). Slicing by topic would make every
agent collide on `globals.css` and the page headers. So we slice by **file ownership**: no
two issues in the same wave touch the same file. `globals.css` is a single-owner root (A);
new shared components are disjoint new files (B chart, D nav, J modal); each page is owned by
exactly one page-issue. This is the wave-trap ("agents sharing files run sequentially, each
PR merged before the dependent dispatches") turned into the graph's shape.

## Graph

```
A  w1-a-foundation   globals.css: semantic color tokens, :focus-visible, hover/active,   [no deps]
                     44px tap targets, PRE-DECLARED .nav*/.modal*/.scrim classes
                     (the contract B/D/J/pages consume)
   ├─ B w1-b-chart   app/ui/chart.tsx (NEW): shared TimeSeries primitive —               [A]
   │                 vector-effect non-scaling-stroke, xMidYMid meet, aspect box,
   │                 hover readout, palette from A's tokens
   └─ D w1-d-shell   app/nav.tsx (NEW, client, usePathname) + layout.tsx (render <Nav/>,  [A]
                     name+subtitle) + reword i1-banner/storm-banner to plain English
          ↓ primitives ready (B,D merged)
   E  w1-e-home      app/page.tsx            drop local header, shared chart, humane error  [A,B,D]
   F  w1-f-hbx       app/hbx/page.tsx        drop header, shared chart, JARGON→plain voice  [A,B,D]
   G  w1-g-curve     app/curve/page.tsx      non-scaling-stroke on bespoke charts, mobile   [A,B,D]
   K  w1-k-light     app/savings + advanced  drop headers, humane error copy (chart-free)   [A,D]
   J  w1-j-control   app/control/* + ui/modal.tsx  in-app modal replaces window.*,          [A,D]
                                             live-ticking armed timer, aria-labels
```

`B`'s dep on `A`, `D`'s on `A`, and every page's on its primitives are **contract deps**
(they consume A's classes / B's `<Chart>` / D's `<Nav>`), reinforced as **dispatch-order**
deps so the class/component exists at build time. Within a wave, files are disjoint → no
merge conflict; still dispatched single-PID sequentially per the build-agent default, each
PR merged to main before the next wave dispatches.

## Value scores (V impact 1–5 × U unlocks ÷ C cost in rounds)

| Issue | V | U | C | V·U/C | Notes |
|---|---|---|---|---|---|
| A foundation | 4 | 5 | 1 | 20.0 | tiny CSS-only file; unlocks every other issue |
| D shell/nav  | 5 | 5 | 2 | 12.5 | fixes the #1 finding (IA); unlocks all pages |
| B chart      | 4 | 3 | 2 | 6.0  | kills the preserveAspectRatio distortion at the source |
| F hbx        | 4 | 0 | 2 | leaf | jargon-heaviest page; biggest voice win |
| J control    | 4 | 0 | 3 | leaf | highest-stakes surface; native-dialog removal |
| E home       | 3 | 0 | 2 | leaf | most-visited page |
| G curve      | 3 | 0 | 2 | leaf | most complex charts; mobile treatment |
| K light      | 2 | 0 | 1 | leaf | savings+advanced, mostly header removal |

## Execution order (3 merge-synchronized waves)

```
Wave 1:  A                         (globals.css singleton — root)
Wave 2:  B, D                      (disjoint new files; both consume A)
Wave 3:  E, F, G, K, J             (one page-file each; consume primitives)
```

Report to owner at each wave boundary.

## The class/token contract A lays down (everyone else consumes, nobody else edits globals.css)

Semantic color tokens on `:root` (formalize today's ad-hoc hex into names):
`--c-tank:#4dabf7` · `--c-outdoor:#845ef7` · `--c-target:#ffd666` · `--c-setpoint:#63e6be`
· `--c-power:#ff9f43` · `--c-plan:#e599f7` · `--c-crit:#ff6b6b` · `--c-ok:#63e6be`.
Nav: `.nav` `.nav-brand` `.nav-sub` `.nav-tabs` `.nav-tabs a` `.nav-tabs a.active`
`.nav-more` `.nav-signout`; mobile → bottom bar via `@media(max-width:640px)`.
Modal: `.scrim` (fixed dim overlay) · `.modal` (centered sheet) · `.modal-title`
`.modal-body` `.modal-actions` `.modal input`.
Interaction: `a,button,input:focus-visible{outline:2px solid var(--info);outline-offset:2px}`
· `button:hover`/`:active` · `.card` subtle hover · min-height:44px on `button,.btn,.nav-tabs a`.

## Safety rails carried by EVERY spec (mirrors W0 §rails)

- **No write-PATH logic changes.** J swaps only the confirmation *UI* (in-app modal for
  `window.confirm`/`prompt`); the server-side guardrails, arming semantics, HBX-override
  behavior, and I1/I4 checks are UNTOUCHED. (Memory: HBX-override-Modbus-wins — do not relax.)
- Phase B stays off; shadow/practice framing preserved. No planner behavior changes.
- All degraded/empty/`dbError` states preserved (copy may become humane, logic stays).
- °F display + Eastern time (`@/lib/tz`) idioms enforced; no timezone regressions.
- No secrets to the browser (unchanged from today).
- Max ~4 files changed per issue; PRs extracted file-by-file (agent PRs carry settings churn).

## Eval gradient (per issue)

Compile gate: `npx -p typescript tsc --noEmit` + `npm run build` in `analytics-mirror/`.
Plus structural behavioral greps (issue-specific), e.g.: no `preserveAspectRatio="none"`
survives B/G; no `window.confirm|prompt|alert` survives J; no duplicated
`action="/api/logout"` `<form>` survives the page issues; charts carry `vector-effect`;
`.nav` renders in `layout.tsx`. Read convergence from tenet output ("Score hit 1.0" + PR),
not the script's re-score (it scores MAIN).
