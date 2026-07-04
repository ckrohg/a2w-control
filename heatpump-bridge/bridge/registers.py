# @purpose: Single source of truth for the MAHRW030ZA Modbus register map — addresses,
# batched read blocks, scaling, and snapshot decoding. Derived from Winnie's protocol doc
# (knowledge/reference/modbus-register-map.md). Scaling factors are Phase 1 commissioning
# items; change them HERE only.
from __future__ import annotations

from dataclasses import dataclass

# --- Writable registers -------------------------------------------------------------
REG_ON_OFF = 2000          # 0/1
REG_MODE = 2001            # 0 cooling, 1 floor heating; modes 2-5 unstable, never write
REG_SETPOINT_HEATING = 2003  # primary write target; bounds 20..value(REG_MAX_WATER_TEMP)
REG_MAX_WATER_TEMP = 2027  # upper bound for setpoint, factory default 55

# --- Read-only telemetry ------------------------------------------------------------
REG_INLET_TEMP = 2050
REG_OUTLET_TEMP = 2051
REG_AMBIENT_TEMP = 2052
REG_SYS1_DISCHARGE = 2055
REG_SYS1_CURRENT = 2058    # A
REG_SYS1_BUS_VOLTAGE = 2061  # actual = raw * 10
REG_SYS1_POWER = 2063      # units unconfirmed — commissioning item
REG_SYS1_FREQ = 2068
REG_FIXED1_CURRENT = 2074  # A, stage 1 fixed-speed compressor
REG_AC_VOLTAGE = 2077      # fixed-speed board AC input voltage
REG_SYS2_CURRENT = 2083
REG_SYS2_POWER = 2088      # units unconfirmed — commissioning item
REG_SYS2_FREQ = 2093
REG_FIXED2_CURRENT = 2099

# --- Status / fault bitfields -------------------------------------------------------
REG_STATUS = 2110
REG_ERR_FIXED = 2111
REG_ERR_INV1 = 2112
REG_ERR_INV2 = 2113
REG_PROT_FIXED_LO = 2114   # 32-bit field spans 2114 (assumed low word) + 2115
REG_PROT_FIXED_HI = 2115   # word order is a commissioning item
REG_PROT_INV1 = 2116
REG_PROT_INV2 = 2117
REG_SWITCH_STATUS = 2118

FAULT_REGISTERS = (REG_ERR_FIXED, REG_ERR_INV1, REG_ERR_INV2,
                   REG_PROT_FIXED_LO, REG_PROT_FIXED_HI, REG_PROT_INV1, REG_PROT_INV2)

# --- Batched read blocks (2400 baud: batch reads, never register-by-register) --------
@dataclass(frozen=True)
class ReadBlock:
    start: int
    count: int

BLOCK_CONTROL = ReadBlock(2000, 6)      # on/off, mode, setpoints, emergency
BLOCK_TELEMETRY = ReadBlock(2050, 51)   # temps + per-stage telemetry through 2100
BLOCK_STATUS = ReadBlock(2110, 9)       # status word + all fault bitfields + switches
ALL_BLOCKS = (BLOCK_CONTROL, BLOCK_TELEMETRY, BLOCK_STATUS)

# --- Scaling (commissioning items — verify against wall controller / clamp meter) ----
TEMP_SCALE = 1.0    # doc quotes whole degC ranges; Macon boards sometimes use x0.1
POWER_SCALE = 1.0   # units of 2063/2088 unconfirmed
CURRENT_SCALE = 1.0


def to_signed(raw: int) -> int:
    """Registers are 16-bit; temps can be negative (NH winter)."""
    return raw - 0x10000 if raw > 0x7FFF else raw


def block_dict(block: ReadBlock, values: list[int]) -> dict[int, int]:
    """Map a block read result to {address: raw_value}."""
    return {block.start + i: v for i, v in enumerate(values)}


# Status word (2110) bit names
STATUS_BITS = {
    0: "wall_controller_on",
    1: "compressor1",
    2: "compressor2",
    3: "fan_high",
    4: "fan_medium",
    5: "fan_low",
    6: "water_pump",
    7: "four_way_valve1",
    8: "four_way_valve2",
    9: "crankcase_heater1",
    10: "crankcase_heater2",
    11: "electric_heating",
    12: "chassis_heating",
}

# Switch status word (2118) bit names (raw hardware switch states, not faults)
SWITCH_BITS = {
    0: "sys1_high_pressure_switch",
    1: "sys1_low_pressure_switch",
    2: "sys2_high_pressure_switch",
    3: "sys2_low_pressure_switch",
    4: "ac_online",
    5: "water_flow_switch",
    6: "emergency_switch",
    7: "electric_heat_overheat_switch",
}


def decode_status_word(raw: int) -> dict[str, bool]:
    return {name: bool(raw >> bit & 1) for bit, name in STATUS_BITS.items()}


def decode_switch_word(raw: int) -> dict[str, bool]:
    return {name: bool(raw >> bit & 1) for bit, name in SWITCH_BITS.items()}


def decode_snapshot(regs: dict[int, int]) -> dict:
    """Decode a full poll (all three blocks merged into one addr->raw dict) into
    engineering values. Fault decoding lives in faults.py."""
    status = decode_status_word(regs.get(REG_STATUS, 0))
    return {
        "on": bool(regs.get(REG_ON_OFF, 0)),
        "mode": regs.get(REG_MODE),
        "setpoint_c": to_signed(regs.get(REG_SETPOINT_HEATING, 0)) * TEMP_SCALE,
        "max_water_temp_c": None,  # reg 2027 is outside read blocks; read on demand
        "inlet_c": to_signed(regs.get(REG_INLET_TEMP, 0)) * TEMP_SCALE,
        "outlet_c": to_signed(regs.get(REG_OUTLET_TEMP, 0)) * TEMP_SCALE,
        "ambient_c": to_signed(regs.get(REG_AMBIENT_TEMP, 0)) * TEMP_SCALE,
        "power_sys1": regs.get(REG_SYS1_POWER, 0) * POWER_SCALE,
        "power_sys2": regs.get(REG_SYS2_POWER, 0) * POWER_SCALE,
        "current_sys1_a": regs.get(REG_SYS1_CURRENT, 0) * CURRENT_SCALE,
        "current_sys2_a": regs.get(REG_SYS2_CURRENT, 0) * CURRENT_SCALE,
        "current_fixed1_a": regs.get(REG_FIXED1_CURRENT, 0) * CURRENT_SCALE,
        "current_fixed2_a": regs.get(REG_FIXED2_CURRENT, 0) * CURRENT_SCALE,
        "freq_sys1_hz": regs.get(REG_SYS1_FREQ, 0),
        "freq_sys2_hz": regs.get(REG_SYS2_FREQ, 0),
        "status": status,
        "switches": decode_switch_word(regs.get(REG_SWITCH_STATUS, 0)),
        "heating": status["compressor1"] or status["compressor2"],
    }
