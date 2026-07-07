# TempIQ → A2W setpoint integration — design sketch (Phase 4, NOT built)

> A proposal for how TempIQ (which already holds this house's weather + learned per-zone
> thermal model) drives the A2W heat-pump buffer setpoint for savings. Nothing here is built;
> the A2W side needs **no new bridge code** to start (the API + lease + floor already exist —
> see `deploy/api-integration.md`), except the one small refinement in §5. TempIQ-side code is
> future work in the TempIQ repo (which stays read-only reference until then).

## The 3-way division of labor (who owns what)

| System | Owns | Reliability role |
|---|---|---|
| **A2W** (Pi) | The Modbus write + **safety**: floor clamp, guardrails, lease enforcement, baseline revert, audit. | Dumb, always-on backstop. Correct even if TempIQ is buggy or silent. |
| **TempIQ** (Railway) | The **decision**: what buffer temp, from weather + learned per-zone loads. The lease-renewal loop. | Smart layer. If it dies, the lease lapses and A2W reverts to baseline — safe by design. |
| **HBX** (ECO-0600) | **When** to call for heat (dry contact → CN33) + physical buffer mgmt + the 16.5 kW element. | Independent heat-call + freeze backstop. |

A2W never trusts TempIQ for safety; TempIQ never touches a register directly. Clean separation.

## 1. Token scope

Add one token to the Pi's `~/bridge-data/config.yaml`. Two-stage, encoded entirely in the scope:

```yaml
auth:
  protect: writes
  tokens:
    - token: "<openssl rand -hex 24>"
      source: tempiq        # unspoofable audit identity — every write is attributed to TempIQ
      can_write: false      # PHASE A (shadow): read-only. flip to true for PHASE B (active).
```

- **Phase A — shadow (weeks):** `can_write: false`. TempIQ reads `/status` + `/history`, computes
  the buffer target it *would* set, logs it in its own DB, and you compare against reality. Zero risk.
- **Phase B — active:** flip `can_write: true`. TempIQ now writes — **setpoint-only** (power/mode/params
  are 403 for tokens under `restrict_unattended_writes`), floor-clamped, leased.

## 2. The lease-renewal loop (TempIQ side, ~every 15 min)

```
on each 15-min tick:
  s = GET /api/pumps/pump1/status          # temps, setpoint_bounds_c, mode, remote_lease_until
  if s.mode != "heating": return           # cooling season / off — do nothing
  target = computeBufferTarget(s)          # §3
  target = clamp(target, s.setpoint_bounds_c)   # respect the LIVE floor + reg-2027 cap
  for pump in [pump1, pump2]:              # both feed the one shared buffer → same target
    POST /api/pumps/{pump}/setpoint {value: round(target), lease_minutes: 90}
    handle 200 / 422 clamp / 429 backoff / 409 re-read / 503 skip   # api-integration.md §4
```

- **Lease = 90 min, renewed every 15 → 6× safety margin.** If TempIQ crashes / Railway redeploys /
  the tunnel blips, the lease lapses and A2W reverts to `baseline_setpoint_c` (48 °C) on its own.
  The house is never stranded at a stale, possibly-low optimizer value.
- **Re-assert every tick even when the target is unchanged** (fresh lease). The Pi validates the
  lease against its own clock, so a late/retried write can't fire stale — idempotency for free.
- **Stateless caller:** TempIQ holds no command-queue; the Pi owns "what's still valid."

## 3. Mapping per-zone data → one buffer setpoint (the interesting part)

TempIQ knows 7 hydronic zones off the buffer; A2W controls ONE thing (the HP leaving-water-temp).
The buffer must be hot enough for the **binding** (most-demanding-vs-its-emitter) zone:

```
computeBufferTarget(s):
  for each hydronic zone z:
    load_z   = UA_z × (roomSetpoint_z − outdoor) − gains_z         # TempIQ already computes this
    reqWater_z = roomTemp_z + load_z / emitterConductance_z         # emitter curve (see gap #2)
  target = max_z(reqWater_z)               # the binding zone sets the buffer temp
  target += bufferToEmitterDropMargin      # ~2-3 °C: commanded setpoint > delivered emitter temp
  return max(target, freezeFloor)          # never below safe (A2W re-clamps anyway)
```

This is **outdoor-reset / weather-compensation, but data-driven** off the learned per-zone loads
instead of a generic curve. The binding zone is typically the highest-UA baseboard zone
(Dining 27.9, Master Bath 23.1 W/°F).

**Why it saves:** TempIQ's own measurement shows the hydronic COP is **2.69 flat vs. outdoor →
the buffer is currently a fixed setpoint**. On mild days the binding zone needs far less than 45-50 °C;
dropping the target raises COP (theoretical 3.3 @ 40-55 °F vs 2.2 @ <25 °F) and cuts standby loss.
That headroom is the whole savings case.

## 4. The tension: static floor vs. savings headroom

The static 45 °C freeze floor (see `winter-safe-floor-analysis.md`) **blocks** the mild-day savings —
TempIQ asking for 38 °C on a 40 °F day is clamped up to 45. So the rollout ends with a choice:
- **(a)** Lower the *static* floor toward the true freeze minimum (~40 °C, once commissioning
  validates it) — the backstop only needs to prevent a freeze, and TempIQ owns comfort; or
- **(b)** Make the A2W floor **weather-compensated** (outdoor-indexed via reg 2052 ambient) so it
  relaxes on mild days. A2W already reads ambient, so this is a small on-Pi enhancement.

Either unlocks the deeper setback. Start static/conservative; pick (a) or (b) at Phase C.

## 5. Open items this sketch surfaces

1. **Lease-renew-without-rewrite (small A2W refinement, do before Phase B):** `write_setpoint`
   physically writes the register every call (`poller.py:491`) then sets the lease. A 15-min
   renewal loop therefore writes the register 96×/day even when unchanged — and the rate limit
   exists to "protect the pump's EEPROM." Fix: if the requested value already equals the verified
   `snapshot["setpoint_c"]`, refresh the lease timer but **skip** the physical write. Cheap, and it
   protects EEPROM regardless of whether the unit commits setpoints to EEPROM.
2. **Emitter curve is assumed, not measured** (`emitterConductance_z`): TempIQ currently ASSUMES
   supply temps by emitter type (baseboard 140 °F, radiant 95 °F). Measure actual output-vs-water-temp
   per zone at commissioning to make the mapping accurate (else keep the conservative assumed curve).
3. **HBX buffer-target vs. HP-LWT interaction:** A2W/TempIQ set the HP's LWT *ceiling*; HBX decides
   when to stop calling. TempIQ's setpoint is only *binding* if it's below HBX's own buffer target.
   Confirm at commissioning (does lowering the HP setpoint actually lower delivered water temp?).
   The Phase-4 end-state is TempIQ owning both — the coordination requirement.
4. **Two pumps, one buffer:** v1 sends both the same target; HBX stages them. Lead/lag optimization
   is a later refinement.

## Phased rollout

- **A — shadow:** `can_write:false`; TempIQ logs would-be targets; validate a few weeks.
- **B — active, conservative:** `can_write:true`; operate in [static floor 45, cap 55]; lease loop;
  ship the §5.1 renew-without-rewrite refinement first.
- **C — unlock savings:** weather-compensated (or lowered/validated) floor → deeper mild-day setback.
