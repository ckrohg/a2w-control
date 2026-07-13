# @purpose: Single source of truth for the MAHRW030ZA Modbus register map — addresses,
# batched read blocks, scaling, and snapshot decoding. Derived from Winnie's protocol doc
# (knowledge/reference/modbus-register-map.md). Scaling factors are Phase 1 commissioning
# items; change them HERE only.
from __future__ import annotations

from dataclasses import dataclass

# --- Writable registers -------------------------------------------------------------
REG_ON_OFF = 2000          # 0/1
REG_MODE = 2001            # 0 cooling, 1 floor heating; modes 2-5 unstable, never write
REG_SETPOINT_COOLING = 2002  # cooling target; doc bounds 10..25
REG_SETPOINT_HEATING = 2003  # heating target; bounds 20..value(REG_MAX_WATER_TEMP)
REG_SETPOINT_HOT_WATER = 2004  # hot water target; bounds 20..value(REG_MAX_WATER_TEMP)
REG_EMERGENCY = 2005       # 0 follow hardware input, 1 force on, 2 force off
REG_MAX_WATER_TEMP = 2027  # unit's own max water temp (wall param 17), factory default 55

# Wire-controller parameters (installer settings) + the emergency override.
# (address, key, label, min, max) — min/max are the protocol doc's own ranges and are
# enforced on writes. Labels carry the units; these values stay degC in the UI.
PARAM_DEFS = (
    (2005, "emergency_switch", "Emergency switch (0 auto, 1 force on, 2 force off)", 0, 2),
    (2010, "heating_start_diff", "Heating restart differential °C", 2, 18),
    (2011, "cooling_start_diff", "Cooling restart differential °C", 2, 18),
    (2012, "pump_mode", "Water pump mode (0-2)", 0, 2),
    (2013, "pump_interval_min", "Pump switching interval min", 2, 20),
    (2014, "defrost_interval_min", "Compressor runtime before defrost min", 20, 90),
    (2015, "defrost_enter_coil_c", "Coil temp to enter defrost °C", -15, -1),
    (2016, "defrost_max_min", "Max defrost time min", 5, 20),
    (2017, "defrost_exit_coil_c", "Coil temp to exit defrost °C", 1, 40),
    (2018, "defrost_ext_ambient_c", "Ambient for extended defrost cycle °C", -30, 5),
    (2019, "defrost_ext_interval_min", "Extended defrost cycle min", 20, 90),
    (2020, "defrost_lengthen_dt", "Ambient-coil ΔT to lengthen defrost °C", 0, 30),
    (2021, "ambient_min_protect_c", "Low-ambient protection °C", -41, 0),
    (2022, "cooling_low_ambient_c", "Cooling low-ambient protection °C", -1, 20),
    (2023, "eev_cycle_s", "EEV operation cycle s", 20, 90),
    (2024, "fixed_superheat_c", "Fixed-comp target superheat °C", -10, 15),
    (2025, "fixed_eev_auto", "Fixed EEV auto (1) / manual (0)", 0, 1),
    (2026, "fixed_eev_steps", "Fixed EEV manual steps", 0, 480),
    (2027, "max_water_temp_c", "Max water temp (param 17) °C", 20, 90),
    (2028, "cooling_min_water_c", "Cooling min water temp °C", 3, 15),
    (2029, "electric_heater", "Electric heater installed", 0, 1),
    (2030, "heater_ambient_c", "Electric heater enable ambient °C", -41, 45),
    (2031, "heater_delay_min", "Electric heater start delay min", 0, 60),
    (2032, "fixed_current_max_a", "Fixed-comp current protection A", 0, 50),
    (2033, "reduce_frequency", "Reduce working frequency", 0, 1),
    (2034, "inverter_superheat_c", "Inverter EEV target superheat °C", -10, 15),
    (2035, "control_scheme", "Scheme (0 fast heat, 1 energy save)", 0, 1),
    (2036, "module_cycle", "Module adjustment cycle", 5, 240),
    (2037, "pump_purge", "Forced pump emptying", 0, 1),
    (2038, "low_temp_pump_ambient_c", "Low-temp forced pump ambient °C", -25, 5),
    (2039, "timing_lock", "Timing limit lock", 0, 99),
)
PARAM_BY_KEY = {key: (addr, label, lo, hi) for addr, key, label, lo, hi in PARAM_DEFS}

# Mode register values -> names, and which setpoint register each mode follows.
MODE_NAMES = {0: "cooling", 1: "floor_heating", 2: "fan_coil_heating",
              3: "curve_heating", 4: "time_division_heating", 5: "hot_water"}
MODE_KIND = {0: "cooling", 1: "heating", 2: "heating", 3: "heating", 4: "heating",
             5: "hot_water"}
SETPOINT_REGISTER_FOR_KIND = {"cooling": REG_SETPOINT_COOLING,
                              "heating": REG_SETPOINT_HEATING,
                              "hot_water": REG_SETPOINT_HOT_WATER}

# Layered setpoint ceiling. The installation manual's spec table (p.3) states
# "Maximum water outlet temperature: 85degC" and rates the unit at 75degC outlet down to
# -12degC ambient — HARD_MAX is that hardware limit; config defaults to the 75degC rated
# point. Effective runtime max is still min(config, live reg 2027), and reg 2027 ships
# at a factory default of 55 — it must be raised on the unit to actually go higher.
HARD_MIN_SETPOINT_C = 20.0   # register floor for heating setpoint per protocol doc
HARD_MAX_SETPOINT_C = 85.0   # manual: maximum water outlet temperature
COOLING_REGISTER_RANGE = (10.0, 25.0)  # protocol doc bounds for reg 2002

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

BLOCK_CONTROL = ReadBlock(2000, 40)     # on/off, mode, setpoints, wire params incl 2027
BLOCK_TELEMETRY = ReadBlock(2050, 51)   # temps + per-stage telemetry through 2100
BLOCK_STATUS = ReadBlock(2110, 9)       # status word + all fault bitfields + switches

# BENCH FALLBACK: BLOCK_CONTROL spans the doc's reserved hole 2006-2009. The sim serves it
# happily, but a strictly spec-compliant pump may NAK any read touching unimplemented
# addresses (symptom: exception_responses climbing + pump never online, while a one-off
# read of 2050-2052 works). If unit #1 does that, flip this to True — the poll AND write
# paths both follow it (they call control_blocks()/all_blocks(), evaluated per call).
# Costs one extra transaction (~0.5 s at 2400 baud), well within the poll budget.
SPLIT_RESERVED_HOLE = False
_BLOCK_CONTROL_A = ReadBlock(2000, 6)    # 2000-2005: on/off, mode, setpoints
_BLOCK_CONTROL_B = ReadBlock(2010, 30)   # 2010-2039: wire-controller params incl 2027


def control_blocks() -> tuple[ReadBlock, ...]:
    """The control-register read(s) — one spanning block, or two skipping the hole."""
    if SPLIT_RESERVED_HOLE:
        return (_BLOCK_CONTROL_A, _BLOCK_CONTROL_B)
    return (BLOCK_CONTROL,)


def all_blocks() -> tuple[ReadBlock, ...]:
    return (*control_blocks(), BLOCK_TELEMETRY, BLOCK_STATUS)


ALL_BLOCKS = all_blocks()  # snapshot at import for callers that don't need the live flag

# --- Scaling (commissioning items — verify against wall controller / clamp meter) ----
TEMP_SCALE = 1.0    # doc quotes whole degC ranges; Macon boards sometimes use x0.1
POWER_SCALE = 1.0   # units of 2063/2088 unconfirmed
CURRENT_SCALE = 1.0


def to_signed(raw: int) -> int:
    """Registers are 16-bit; temps can be negative (NH winter)."""
    return raw - 0x10000 if raw > 0x7FFF else raw


BOOT_SENTINEL_C = -39  # sensor-init sentinel observed on real hardware


def is_boot_frame(regs: dict[int, int]) -> bool:
    """True when the core temps carry the power-on boot signature seen on the real
    MAHRW030ZA (HP1 commissioning, 2026-07-13): for the first couple of polls after
    the pump powers on, inlet/outlet/ambient all read 0, then all read -39 (sensor
    init), before real values appear. Such frames are valid Modbus but garbage data —
    the poller stores nothing and emits nothing for them. All-three-equal at exactly
    0 or -39 is physically implausible as real data, so a false positive costs at
    most one skipped sample."""
    vals = [to_signed(regs[a]) for a in
            (REG_INLET_TEMP, REG_OUTLET_TEMP, REG_AMBIENT_TEMP) if a in regs]
    return len(vals) == 3 and vals[0] == vals[1] == vals[2] and vals[0] in (0, BOOT_SENTINEL_C)


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
    mode = regs.get(REG_MODE, 1)
    kind = MODE_KIND.get(mode, "unknown")
    setpoints = {
        "cooling": to_signed(regs.get(REG_SETPOINT_COOLING, 0)) * TEMP_SCALE,
        "heating": to_signed(regs.get(REG_SETPOINT_HEATING, 0)) * TEMP_SCALE,
        "hot_water": to_signed(regs.get(REG_SETPOINT_HOT_WATER, 0)) * TEMP_SCALE,
    }
    return {
        "on": bool(regs.get(REG_ON_OFF, 0)),
        "mode": mode,
        "mode_name": MODE_NAMES.get(mode, f"unknown({mode})"),
        "mode_kind": kind,
        "emergency_override": {0: "auto", 1: "forced_on", 2: "forced_off"}.get(
            regs.get(REG_EMERGENCY, 0), "unknown"),
        "parameters": [
            {"key": key, "label": label, "value": to_signed(regs[addr]),
             "min": lo, "max": hi}
            for addr, key, label, lo, hi in PARAM_DEFS if addr in regs
        ],
        # "setpoint_c" is always the ACTIVE mode's target (history stays meaningful
        # across mode changes); per-mode values are alongside.
        "setpoint_c": setpoints.get(kind, setpoints["heating"]),
        "setpoint_heating_c": setpoints["heating"],
        "setpoint_cooling_c": setpoints["cooling"],
        "setpoint_hot_water_c": setpoints["hot_water"],
        "max_water_temp_c": to_signed(regs[REG_MAX_WATER_TEMP]) * TEMP_SCALE
                            if REG_MAX_WATER_TEMP in regs else None,
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
        # "heating" kept for the samples table: it means "compressors running"
        "heating": status["compressor1"] or status["compressor2"],
        "running": status["compressor1"] or status["compressor2"],
        # In heating, the four-way valve reversing while running = defrost cycle.
        # (In cooling the valve is held over constantly, so it's not a defrost sign.)
        # Heuristic per refrigeration circuit convention — verify during Phase 1.
        "defrosting": (kind == "heating"
                       and (status["four_way_valve1"] or status["four_way_valve2"])),
        "fan_speed": ("high" if status["fan_high"] else
                      "medium" if status["fan_medium"] else
                      "low" if status["fan_low"] else "off"),
        "details": _decode_details(regs),
    }


def _sig(regs: dict[int, int], addr: int) -> int | None:
    return to_signed(regs[addr]) if addr in regs else None


def _decode_details(regs: dict[int, int]) -> dict:
    """Everything the wall controller can show, per stage: refrigerant temps, compressor
    frequency/current, EEV openings, pressures, voltages. Raw pressure/power units are
    commissioning items — displayed as reported."""
    t = lambda a: (None if _sig(regs, a) is None else _sig(regs, a) * TEMP_SCALE)  # noqa: E731
    return {
        "stage1_inverter": {
            "discharge_c": t(2055), "coil_c": t(2056), "suction_c": t(2057),
            "current_a": _sig(regs, 2058), "eev_steps": (regs.get(2059, 0) * 2) or None,
            "aux_eev_steps": _sig(regs, 2053),
            "cooling_coil_c": t(2060),
            "bus_voltage_v": (regs.get(2061, 0) * 10) or None,
            "ipm_temp_c": t(2062), "power": _sig(regs, 2063),
            "fan_rpm": _sig(regs, 2064), "high_pressure": _sig(regs, 2065),
            "low_pressure": _sig(regs, 2066), "ac_voltage_v": _sig(regs, 2067),
            "compressor_hz": _sig(regs, 2068),
            "ee_code": (regs.get(2069, 0) << 16 | regs.get(2070, 0)) or None,
        },
        "stage1_fixed": {
            "discharge_c": t(2071), "coil_c": t(2072), "suction_c": t(2073),
            "current_a": _sig(regs, 2074), "eev_steps": (regs.get(2075, 0) * 2) or None,
        },
        "stage2_inverter": {
            "discharge_c": t(2080), "coil_c": t(2081), "suction_c": t(2082),
            "current_a": _sig(regs, 2083), "eev_steps": (regs.get(2084, 0) * 2) or None,
            "aux_eev_steps": _sig(regs, 2054),
            "cooling_coil_c": t(2085),
            "bus_voltage_v": (regs.get(2086, 0) * 10) or None,
            "ipm_temp_c": t(2087), "power": _sig(regs, 2088),
            "fan_rpm": _sig(regs, 2089), "high_pressure": _sig(regs, 2090),
            "low_pressure": _sig(regs, 2091), "compressor_hz": _sig(regs, 2093),
            # doc says 2092 "AC current input" but the sys1 twin (2067) is AC voltage —
            # ambiguous, exposed raw; label carries the caveat. Commissioning item.
            "ac_input_raw": _sig(regs, 2092),
            "ee_code": (regs.get(2094, 0) << 16 | regs.get(2095, 0)) or None,
        },
        "stage2_fixed": {
            "discharge_c": t(2096), "coil_c": t(2097), "suction_c": t(2098),
            "current_a": _sig(regs, 2099), "eev_steps": (regs.get(2100, 0) * 2) or None,
        },
        "shared": {
            "fixed_fan_rpm": _sig(regs, 2076), "ac_voltage_v": _sig(regs, 2077),
            "fixed_ee_code": (regs.get(2078, 0) << 16 | regs.get(2079, 0)) or None,
        },
    }
