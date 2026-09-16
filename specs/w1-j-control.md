# W1-J — control page: in-app modal, live timer, aria [after A, D]

**Owns exclusively:** `app/control/control-client.tsx`, `app/control/page.tsx`,
`app/ui/modal.tsx` (NEW). The highest-stakes surface (it commands the physical pumps).
Consumes A's `.scrim/.modal*` classes and D's `<Nav>`.

## SAFETY RAIL (non-negotiable)
Change the confirmation **UI only**. Do NOT touch any `fetch()` call, endpoint, payload, guard,
arming semantics, write-enable flow, or the I1/HBX logic. The server-side guardrails and the
"Modbus-off defeats a heat call" behavior are load-bearing and stay exactly as-is.

## 1. `app/ui/modal.tsx` (NEW, client)
A dependency-free in-app replacement for `window.confirm`/`window.prompt`, using A's classes.
Provide a `useModals()` hook returning:
- `confirm({ title, body, danger? }): Promise<boolean>`
- `prompt({ title, body, inputType? }): Promise<string|null>` (inputType "password" for arming)
and a `<Modals/>` element the component renders once (holds the `.scrim`/`.modal`). Enter submits,
Esc/backdrop cancels, autofocus the primary action / input. No portals needed — render in-tree.

## 2. `control-client.tsx`
- Replace `window.prompt(...)` in `arm()` with `await prompt({inputType:"password", …})`.
- Replace every `window.confirm(...)` (toggleWrite, HBX Set, Restore curve, Boost) with
  `await confirm({…, danger:true})`. Same messages, same downstream calls.
- Remove the local `<header>` (h1, Pi chip, sign-out) and the `.seg` "Analytics | Control" toggle
  (`control-client:185–207`) — the global Nav owns navigation now. KEEP the "Arm write-mode
  controls" button and the Pi-connected status: move the Pi chip to a small status line at the top
  of the content (e.g. a `.meta` row) so connection state is still visible.
- **Live-ticking armed countdown:** add `const [nowMs,setNowMs]=useState(Date.now())` driven by a
  `setInterval(()=>setNowMs(Date.now()),1000)` (cleared on unmount). Compute `armed` from `nowMs`
  so "(N min)" ticks down; when the window expires, flip the button back and null `armedUntil`.
- **aria-labels:** add `aria-label="decrease"/"increase"` to the HBX-target `−`/`+` buttons
  (`control-client:405,410`) — the pump steppers already have them; match.

## 3. `control/page.tsx`
Thin server wrapper — unchanged unless an import needs adjusting. Keeps `<I1Banner/>` + client.

## Constraints / acceptance
- `tsc --noEmit` + `npm run build` pass.
- Grep: **zero** `window.confirm|window.prompt|window.alert` in `control-client.tsx`;
  `app/ui/modal.tsx` exists; a `setInterval(` drives the armed timer; both HBX steppers have
  `aria-label`; no `action="/api/logout"` and no `>Analytics<` seg link remain in control-client.
- No `fetch(` call signature/URL/body changed (diff the fetch lines — must be identical).
- Max 3 files changed.
