# W1-B — shared chart primitive (app/ui/chart.tsx) [after A]

**Owns exclusively:** `analytics-mirror/app/ui/chart.tsx` (NEW file). Does NOT edit any page or
`globals.css`. Consumes A's color tokens.

**Problem it fixes (from the eval):** every chart today is hand-rolled SVG with
`preserveAspectRatio="none"`, which stretches a 900-wide drawing to the container width
non-uniformly → distorted stroke widths, horizontally-crushed axis text, and circles rendered
as ellipses. Worst on mobile (900→~350px). There are also ~2 near-duplicate `Chart`/`LineChart`
implementations (home `page.tsx:26`, hbx `page.tsx:23`) that drift.

## Deliverable: one exported primitive the time-series pages reuse

Extract a single component that is a superset of the home `Chart` and hbx `LineChart` (they
already share 90% of their code). Signature (keep it a drop-in for both call sites):
```ts
export type Pt = { x:number; y:number|null };
export type Series = { color:string; points:Pt[]; dash?:boolean; width?:number; label?:string };
export type Band = { x0:number; x1:number; color?:string };
export function Chart(props: {
  series: Series[]; hours: number; bands?: Band[]; height?: number;   // default 200
  yFmt?: (n:number)=>string;                                          // axis label formatter
}): JSX.Element
```
Server-component safe (no "use client") — it renders pure SVG from props, same as today.

## The three fixes, all inside this component

1. **No non-uniform stretch.** Use `preserveAspectRatio="xMidYMid meet"` and render into an
   aspect-ratio box: outer `<svg viewBox="0 0 900 H" style={{ width:"100%", height:"auto", aspectRatio:`900/${H}` }}>`.
   (The `.chart svg{height:auto}` tweak from A makes this work.)
2. **Uniform strokes regardless of any residual scaling.** Every `<path>`, `<line>`, `<circle>`,
   `<rect>` gets `vectorEffect="non-scaling-stroke"`. Axis/label `<text>` stays upright and legible.
3. **Hover readout.** Add an invisible full-height `<rect>` per sample bucket (or a single
   pointer-move overlay) that shows a `<title>` with `{time} · {series.label}: {yFmt(y)}` — at
   minimum, put `<title>` on each series path so hovering a line surfaces its label. Keep it
   SSR-only (native `<title>` tooltips need no JS).

Preserve the existing behaviors exactly: y-range auto-fit with the `<4°` min-spread widening,
3-gridline layout, first/last x time labels via the caller's formatter, band strips (running /
unserved-call), dashed series, null-gap filtering. Colors come from callers (who will pass A's
`var(--c-*)` tokens post-B), so do not hardcode a palette here beyond sensible fallbacks.

## Not in scope
- Do NOT edit the pages to use it (that's E/F/G). B only creates the file + exports.
- Do NOT touch the bespoke curve-page charts (CurveField/ReceiptChart/season) — G handles those.

## Constraints / acceptance
- `npx -p typescript tsc --noEmit` + `npm run build` pass (the file must compile standalone;
  it's not yet imported, so also add a throwaway type-only self-check or ensure exports are used
  by nothing — build must not tree-shake-error).
- Grep: `app/ui/chart.tsx` contains `non-scaling-stroke` and `xMidYMid meet`, and NO
  `preserveAspectRatio="none"`.
- Max 1 file changed (the new file).
