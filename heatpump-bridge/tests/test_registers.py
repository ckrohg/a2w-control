# @purpose: Verify register decode helpers: signed temps (NH winter!), block mapping,
# status word bits, and snapshot assembly.
from bridge import registers as R


def test_signed_decode():
    assert R.to_signed(45) == 45
    assert R.to_signed(0) == 0
    assert R.to_signed(0xFFFF) == -1
    assert R.to_signed(65496) == -40  # coldest spec ambient


def test_block_dict_maps_addresses():
    d = R.block_dict(R.BLOCK_STATUS, list(range(9)))
    assert d[R.REG_STATUS] == 0
    assert d[R.REG_SWITCH_STATUS] == 8


def test_blocks_cover_required_registers():
    covered = set()
    for b in R.ALL_BLOCKS:
        covered.update(range(b.start, b.start + b.count))
    required = {R.REG_MODE, R.REG_SETPOINT_COOLING, R.REG_SETPOINT_HEATING,
                R.REG_SETPOINT_HOT_WATER, R.REG_MAX_WATER_TEMP,
                R.REG_INLET_TEMP, R.REG_OUTLET_TEMP,
                R.REG_AMBIENT_TEMP, R.REG_SYS1_POWER, R.REG_SYS2_POWER,
                *R.FAULT_REGISTERS, R.REG_STATUS, R.REG_SWITCH_STATUS}
    assert required <= covered


def test_status_word_decode():
    status = R.decode_status_word((1 << 1) | (1 << 6))
    assert status["compressor1"] is True
    assert status["water_pump"] is True
    assert status["compressor2"] is False


def test_snapshot_negative_ambient_and_heating():
    regs = {
        R.REG_ON_OFF: 1,
        R.REG_MODE: 1,
        R.REG_SETPOINT_HEATING: 45,
        R.REG_INLET_TEMP: 40,
        R.REG_OUTLET_TEMP: 46,
        R.REG_AMBIENT_TEMP: 65516,  # -20degC
        R.REG_SYS1_POWER: 2600,
        R.REG_SYS2_POWER: 0,
        R.REG_STATUS: 1 << 1,
    }
    snap = R.decode_snapshot(regs)
    assert snap["ambient_c"] == -20
    assert snap["setpoint_c"] == 45
    assert snap["heating"] is True
    assert snap["power_sys1"] == 2600
    assert snap["mode_kind"] == "heating"
    assert snap["defrosting"] is False


def test_snapshot_mode_selects_active_setpoint():
    base = {R.REG_SETPOINT_COOLING: 16, R.REG_SETPOINT_HEATING: 45,
            R.REG_SETPOINT_HOT_WATER: 50, R.REG_MAX_WATER_TEMP: 55}
    heat = R.decode_snapshot(base | {R.REG_MODE: 1})
    cool = R.decode_snapshot(base | {R.REG_MODE: 0})
    hw = R.decode_snapshot(base | {R.REG_MODE: 5})
    assert heat["setpoint_c"] == 45 and heat["mode_kind"] == "heating"
    assert cool["setpoint_c"] == 16 and cool["mode_kind"] == "cooling"
    assert hw["setpoint_c"] == 50 and hw["mode_kind"] == "hot_water"
    assert heat["max_water_temp_c"] == 55


def test_defrost_heuristic():
    # heating + running + four-way valve = defrost; in cooling the valve is normal
    heating_defrost = R.decode_snapshot(
        {R.REG_MODE: 1, R.REG_STATUS: (1 << 1) | (1 << 7)})
    cooling_normal = R.decode_snapshot(
        {R.REG_MODE: 0, R.REG_STATUS: (1 << 1) | (1 << 7)})
    assert heating_defrost["defrosting"] is True
    assert cooling_normal["defrosting"] is False


def test_details_decode():
    snap = R.decode_snapshot({R.REG_MODE: 1, 2055: 78, 2059: 210, 2061: 38, 2068: 65})
    d = snap["details"]["stage1_inverter"]
    assert d["discharge_c"] == 78
    assert d["eev_steps"] == 420       # x2 scaling
    assert d["bus_voltage_v"] == 380   # x10 scaling
    assert d["compressor_hz"] == 65
