# @purpose: Verify fault bitfield decode logic — bit-to-code mapping, P17 severity rule,
# 32-bit 2114/2115 combination, and key uniqueness for dedup.
from bridge import registers as R
from bridge.faults import FAULTS, Severity, decode_faults, fault_key, worst_severity


def test_no_faults_decodes_empty():
    assert decode_faults({}) == {}
    assert decode_faults({R.REG_ERR_FIXED: 0, R.REG_PROT_FIXED_LO: 0}) == {}


def test_p01_water_flow_is_critical():
    active = decode_faults({R.REG_PROT_FIXED_LO: 1})  # bit 0
    assert len(active) == 1
    fault = next(iter(active.values()))
    assert fault.code == "P01"
    assert fault.severity == Severity.CRITICAL


def test_p17_antifreeze_is_info_never_pages():
    # both stage bits (10 and 11) must be INFO — this is the "never page" rule
    active = decode_faults({R.REG_PROT_FIXED_LO: (1 << 10) | (1 << 11)})
    assert len(active) == 2
    assert all(f.code == "P17" and f.severity == Severity.INFO for f in active.values())


def test_32bit_field_spans_2114_and_2115():
    # bit 16 (PC, low-ambient) lives in the high word = 2115 bit 0
    active = decode_faults({R.REG_PROT_FIXED_HI: 1})
    codes = [f.code for f in active.values()]
    assert codes == ["PC"]


def test_sensor_fault_bit_mapping():
    # 2111 bit 11 = E18 outlet sensor, bit 10 = E19 inlet sensor
    active = decode_faults({R.REG_ERR_FIXED: (1 << 10) | (1 << 11)})
    codes = {f.code for f in active.values()}
    assert codes == {"E18", "E19"}


def test_inverter_error_registers_are_distinct():
    a1 = decode_faults({R.REG_ERR_INV1: 1})
    a2 = decode_faults({R.REG_ERR_INV2: 1})
    assert next(iter(a1.values())).code == "E01"
    assert next(iter(a2.values())).code == "E03"


def test_fault_keys_are_unique_even_when_codes_repeat():
    # E43 appears twice in 2112 (bits 6 and 9); keys must differ
    active = decode_faults({R.REG_ERR_INV1: (1 << 6) | (1 << 9)})
    assert len(active) == 2
    assert len(set(active.keys())) == 2


def test_worst_severity_ordering():
    p17 = decode_faults({R.REG_PROT_FIXED_LO: 1 << 10})
    assert worst_severity(p17) == Severity.INFO
    mixed = decode_faults({R.REG_PROT_FIXED_LO: (1 << 10) | 1})  # P17 + P01
    assert worst_severity(mixed) == Severity.CRITICAL
    assert worst_severity({}) is None


def test_every_fault_def_is_complete():
    for (reg, bit), fdef in FAULTS.items():
        assert fdef.code and fdef.message and fdef.severity
        assert reg in R.FAULT_REGISTERS
        assert 0 <= bit <= (31 if reg == R.REG_PROT_FIXED_LO else 15)
        assert fault_key(reg, bit) == f"{reg}.{bit}"
