# SPAN backup-element ARM control — spec

**Status:** Phase 1 (shadow) building 2026-07-18. Phase 2 (live) gated on shadow validation + owner go.

## Goal

Let the A2W system turn the 16.5 kW backup element **ON (available)** at the SPAN panel level — so an
accidentally-left-off breaker can't silently disable the failsafe — while giving the owner a **dead-simple,
always-available way to disarm** that capability when the element is off *on purpose*.

The element is a **failsafe, not a heat source** (see memory `backup-control-design`, `span-backup-alarm`).
This feature never changes that: it only ensures the failsafe is *available*; the **HBX still decides when to
actually energize** it (bkLag/bkDif). "Relay CLOSED" = circuit powered/available ≠ element running.

## Core safety invariant (code-enforced)

> **A2W's SPAN relay control is CLOSE-ONLY.** The relay function physically refuses to send `OPEN`.

Consequences, by construction:
- A2W can **never disable** the failsafe, only make it available.
- A2W **never switches a live 16.5 kW load off** (it only ever closes an already-open/idle circuit).
- The one dangerous direction (disabling the element) stays **exclusively with the owner** (physical breaker,
  SPAN app, or the disarm below). Every prior safety concern collapses to this single property.

## Behavior / state machine

The owner sets one intent flag, `arm` (ARMED / DISARMED). Default at launch = **DISARMED**.

| `arm` | A2W behavior each SPAN poll (~25 s) |
|-------|--------------------------------------|
| **ARMED**    | If `Buffer Tank relayState == OPEN` → **close it** (make available), rate-limited + audited + alerted. Never opens. |
| **DISARMED** | A2W does **nothing** to the relay — the owner's deliberate "off" is respected, full stop. |

`arm_live` gates shadow vs live: `False` = **shadow** (log the *would-arm* decision, toggle nothing);
`True` = actually close the relay (Phase 2).

## The disarm (must be dead-simple)

- **One toggle in the a2w portal** (Vercel dashboard, reachable anywhere): *"Let A2W keep the backup element
  armed — [ON | OFF]"*, with the **live relay state** shown beside it.
- **Disarm is instant, one tap, zero ceremony** — it's the conservative direction, so no password/confirm
  friction. Arming carries a light "you're letting A2W enable the element" note.
- **Authoritative even offline:** the arm intent **persists locally on the Pi bridge** (synced from the portal
  via the hub, same path as write-enable). If the cloud/hub is down, the bridge honors its **last-persisted
  intent** — it will never "wake up armed" and flip the element on during an outage. Default persisted = DISARMED.

## Guardrails (same rigor as HBX writes)

- **Close-only** invariant (above).
- **Anti-flap:** at most one arm action per `arm_cooldown_s` (default 300 s); a repeated OPEN within the cooldown
  is logged, not re-acted, so a portal/physical toggle war can't thrash the relay.
- **Audit + alert on every action:** ntfy *"A2W armed the backup element at SPAN — disarm in the portal if you
  meant to keep it off."* So an accidental re-arm is always visible and one tap to stop.
- **Fail-safe defaults:** on any uncertainty (can't read arm intent, SPAN unreachable) → do nothing; never act
  against the last-persisted intent.
- **Switching is off-load only:** a consequence of close-only + closing only when relay is already OPEN (0 W).

## Architecture

- **Decision + execution: the bridge** (`span_local.py`) — it already polls the circuit relay state on the LAN.
  Adds a **close-only** `set_relay(circuit, "CLOSED")` and a per-poll arm evaluation. Reuses the existing
  registered token (dashboard scope covers circuit control).
- **Arm intent: owner-controlled**, persisted on the bridge (`bridge-data/span-arm.json`), default DISARMED.
  Settable via `POST /api/span/arm` (human-only auth, like write-enable) and via the **hub relay** so the
  Vercel portal can set it (new `span_arm` WS action, mirrors `write_enable`).
- **Portal (analytics-mirror):** a card showing relay state + arm state + recent *would-arm* shadow events, plus
  the disarm toggle (→ hub → bridge). Fed by the bridge's exporter push (arm state + shadow events → Neon).

## Rollout

1. **Phase 1 — shadow (this build):** capture relay state; evaluate the arm decision; **log every *would-arm*
   event** (armed + relay OPEN → what it *would* do), toggle NOTHING on SPAN (`arm_live=false`). Prove the logic
   and that the portal disarm reliably suppresses would-arm events. Portal shows the shadow stream + the toggle.
2. **Phase 2 — live:** flip `arm_live=true` → the same decision now actually closes the relay (still close-only,
   guarded, audited). Owner go required.

## Open decisions

- **Launch default = DISARMED** (owner is mid shadow-test with the element deliberately off; don't surprise them).
- **Trigger = proactive** ("keep available whenever armed") vs reactive ("only close during an active failsafe:
  DHW-shortfall / freeze-risk / HP-capacity-outage"). Recommend **proactive** — simpler, and "available" is harmless.
