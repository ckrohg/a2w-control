# VISION — A2W Control

> Personal infrastructure project, not a startup. Full context: `reference/heatpump-bridge-handoff.md` — read it fully before proposing anything; its design decisions are settled.

## Problem

Two Arctic (Guangdong Macon MAHRW030ZA/BEH2) air-to-water heat pumps heat a home in southern New Hampshire. The only control surfaces are wall controllers in the basement and an HBX dry-contact call. No remote setpoint control, no monitoring, and faults surface as cryptic E/P/r codes on a small display — often discovered days later.

## Solution

A custom IoT bridge: RS-485 BMS port on each heat pump → isolated repeater → USR-W610 WiFi gateway → Raspberry Pi 5 running a Python/FastAPI bridge (pymodbus, RTU-over-TCP) → Cloudflare Tunnel → mobile-friendly web UI.

Delivers: remote setpoint control with guardrails, live temps/power/state, plain-English fault alerts with severity, and run history.

## Hard constraint

The existing manual control chain keeps working untouched. Wall controllers remain the local display and fallback. If the entire custom stack dies, heating operates exactly as before this project existed.

## Owner's engineering philosophy

Right-sized over over-engineered, always. SQLite not Postgres, Cloudflare Access not custom auth, unshielded wire validated by error-rate logging not shielded wire by default. Propose the minimal correct solution first.

## North star

Change a setpoint from a phone; get a plain-English alert (that isn't a false alarm) when something is actually wrong. P17 anti-freeze must never page anyone.
