# W1-F — HBX page (app/hbx/page.tsx) [after A, B, D]

**Owns exclusively:** `app/hbx/page.tsx`. This is the jargon-heaviest page — it gets the biggest
voice win. Consumes D's `<Nav>` and B's `<Chart>`.

## 1. Drop the local `<header>` (`hbx:198–205`)
Delete the h1 + nav `<a>`s + sign-out form. Keep the subtitle info elsewhere if useful, but the
global Nav owns navigation. Keep `<I1Banner/>` + `<StormBanner/>` and the 24h/7d controls.

## 2. Charts
- Swap the local `LineChart` usages to B's shared `Chart` (same Series shape). Delete the local
  `LineChart` definition.
- The local `CurveChart` (reset-curve scatter) is bespoke — KEEP it in-file but apply the same
  fix: `preserveAspectRatio="xMidYMid meet"` and `vectorEffect="non-scaling-stroke"` on its
  `<line>`/`<circle>`, wrapped in an aspect-ratio box. No `preserveAspectRatio="none"` may remain.

## 3. Voice pass — reword headings/labels (queries & logic UNCHANGED, display strings only)
- "Tank vs target vs HP setpoints °F (HP lines must stay above the red line — plan §3, invariant
  I1)" → "Tank vs. target vs. pump setpoints (pump lines must stay above the red line, or calls
  stall)". Legend "Target + 5°F (I1)" → "Minimum pump setpoint".
- "Shadow plan — next 24h (what the planner WOULD command; nothing is written …)" → "Practice
  plan — next 24h (what the planner would do — nothing is sent yet …)".
- "Phase B rehearsal (what the tracking loop … sent — the flip evidence)" → "Practice-control
  log (what it would have sent)".
- "Storm events (§6.11 ledger — armed windows, manual or triggered)" → "Storm events (armed
  heat-banking windows — manual or automatic)".
- "Winter solver — zone service floors (§6.9 SHADOW — proposes, never commands · {source})" →
  "Zone heating floors (a suggestion — never commands · {source})".
- "§6.10 unlock (recommend-only, modeled): mini-split assist …" → "Mini-split assist (suggestion
  only): …".
- Tank curve meta: expand raw keys — "diff {htDif}°F · bkLag {bkLag}m · permHD {on/off}" →
  "temp differential {htDif}°F · backup lag {bkLag} min · permanent heat demand {on/off}".
- Any remaining "I1"/"§x" may survive only as a small trailing `<span className="dim">` tag, never
  in an H3 heading.

## Constraints / acceptance
- `tsc --noEmit` + `npm run build` pass.
- Grep: no `action="/api/logout"` in `hbx/page.tsx`; no `preserveAspectRatio="none"`; no `§`
  characters remain inside any `<h3>` (voice check); charts import from `@/app/ui/chart`.
- Max 1 file changed.
