# @purpose: The ONE definition of a pump's "power_w" on every surface (hub state frame, analytics mirror,
# local API/UI): the watts the pump's SPAN circuit is drawing right now — the whole unit, metered at the panel.
#
# Why not the pump's own registers. 2063/2088 are the two INVERTER stages only, in an unconfirmed unit, and
# exclude the fixed-speed compressors, fans and circulator. Published as "power_w" they read 0-35 while the
# circuit drew 1-6.5 kW: over 2026-10-12..11-16, 5,987 pump-minutes above 1 kW at the panel, not one register
# reading above 35 (correlation 0.98, ~200 W per count at full load — a real signal, the wrong quantity).
# Every consumer took the field for watts (6bb's Heating card, both dashboards, the mirror's history).
#
# So: power_w = |SPAN circuit instantPowerW| for the pump's circuit (self_heal.circuits), or None when there is
# no fresh panel reading. Never a guess and never the register: an unknown draw is None, not 0 and not 23.
# The register sum still travels, under a name that says what it is: inverter_power_raw.
# Read-only and out of the control loop: nothing here writes, and no control decision reads these fields
# (self_heal / backup_fallback / pumphealth read the SPAN circuit directly, as before).
from __future__ import annotations

import time

# The SPAN poll lands every ~25 s; older than this the reading is not "now".
MAX_AGE_S = 120.0


def inverter_power_raw(snapshot: dict) -> float:
    """Registers 2063 + 2088 as read (inverter stages only; unit unconfirmed — NOT watts)."""
    return (snapshot.get("power_sys1") or 0) + (snapshot.get("power_sys2") or 0)


class PumpPower:
    """Metered draw per pump from the SPAN poller's cache. Construct once in main.py and hand to every publisher."""

    def __init__(self, span_poller, circuits: dict[str, str], *, max_age_s: float = MAX_AGE_S,
                 monotonic=time.monotonic):
        self.span_poller = span_poller
        self.circuits = dict(circuits or {})
        self.max_age_s = max_age_s
        self._monotonic = monotonic

    def watts(self, pump_id: str) -> float | None:
        """|instantPowerW| of the pump's circuit, or None: no circuit mapped, the circuit is not in the last read,
        the panel gave no power for it, or the last read is older than max_age_s. Never raises."""
        try:
            name = self.circuits.get(pump_id)
            poller = self.span_poller
            if not name or poller is None:
                return None
            mono = getattr(poller, "latest_circuits_mono", None)
            if mono is None or self._monotonic() - mono > self.max_age_s:
                return None
            c = (getattr(poller, "latest_circuits", None) or {}).get(name)
            w = c.get("power_w") if c else None
            if isinstance(w, bool) or not isinstance(w, (int, float)) or w != w:  # None / junk / NaN
                return None
            return abs(float(w))   # this panel reports consumption NEGATIVE (#202); a draw is its magnitude
        except Exception:  # noqa: BLE001 — a telemetry field must never cost a state frame
            return None

    def fields(self, pump_id: str, snapshot: dict) -> dict:
        """The three keys every publisher carries for one pump."""
        w = self.watts(pump_id)
        return {"power_w": w, "power_source": "span" if w is not None else None,
                "inverter_power_raw": inverter_power_raw(snapshot)}


def power_fields(pump_power: "PumpPower | None", pump_id: str, snapshot: dict) -> dict:
    """fields() when a PumpPower is wired; without one (SPAN not configured, or a test rig) power_w is None."""
    if pump_power is not None:
        return pump_power.fields(pump_id, snapshot)
    return {"power_w": None, "power_source": None, "inverter_power_raw": inverter_power_raw(snapshot)}
