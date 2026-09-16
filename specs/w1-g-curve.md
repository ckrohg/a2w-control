# W1-G — curve page (app/curve/page.tsx) [after A, B, D]

**Owns exclusively:** `app/curve/page.tsx`. The most chart-dense page and the most distorted
today. Consumes D's `<Nav>`. Its charts are bespoke (CurveField/ReceiptChart/SeasonKwh/
SeasonTemps) — B's primitive doesn't fit them, so the chart fix is applied IN-FILE.

## 1. Drop the local `<header>` (`curve:396–403`)
Delete h1 + nav `<a>`s + sign-out. Keep `<I1Banner/>` + `<StormBanner/>` and all cards/charts.

## 2. Fix the chart rendering on ALL four bespoke charts
Each already sets an inline `aspectRatio` but still uses `preserveAspectRatio="none"` — that's
the exact non-uniform-stretch bug (crushed text, elliptical dots). For CurveField, ReceiptChart,
SeasonKwh, SeasonTemps:
- change `preserveAspectRatio="none"` → `"xMidYMid meet"`.
- add `vectorEffect="non-scaling-stroke"` to every `<path>`, `<line>`, `<circle>`, `<rect>`.
This makes the iso-COP arcs, the density-cloud rects, the scatter circles, and every on-chart
`<Note>` render at true proportions. Keep all data math, contours, envelope, labels identical.

## 3. Mobile legibility (right-sized — no redesign)
The hero CurveField packs many on-chart annotations; with `meet` they no longer stretch. That's
the required fix. Do NOT redo the layout. (A separate future card can add a tap-to-expand.)

## 4. Light voice
Leave the (already strong) prose. In "Honesty notes", drop the bare "§6.9"/"§8.1"/"plan §8.1"
tokens to plain words ("the winter solver isn't built yet"; "the meter is the ledger"). Do not
touch the numbers or the measured-vs-modeled labeling.

## Constraints / acceptance
- `tsc --noEmit` + `npm run build` pass.
- Grep: no `action="/api/logout"` in `curve/page.tsx`; **zero** `preserveAspectRatio="none"`;
  `vectorEffect` present on the charts.
- Max 1 file changed.
