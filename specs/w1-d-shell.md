# W1-D — app shell / nav (nav.tsx + layout.tsx + banner reword) [after A]

**Owns exclusively:** `app/nav.tsx` (NEW), `app/layout.tsx`, `app/i1-banner.tsx`,
`app/storm-banner.tsx`. Consumes A's `.nav*` classes. Fixes the #1 eval finding (navigation/IA).

## 1. `app/nav.tsx` (NEW, client component)

```tsx
"use client";
import { usePathname } from "next/navigation";
```
Render nothing when `pathname === "/login"`. Otherwise render `<nav className="nav">`:
- `.nav-brand` "A2W Control" + `.nav-sub` "analytics & control"
- `.nav-tabs` with, in order: Home `/`, Tank `/hbx`, Curve `/curve`, Savings `/savings`,
  Control `/control`. Each `<a>`; add `className="active"` when the tab matches the current
  path (`/` active only when pathname === "/"; others when pathname startsWith the href).
- a `.nav-more` link "Advanced →" to `/advanced` (deliberately de-emphasized, per owner: not a
  primary tab).
- a sign-out `<form action="/api/logout" method="post">` with a `.nav-signout` button — this is
  now the ONE sign-out control (pages drop theirs in E/F/G/K/J).

Control IS a primary tab (owner decision). No behavior/routing changes beyond links.

## 2. `app/layout.tsx`

- Import and render `<Nav />` directly inside `<body>`, above `{children}`.
- Update `metadata.title` → **"A2W Control"**, description → "Air-to-water heat-pump analytics
  & control". (Was "A2W Analytics" — the product-name drift the eval flagged.)
- Keep `import "./globals.css"`. Layout stays a server component; rendering the client `<Nav/>`
  inside it is fine. Do NOT render banners here (they'd run SQL on /login).

## 3. Reword the banners to plain English (logic UNCHANGED — text only)

`i1-banner.tsx`: keep every query/threshold/computation. Change ONLY the JSX copy so it leads
with plain language, not a code. New text (keep the computed `target`, `required`, `offenders`):
> ⚠ **Heat can't reach the tank:** the buffer needs pump setpoints ≥ {required}°F to hit its
> {target}°F target, but {offenders} {is/are} set below that — calls will stall and fall back to
> the backup heater. Raise the pump setpoint or lower the tank target. <span dim>(conflict I1)</span>

`storm-banner.tsx`: keep query; reword to:
> ⛈ **Storm mode armed** — banking heat ahead of {trigger} · since {fmtTime(t)}{ceiling}.

## Constraints / acceptance
- `tsc --noEmit` + `npm run build` pass.
- Grep: `app/nav.tsx` exists, contains `usePathname` and `/login` (the hide check) and all five
  tab hrefs + `/advanced`; `layout.tsx` renders `<Nav`; `layout.tsx` title is "A2W Control";
  `i1-banner.tsx` no longer STARTS its banner with "I1 conflict:".
- Max 4 files changed. No page files touched (pages remove their headers in their own issues).
