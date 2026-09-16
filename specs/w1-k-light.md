# W1-K — light pages: savings + advanced [after A, D]

**Owns exclusively:** `app/savings/page.tsx` AND `app/advanced/page.tsx`. Both are chart-free
(tables/cards), so no dep on B — only D's `<Nav>`. One agent, two disjoint files.

## savings/page.tsx
1. Drop the local `<header>` (`savings:121–127`): h1 + nav `<a>`s + sign-out → global Nav owns
   them. Keep `<I1Banner/>` + `<StormBanner/>`, the window `.seg`, and every card/table/footnote.
   The savings page's plain-English voice is the house gold standard — do NOT touch its copy.

## advanced/page.tsx
1. Drop the local `<header>` (`advanced:58–63`).
2. Humane empty-state copy (`advanced:67–72`): change "No full snapshots yet. This feed ships
   with the next Pi release tag (exporter change is on main). Until then the Pi's own dashboard
   …" → "Full register detail appears here once a pump pushes its next 5-minute snapshot. Until
   then, the Pi's own dashboard (over the local network) has the complete view."
3. This is an EXPERT page — the raw register KV dump stays raw (that's its job). No voice pass on
   the parameter tables.

## Constraints / acceptance
- `tsc --noEmit` + `npm run build` pass.
- Grep: neither file contains `action="/api/logout"`; advanced empty-state no longer contains
  "next Pi release tag".
- Max 2 files changed.
