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
    required = {R.REG_SETPOINT_HEATING, R.REG_INLET_TEMP, R.REG_OUTLET_TEMP,
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
