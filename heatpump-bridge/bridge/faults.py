# @purpose: Decode fault/protection bitfields (2111-2117) into plain-English alerts with
# severity. Bit->code maps transcribed from Winnie's protocol doc; message phrasing per
# handoff §5. P17 anti-freeze is INFO by design — normal NH winter behavior, must never page.
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from . import registers as R


class Severity(str, Enum):
    INFO = "info"          # normal protective behavior, never page
    WARNING = "warning"    # degraded but heating continues
    HIGH = "high"          # service needed
    CRITICAL = "critical"  # heating threatened right now


@dataclass(frozen=True)
class FaultDef:
    code: str       # raw code as shown on the wall controller (for distributor calls)
    message: str    # plain English
    severity: Severity


I, W, H, C = Severity.INFO, Severity.WARNING, Severity.HIGH, Severity.CRITICAL

# Keyed by (register, bit). "Stage 1" = System 1 (R410A), "Stage 2" = System 2 (R134a).
# The 2114/2115 pair is one 32-bit field: keyed under 2114 with bits 0-31
# (2114 assumed low word — commissioning item).
FAULTS: dict[tuple[int, int], FaultDef] = {
    # 2111 — fixed-speed system errors
    (R.REG_ERR_FIXED, 0): FaultDef("E02", "Stage 1 backup compressor discharge sensor failed — heating continues, service needed", W),
    (R.REG_ERR_FIXED, 1): FaultDef("E04", "Stage 2 backup compressor discharge sensor failed — heating continues, service needed", W),
    (R.REG_ERR_FIXED, 2): FaultDef("E06", "Stage 1 backup compressor coil sensor failed — heating continues, service needed", W),
    (R.REG_ERR_FIXED, 3): FaultDef("E08", "Stage 2 backup compressor coil sensor failed — heating continues, service needed", W),
    (R.REG_ERR_FIXED, 4): FaultDef("E10", "Stage 1 backup compressor suction sensor failed — heating continues, service needed", W),
    (R.REG_ERR_FIXED, 5): FaultDef("E12", "Stage 2 backup compressor suction sensor failed — heating continues, service needed", W),
    (R.REG_ERR_FIXED, 6): FaultDef("E39", "Internal control board communication fault (main ↔ inverter board 1) — service needed", H),
    (R.REG_ERR_FIXED, 7): FaultDef("E40", "Internal control board communication fault (main ↔ inverter board 2) — service needed", H),
    (R.REG_ERR_FIXED, 8): FaultDef("E28", "Main board memory (EEPROM) error — contact distributor", H),
    (R.REG_ERR_FIXED, 9): FaultDef("FA", "Fan motor error — service needed", H),
    (R.REG_ERR_FIXED, 10): FaultDef("E19", "Water inlet temperature sensor failed — control accuracy degraded", H),
    (R.REG_ERR_FIXED, 11): FaultDef("E18", "Water outlet temperature sensor failed — control accuracy degraded", H),
    (R.REG_ERR_FIXED, 12): FaultDef("E22", "Outdoor temperature sensor failed", W),
    (R.REG_ERR_FIXED, 13): FaultDef("E21", "Display controller lost communication with the heat pump", W),
    (R.REG_ERR_FIXED, 14): FaultDef("E23", "Unit locked by timing limit — contact distributor", H),

    # 2112 — stage 1 inverter errors
    (R.REG_ERR_INV1, 0): FaultDef("E01", "Stage 1 inverter discharge sensor failed — heating continues, service needed", W),
    (R.REG_ERR_INV1, 1): FaultDef("E05", "Stage 1 inverter outdoor coil sensor failed — heating continues, service needed", W),
    (R.REG_ERR_INV1, 2): FaultDef("E09", "Stage 1 inverter suction sensor failed — heating continues, service needed", W),
    (R.REG_ERR_INV1, 3): FaultDef("E13", "Stage 1 inverter indoor coil sensor failed — heating continues, service needed", W),
    (R.REG_ERR_INV1, 5): FaultDef("E41", "Internal communication fault (inverter board 1 ↔ driver board) — service needed", H),
    (R.REG_ERR_INV1, 6): FaultDef("E43", "Inverter board 1 memory fault — contact distributor", H),
    (R.REG_ERR_INV1, 7): FaultDef("R13", "Inverter drive 1 power module (IPM) failure — contact distributor", H),
    (R.REG_ERR_INV1, 8): FaultDef("R02", "Stage 1 inverter compressor failed to start (phase loss or reverse rotation) — service needed", H),
    (R.REG_ERR_INV1, 9): FaultDef("E43", "Inverter drive 1 memory fault — contact distributor", H),

    # 2113 — stage 2 inverter errors
    (R.REG_ERR_INV2, 0): FaultDef("E03", "Stage 2 inverter discharge sensor failed — heating continues, service needed", W),
    (R.REG_ERR_INV2, 1): FaultDef("E07", "Stage 2 inverter outdoor coil sensor failed — heating continues, service needed", W),
    (R.REG_ERR_INV2, 2): FaultDef("E11", "Stage 2 inverter suction sensor failed — heating continues, service needed", W),
    (R.REG_ERR_INV2, 3): FaultDef("E15", "Stage 2 inverter indoor coil sensor failed — heating continues, service needed", W),
    (R.REG_ERR_INV2, 5): FaultDef("E42", "Internal communication fault (inverter board 2 ↔ driver board) — service needed", H),
    (R.REG_ERR_INV2, 6): FaultDef("E44", "Inverter board 2 memory fault — contact distributor", H),
    (R.REG_ERR_INV2, 7): FaultDef("R30", "Inverter drive 2 power module (IPM) failure — contact distributor", H),
    (R.REG_ERR_INV2, 8): FaultDef("R26", "Stage 2 inverter compressor failed to start (phase loss or reverse rotation) — service needed", H),
    (R.REG_ERR_INV2, 9): FaultDef("E44", "Inverter drive 2 memory fault — contact distributor", H),

    # 2114/2115 — fixed-frequency protections (32-bit)
    (R.REG_PROT_FIXED_LO, 0): FaultDef("P01", "Low or no water flow — check circulation pump, valves, and filter", C),
    (R.REG_PROT_FIXED_LO, 1): FaultDef("P10", "Power supply problem detected (phase / AC voltage)", H),
    (R.REG_PROT_FIXED_LO, 2): FaultDef("P03", "Stage 1 backup compressor high refrigerant pressure — check water flow, dirty coil, or setpoint too high", H),
    (R.REG_PROT_FIXED_LO, 3): FaultDef("P05", "Stage 2 backup compressor high refrigerant pressure — check water flow, dirty coil, or setpoint too high", H),
    (R.REG_PROT_FIXED_LO, 4): FaultDef("P07", "Stage 1 backup compressor low refrigerant pressure — possible refrigerant leak, service needed", H),
    (R.REG_PROT_FIXED_LO, 5): FaultDef("P09", "Stage 2 backup compressor low refrigerant pressure — possible refrigerant leak, service needed", H),
    (R.REG_PROT_FIXED_LO, 6): FaultDef("P12", "Stage 1 backup compressor running too hot — check water quality and refrigerant charge", H),
    (R.REG_PROT_FIXED_LO, 7): FaultDef("P14", "Stage 2 backup compressor running too hot — check water quality and refrigerant charge", H),
    (R.REG_PROT_FIXED_LO, 8): FaultDef("P15", "Water flow too low for current output (inlet/outlet spread too large)", H),
    (R.REG_PROT_FIXED_LO, 9): FaultDef("P16", "Over-cooling protection (cooling mode)", W),
    (R.REG_PROT_FIXED_LO, 10): FaultDef("P17", "Stage 1 anti-freeze protection — NORMAL in cold weather, do not cut power", I),
    (R.REG_PROT_FIXED_LO, 11): FaultDef("P17", "Stage 2 anti-freeze protection — NORMAL in cold weather, do not cut power", I),
    (R.REG_PROT_FIXED_LO, 12): FaultDef("P18", "Backup electric heater overheat protection", H),
    (R.REG_PROT_FIXED_LO, 13): FaultDef("P20", "Stage 1 backup compressor current abnormal — service if recurring (code unverified)", H),
    (R.REG_PROT_FIXED_LO, 14): FaultDef("P22", "Stage 2 backup compressor current abnormal — service if recurring (code unverified)", H),
    (R.REG_PROT_FIXED_LO, 15): FaultDef("FAN", "Fan overload protection", H),
    (R.REG_PROT_FIXED_LO, 16): FaultDef("PC", "Outdoor temperature below operating limit (code unverified)", W),

    # 2116 — stage 1 inverter protections
    (R.REG_PROT_INV1, 0): FaultDef("P02", "Stage 1 inverter high refrigerant pressure — check water flow, dirty coil, or setpoint too high", H),
    (R.REG_PROT_INV1, 1): FaultDef("P06", "Stage 1 inverter low refrigerant pressure — possible refrigerant leak, service needed", H),
    (R.REG_PROT_INV1, 2): FaultDef("P11", "Stage 1 inverter compressor running too hot — check water quality and refrigerant charge", H),
    (R.REG_PROT_INV1, 3): FaultDef("P19", "Stage 1 inverter current abnormal — service if recurring", H),
    (R.REG_PROT_INV1, 4): FaultDef("P31", "Stage 1 inverter cooling issue: outdoor coil overheating — possible refrigerant leak", H),
    (R.REG_PROT_INV1, 5): FaultDef("P33", "Stage 1 inverter cooling issue: indoor coil overheating — possible refrigerant leak", H),
    (R.REG_PROT_INV1, 6): FaultDef("R01", "Inverter drive 1 power module over-temperature — contact distributor", H),
    (R.REG_PROT_INV1, 7): FaultDef("R06", "Stage 1 inverter compressor current protection — contact distributor", H),
    (R.REG_PROT_INV1, 8): FaultDef("R10", "Stage 1 inverter AC voltage out of range", H),
    (R.REG_PROT_INV1, 9): FaultDef("R11", "Stage 1 inverter bus voltage protection — contact distributor", H),
    (R.REG_PROT_INV1, 10): FaultDef("R20", "Stage 1 inverter compressor shell-top over-temperature — service needed", H),

    # 2117 — stage 2 inverter protections
    (R.REG_PROT_INV2, 0): FaultDef("P04", "Stage 2 inverter high refrigerant pressure — check water flow, dirty coil, or setpoint too high", H),
    (R.REG_PROT_INV2, 1): FaultDef("P08", "Stage 2 inverter low refrigerant pressure — possible refrigerant leak, service needed", H),
    (R.REG_PROT_INV2, 2): FaultDef("P13", "Stage 2 inverter compressor running too hot — check water quality and refrigerant charge", H),
    (R.REG_PROT_INV2, 3): FaultDef("P21", "Stage 2 inverter current abnormal — service if recurring", H),
    (R.REG_PROT_INV2, 4): FaultDef("P32", "Stage 2 inverter cooling issue: outdoor coil overheating — possible refrigerant leak", H),
    (R.REG_PROT_INV2, 5): FaultDef("P34", "Stage 2 inverter cooling issue: indoor coil overheating — possible refrigerant leak", H),
    (R.REG_PROT_INV2, 6): FaultDef("R25", "Inverter drive 2 power module over-temperature — contact distributor", H),
    (R.REG_PROT_INV2, 7): FaultDef("R27", "Stage 2 inverter compressor current protection — contact distributor", H),
    (R.REG_PROT_INV2, 8): FaultDef("R28", "Stage 2 inverter AC voltage out of range", H),
    (R.REG_PROT_INV2, 9): FaultDef("R29", "Stage 2 inverter bus voltage protection — contact distributor", H),
    (R.REG_PROT_INV2, 10): FaultDef("R31", "Stage 2 inverter compressor shell-top over-temperature — service needed", H),
}

# Reverse lookup: code -> list of (register, bit). Codes like P17/E43 map to several bits.
CODE_TO_BITS: dict[str, list[tuple[int, int]]] = {}
for _key, _def in FAULTS.items():
    CODE_TO_BITS.setdefault(_def.code, []).append(_key)


def fault_key(register: int, bit: int) -> str:
    """Stable identity for dedup/edge detection (codes alone aren't unique)."""
    return f"{register}.{bit}"


def decode_faults(regs: dict[int, int]) -> dict[str, FaultDef]:
    """Given {address: raw} for the fault registers, return {fault_key: FaultDef}
    for every bit currently set. 2114+2115 are combined into one 32-bit field."""
    active: dict[str, FaultDef] = {}
    combined = {
        R.REG_ERR_FIXED: regs.get(R.REG_ERR_FIXED, 0),
        R.REG_ERR_INV1: regs.get(R.REG_ERR_INV1, 0),
        R.REG_ERR_INV2: regs.get(R.REG_ERR_INV2, 0),
        R.REG_PROT_FIXED_LO: regs.get(R.REG_PROT_FIXED_LO, 0) | (regs.get(R.REG_PROT_FIXED_HI, 0) << 16),
        R.REG_PROT_INV1: regs.get(R.REG_PROT_INV1, 0),
        R.REG_PROT_INV2: regs.get(R.REG_PROT_INV2, 0),
    }
    for (register, bit), fdef in FAULTS.items():
        if combined.get(register, 0) >> bit & 1:
            active[fault_key(register, bit)] = fdef
    return active


def worst_severity(faults: dict[str, FaultDef]) -> Severity | None:
    order = [Severity.CRITICAL, Severity.HIGH, Severity.WARNING, Severity.INFO]
    for sev in order:
        if any(f.severity == sev for f in faults.values()):
            return sev
    return None
