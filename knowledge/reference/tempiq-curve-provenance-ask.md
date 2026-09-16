<!--
@purpose Draft request to TempIQ for the required-supply curve's parameters + provenance
(#89 item 3). Mirrors the winnie-followup-draft.md pattern: written here, sent by the owner.
Context: A2W consumes requiredSupplyWaterTempF to set this house's water temperature, and we
cannot currently see where the number comes from.
-->

**FILED 2026-09-16 as [ckrohg-org/TempIQv2#2025](https://github.com/ckrohg-org/TempIQv2/issues/2025).** This document is the source text; the issue is the live thread.

# Ask TempIQ: expose the required-supply curve's parameters and provenance

**Why this matters to A2W:** `requiredSupplyWaterTempF` is consumed live to set the demand
floor, which sets the buffer tank target, which sets the water temperature this house actually
runs at. Below ~50 °F outdoor it pegs our floor at `strictCapF`. We are acting on a number we
cannot inspect.

## What we believe (and want confirmed or corrected)

Reading `server/services/thermal/emitter-model.ts`, `designSupplyF` appears to resolve from
`demonstratedMaxF` — the p99 of this house's own historical SensorLinx supply readings over
365 days. This house ran as-found at 154–165 °F, so the curve's design anchor is essentially
*"what we used to run"*, not *"what the emitters need"*. If so the number is circular for our
purpose: we are using it to justify running at roughly the temperature we are trying to move
away from.

Corroborating signal on our side: the `ceilingSource` you emit reads `demonstrated_max` for
both of our baseboard zones in production today.

## The request

For each zone in `/api/insights/zones`, alongside `requiredSupplyWaterTempF`:

1. **`designSupplyF` and its source** — is it `demonstrated_max`, a type-curve default, or an
   actual fit against measured emitter output? (You already emit `ceilingSource`; we want the
   same provenance on the design anchor itself.)
2. **The curve parameters** — design outdoor temp, design supply temp, indoor reference, and
   the exponent/slope used between them, so we can reproduce the value locally and diff it.
3. **A confidence or sample-count field** — how much evidence stands behind this zone's curve.
4. **Explicitly flag defaults.** Related: `tempiq_zone_physics.ua_btu_hr_f` arrives with
   `source='default'` and confidence 0.04–0.15 for all 18 zones. That is fine as a fallback,
   but it is currently indistinguishable at a glance from a learned value, and we nearly used
   it as measured evidence.

## What we are NOT asking for

Not asking you to change the number. We want to see its provenance so A2W can decide how much
weight to give it. Our current policy (`DEMAND_FLOOR_POLICY=escalate`, #90) already treats it
as a ceiling rather than a target, with the room's own measured deficit deciding how far
toward it we go — so a low-confidence curve degrades gracefully. Provenance would let us stop
guessing about that.

## Related

- a2w-control#89 — the divergence (up to 45 °F at 10 °F outdoor)
- TempIQv2#2009 — the A-8 contract review where this surfaced
- TempIQv2#1630 — still open; the world-prior's modeling flaw
