# W1-A: design foundation — globals.css tokens, focus/hover, 44px, nav/modal classes

Source: Issue #23

Wave W1-UI root (spec: specs/w1-a-foundation.md). CSS-ONLY, owns analytics-mirror/app/globals.css exclusively. Adds: semantic color tokens (--c-tank/outdoor/target/setpoint/power/plan/crit/ok); :focus-visible rings + button hover/active + subtle card hover (reduced-motion guarded); 44px min tap targets on button/.btn/.nav-tabs a; PRE-DECLARED nav classes (.nav/.nav-brand/.nav-sub/.nav-tabs/.nav-tabs a.active/.nav-more/.nav-signout, mobile bottom-bar); PRE-DECLARED modal classes (.scrim/.modal/.modal-title/.modal-body/.modal-actions/.modal input); chart sizing tweak (.chart svg{height:auto} + .chart--fixed). This is the class/token CONTRACT every downstream issue consumes — nobody else edits globals.css. Acceptance: tsc + next build pass; grep shows :focus-visible, .nav-tabs, .scrim, --c-tank present; no class a page currently uses is removed. Max 1 file.

<!-- tenet:
source: mcp-agent
auto_detected: false
target_repo: ckrohg/a2w-control
-->
