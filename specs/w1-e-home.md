# W1-E — home page (app/page.tsx) [after A, B, D]

**Owns exclusively:** `app/page.tsx`. Consumes D's global `<Nav>` and B's `<Chart>`.

## Changes
1. **Drop the local `<header>`** (`page.tsx:143–154`): the h1, the 5 nav `<a className="btn">`
   buttons, and the sign-out `<form>` are all provided by the global `<Nav>` now. Delete the
   whole `<header>` block. The page body starts at `<I1Banner/>` (keep the banners — they are NOT
   in the layout).
2. **Use the shared chart.** Delete the local `function Chart(...)` (`page.tsx:26–62`) and its
   local `Pt/Series/Band` types; `import { Chart, type Series, type Band } from "@/app/ui/chart"`.
   Keep every existing series/band/color and the 24h/7d toggle exactly. Pass A's tokens
   (`var(--c-tank)` etc.) as the series colors instead of raw hex where trivial (optional; keeping
   the hex is acceptable if token substitution risks the build).
3. **Humane DB-error copy** (`page.tsx:179`): change "Database not reachable — check the Vercel
   Postgres integration & env vars." → "Can't load live data right now — this page retries on its
   own." (Keep the `dbError` logic identical.)

Everything else on the home page (chips row, fault cards, pump/tank/planner cards, running &
unserved-call bands, per-pump charts) stays byte-for-byte behaviorally.

## Constraints / acceptance
- `tsc --noEmit` + `npm run build` pass.
- Grep: no `action="/api/logout"` in `page.tsx`; no `function Chart(` in `page.tsx`; imports from
  `@/app/ui/chart`; DB-error string no longer contains "Vercel Postgres".
- Max 1 file changed.
