# @purpose: Verify the write guardrails: clamp with explicit rejection, rate limit with
# injectable clock, offline refusal, and the write_enabled flag.
import pytest

from bridge.config import GuardrailConfig
from bridge.guardrails import GuardrailError, SetpointGuard


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture
def guard():
    cfg = GuardrailConfig(setpoint_min_c=30, setpoint_max_c=55, min_write_interval_s=60)
    clock = FakeClock()
    g = SetpointGuard(cfg, clock=clock)
    g.clock = clock  # test handle
    return g


def ok(guard, value, pump="p1"):
    guard.validate(pump, value, online=True, write_enabled=True)


def test_accepts_in_range(guard):
    ok(guard, 30)
    ok(guard, 45)
    ok(guard, 55)


def test_rejects_out_of_range_with_422(guard):
    for bad in (29.9, 55.1, 85, -5):
        with pytest.raises(GuardrailError) as exc:
            ok(guard, bad)
        assert exc.value.status_code == 422


def test_rejects_when_write_disabled(guard):
    with pytest.raises(GuardrailError) as exc:
        guard.validate("p1", 45, online=True, write_enabled=False)
    assert exc.value.status_code == 403


def test_rejects_when_offline_never_queues(guard):
    with pytest.raises(GuardrailError) as exc:
        guard.validate("p1", 45, online=False, write_enabled=True)
    assert exc.value.status_code == 503


def test_rate_limit_and_recovery(guard):
    ok(guard, 45)
    guard.record_write("p1")
    with pytest.raises(GuardrailError) as exc:
        ok(guard, 46)
    assert exc.value.status_code == 429
    guard.clock.t += 61
    ok(guard, 46)  # allowed again


def test_rate_limit_is_per_pump(guard):
    guard.record_write("p1")
    ok(guard, 45, pump="p2")  # p2 unaffected by p1's write


def test_explicit_bounds_override_defaults(guard):
    # cooling-style bounds: 45 is valid for heating but not within 12-25
    with pytest.raises(GuardrailError) as exc:
        guard.validate("p1", 45, online=True, write_enabled=True,
                       min_c=12, max_c=25, context="cooling mode")
    assert exc.value.status_code == 422
    assert "cooling mode" in str(exc.value)
    guard.validate("p1", 20, online=True, write_enabled=True, min_c=12, max_c=25)


def test_config_rejects_max_above_hard_ceiling():
    with pytest.raises(ValueError):
        GuardrailConfig(setpoint_max_c=90)   # hard ceiling = 85 (manual max outlet)
    with pytest.raises(ValueError):
        GuardrailConfig(setpoint_min_c=10)   # register floor is 20
    with pytest.raises(ValueError):
        GuardrailConfig(cooling_setpoint_max_c=30)  # register cap is 25
    GuardrailConfig(setpoint_max_c=85)       # at the hardware ceiling is allowed
    assert GuardrailConfig().setpoint_max_c == 75  # default = manual's rated point
