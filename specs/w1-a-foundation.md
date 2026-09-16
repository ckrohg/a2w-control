# W1-A — design foundation (globals.css) [ROOT]

**Owns exclusively:** `analytics-mirror/app/globals.css`. No other file. This is the root of
the CSS chain — B, D, J, and every page consume the classes/tokens declared here and MUST NOT
edit `globals.css` themselves.

**Goal:** turn today's ad-hoc inline hex + missing interaction states into a small design
system, and PRE-DECLARE the nav/modal classes downstream issues will use, so nothing else has
to touch this file.

## 1. Semantic color tokens (add to `:root`, keep existing vars)

Add named tokens that formalize the hex already used across pages (do NOT remove existing
`--info/--ok/--warm/--crit` — alias to them):
```
--c-tank:#4dabf7; --c-outdoor:#845ef7; --c-target:#ffd666; --c-setpoint:#63e6be;
--c-power:#ff9f43; --c-plan:#e599f7; --c-crit:#ff6b6b; --c-ok:#63e6be;
```
Rationale in a comment: one place defines "tank is blue, outdoor is purple, plan is magenta"
so charts stop drifting per-page.

## 2. Interaction states (currently absent — keyboard users get nothing)

- `a:focus-visible, button:focus-visible, input:focus-visible { outline:2px solid var(--info); outline-offset:2px; border-radius:9px; }`
- `button:hover, .btn:hover { background:#2a3540; }` and `button:active, .btn:active { transform:translateY(1px); }`
- `.card { transition:border-color .15s; }` `.card:hover { border-color:#3a4650; }` (subtle only)
- Respect reduced motion: wrap transforms/transitions in `@media (prefers-reduced-motion: no-preference)`.

## 3. Tap targets (Apple HIG 44px floor)

`button, .btn, .nav-tabs a { min-height:44px; display:inline-flex; align-items:center; }`
Keep existing padding; only enforce the min. The `.temp`-tile steppers inherit via `button`.

## 4. PRE-DECLARE nav classes (D consumes; do NOT build nav here — just the CSS)

```
.nav { display:flex; align-items:center; gap:14px; margin-bottom:18px; flex-wrap:wrap; }
.nav-brand { font-size:20px; font-weight:650; }
.nav-sub { color:var(--dim); font-size:12px; }         /* the "analytics & control" subtitle */
.nav-tabs { display:flex; gap:4px; margin-left:auto; }  /* desktop: right-aligned tabs */
.nav-tabs a { color:var(--dim); text-decoration:none; padding:8px 12px; border-radius:9px; font-weight:600; font-size:14px; }
.nav-tabs a.active { background:var(--card2); color:var(--text); }
.nav-more { color:var(--dim); font-size:13px; text-decoration:none; }
.nav-signout { }  /* the sign-out form/button; inherits button styles */
```
Mobile (`@media max-width:640px`): tabs become a fixed **bottom bar**
```
.nav-tabs { position:fixed; left:0; right:0; bottom:0; margin:0; justify-content:space-around;
  background:var(--card); border-top:1px solid var(--line); padding:6px 4px; z-index:50; }
body { padding-bottom:76px; }  /* clear the bottom bar */
```

## 5. PRE-DECLARE modal/scrim classes (J consumes)

```
.scrim { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center;
  justify-content:center; z-index:100; padding:16px; }
.modal { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:20px;
  max-width:380px; width:100%; }
.modal-title { font-size:16px; font-weight:650; margin-bottom:8px; }
.modal-body { color:var(--dim); font-size:13.5px; margin-bottom:14px; }
.modal-actions { display:flex; gap:8px; justify-content:flex-end; }
.modal input { width:100%; }  /* reuse .login input look */
```

## 6. Chart sizing hook (let B/G use aspect-ratio without fighting a fixed height)

Change `.chart svg { width:100%; height:200px; }` → keep a default but allow override:
`.chart svg { width:100%; height:auto; display:block; }` and give the non-aspect legacy charts
a wrapper rule `.chart--fixed svg { height:200px; }`. (B/G will render with an aspect-ratio box;
this stops the CSS from forcing a stretched 200px.)

## Constraints / acceptance
- CSS only — zero `.tsx` changes. `npm run build` still passes (no class removed that a page
  currently uses; only additions + the two documented rule tweaks).
- Grep: `:focus-visible` present; `.nav-tabs` present; `.scrim` present; `--c-tank` present.
- Max 1 file changed.
