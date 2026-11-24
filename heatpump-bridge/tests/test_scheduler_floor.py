# @purpose: Scheduler timers vs the unattended setpoint floor. A setback/comfort below
# unattended_min_setpoint_c is REFUSED by write_setpoint on every fire (audited, logged) — never
# clamped up (owner audit 2026-11-23: this is heat-pump safety behaviour). What makes it visible
# is guardrail_warnings() at boot, which reports the contradiction without failing config load.
# A fractional floor (45.5) is compared rounded UP to the whole degree (46), never the timer.
from __future__ import annotations

import logging
import pathlib
import socket
from datetime import datetime

import pytest
import yaml

from bridge import registers as R
from bridge.config import AppConfig, GuardrailConfig, PumpConfig, guardrail_warnings
from bridge.guardrails import SetpointGuard
from bridge.main import create_app
from bridge.poller import PumpPoller
from bridge.scheduler import Scheduler
from bridge.store import Store
from sim.fake_pump import FakePump

BOOT_SETPOINT_C = 45   # sim/fake_pump.py boots in heating at 45°C


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
async def rig(tmp_path):
    """Same rig as test_integration: a running fake pump + store + poller (no loop)."""
    port = free_port()
    pump = FakePump(1, port)
    await pump.start()
    await pump.tick()

    cfg = AppConfig(
        pumps=[PumpConfig(id="p1", name="Pump 1", host="127.0.0.1", port=port,
                          poll_interval_s=1, write_enabled=True)],
        guardrails=GuardrailConfig(min_write_interval_s=0.1),
        db_path=str(tmp_path / "test.db"),
    )
    store = Store(cfg.db_path)
    await store.open()
    poller = PumpPoller(cfg.pumps[0], cfg, store, SetpointGuard(cfg.guardrails))
    await poller.poll_once()
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == BOOT_SETPOINT_C

    yield pump, poller, store

    poller.client.close()
    await pump.server.shutdown()
    await store.close()


async def _fire(store, poller, action: str, hhmm: str = "23:00"):
    # store.add_schedule takes no `now` on this branch; when #315 lands, pass now=datetime(2026, 11, 4, h, m)
    await store.add_schedule("p1", hhmm, action)
    h, m = map(int, hhmm.split(":"))
    await Scheduler(store, {"p1": poller}).check_once(datetime(2026, 11, 4, h, m, 5))


async def _rejected(store) -> list[dict]:
    return [e for e in await store.get_events("p1", 1)
            if e["type"] == "setpoint_write" and e["code"] == "rejected"]


async def test_setback_below_floor_is_refused_not_clamped(rig, caplog):
    pump, poller, store = rig
    g = poller.app_cfg.guardrails
    g.setback_setpoint_c = 40
    g.unattended_min_setpoint_c = 46

    with caplog.at_level(logging.WARNING, logger="bridge.scheduler"):
        await _fire(store, poller, "off")

    assert await pump.get_reg(R.REG_ON_OFF) == 1                        # still never shut off
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == BOOT_SETPOINT_C  # untouched: not 40, not 46
    rejected = await _rejected(store)
    assert len(rejected) == 1 and "unattended floor 46" in rejected[0]["message"]
    assert rejected[0]["detail"]["requested"] == 40 and rejected[0]["detail"]["source"] == "schedule"
    assert any("schedule" in r.getMessage() and "failed" in r.getMessage() and "floor" in r.getMessage()
               for r in caplog.records)


async def test_comfort_below_floor_is_refused_but_power_on_still_happens(rig):
    pump, poller, store = rig
    g = poller.app_cfg.guardrails
    g.setback_setpoint_c = 40
    g.unattended_min_setpoint_c = 48
    g.comfort_setpoint_c = 44
    await pump.set_reg(R.REG_ON_OFF, 0)
    await poller.poll_once()

    await _fire(store, poller, "on", "06:00")

    assert await pump.get_reg(R.REG_ON_OFF) == 1                        # powering ON is always safe
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == BOOT_SETPOINT_C  # comfort 44 refused, not 48
    rejected = await _rejected(store)
    assert len(rejected) == 1 and rejected[0]["detail"]["requested"] == 44


async def test_setback_above_floor_is_written_unchanged(rig):
    pump, poller, store = rig
    g = poller.app_cfg.guardrails
    g.setback_setpoint_c = 42
    g.unattended_min_setpoint_c = 38

    await _fire(store, poller, "off")

    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 42
    assert await _rejected(store) == []


async def test_fractional_floor_is_compared_rounded_up(rig):
    # write_setpoint accepts whole degrees only, so a 45.5 floor is enforced as 46: a 46 setback
    # is written, a 45 setback is refused and the refusal names the whole-degree floor.
    pump, poller, store = rig
    g = poller.app_cfg.guardrails
    g.unattended_min_setpoint_c = 45.5

    g.setback_setpoint_c = 46
    await _fire(store, poller, "off", "22:00")
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 46
    assert await _rejected(store) == []

    clock = poller.guard._clock()
    poller.guard._clock = lambda: clock + 3600                           # step past the rate limit
    g.setback_setpoint_c = 45
    await _fire(store, poller, "off", "23:00")
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 46                 # untouched
    rejected = await _rejected(store)
    assert len(rejected) == 1 and "unattended floor 46" in rejected[0]["message"]


def _cfg(**guardrails) -> AppConfig:
    return AppConfig(pumps=[PumpConfig(id="p1", name="Pump 1", host="127.0.0.1")],
                     guardrails=GuardrailConfig(**guardrails))


def test_unattended_floor_is_set_by_is_none_not_truthiness():
    g = GuardrailConfig(setback_setpoint_c=40)
    assert g.unattended_floor_c == 40 and g.unattended_floor_whole_c == 40
    g = GuardrailConfig(setback_setpoint_c=40, unattended_min_setpoint_c=45.5)
    assert g.unattended_floor_c == 45.5 and g.unattended_floor_whole_c == 46
    # the validator decides "is a floor set" the same way the poller does (is None, not
    # truthiness): a configured 0 is a floor, refused by the clamp check, never read as "unset"
    with pytest.raises(ValueError, match="unattended_min_setpoint_c"):
        GuardrailConfig(unattended_min_setpoint_c=0, baseline_setpoint_c=48)
    # the baseline check uses that same floor: a baseline under the explicit floor is rejected
    # even though it is above the setback
    with pytest.raises(ValueError, match="baseline_setpoint_c"):
        GuardrailConfig(setback_setpoint_c=40, unattended_min_setpoint_c=45, baseline_setpoint_c=42)


def test_guardrail_warnings_empty_for_defaults():
    assert guardrail_warnings(_cfg()) == []
    assert guardrail_warnings(_cfg(unattended_min_setpoint_c=40, comfort_setpoint_c=50)) == []
    assert guardrail_warnings(_cfg(setback_setpoint_c=45.0, unattended_min_setpoint_c=45.0,
                                   comfort_setpoint_c=50.0)) == []   # whole floats are whole


def test_guardrail_warnings_reports_both_misconfigurations_without_raising():
    cfg = _cfg(setback_setpoint_c=40, unattended_min_setpoint_c=45, comfort_setpoint_c=42)
    warnings = guardrail_warnings(cfg)
    assert len(warnings) == 2
    assert "setback_setpoint_c 40" in warnings[0] and "floor 45" in warnings[0] and "refused" in warnings[0]
    assert "comfort_setpoint_c 42" in warnings[1] and "floor 45" in warnings[1] and "refused" in warnings[1]
    # with no explicit floor the setback is the floor, so a lower comfort is still caught
    only_comfort = guardrail_warnings(_cfg(setback_setpoint_c=40, comfort_setpoint_c=35))
    assert len(only_comfort) == 1 and "comfort_setpoint_c 35" in only_comfort[0]
    assert "the setback" in only_comfort[0]


def test_guardrail_warnings_flags_fractional_setpoints():
    # a fractional floor on its own: one warning, naming the whole degree it is enforced as
    fractional_floor = guardrail_warnings(_cfg(setback_setpoint_c=46, unattended_min_setpoint_c=45.5))
    assert len(fractional_floor) == 1
    assert "unattended_min_setpoint_c 45.5" in fractional_floor[0]
    assert "whole degree" in fractional_floor[0] and "held to 46" in fractional_floor[0]

    # a fractional floor with a setback under it: the below-floor warning uses the rounded floor
    both = guardrail_warnings(_cfg(setback_setpoint_c=45, unattended_min_setpoint_c=45.5))
    assert len(both) == 2
    assert "setback_setpoint_c 45" in both[1] and "floor 46" in both[1] and "45.5 rounded up" in both[1]

    # fractional timer targets are refused as-is, whatever the floor
    targets = guardrail_warnings(_cfg(setback_setpoint_c=40.5, comfort_setpoint_c=50.5))
    assert len(targets) == 2
    assert "setback_setpoint_c 40.5" in targets[0] and "'off' timers are refused" in targets[0]
    assert "comfort_setpoint_c 50.5" in targets[1] and "'on' timers are refused" in targets[1]


def test_guardrail_warnings_skip_timers_when_unattended_writes_are_unrestricted():
    # unrestricted, a timer only powers the pump on/off — it never writes the setback or comfort
    assert guardrail_warnings(_cfg(restrict_unattended_writes=False, setback_setpoint_c=40,
                                   unattended_min_setpoint_c=45, comfort_setpoint_c=42)) == []
    # the floor still governs machine-token writes, so a fractional one is still reported
    fractional = guardrail_warnings(_cfg(restrict_unattended_writes=False, setback_setpoint_c=40,
                                         unattended_min_setpoint_c=45.5))
    assert len(fractional) == 1 and "unattended_min_setpoint_c 45.5" in fractional[0]


def test_baseline_must_be_a_whole_degree():
    # check_lease reverts via write_setpoint, which refuses non-whole degrees: a 45.5 baseline
    # would be refused on every tick and the house would never revert
    with pytest.raises(ValueError, match="baseline_setpoint_c must be a whole degree"):
        GuardrailConfig(setback_setpoint_c=40, unattended_min_setpoint_c=45, baseline_setpoint_c=45.5)
    # the safety values that ship still validate: the default (unset), the live Pi's 52, a whole
    # float, and the production template
    assert GuardrailConfig().baseline_setpoint_c is None
    assert GuardrailConfig(unattended_min_setpoint_c=45, baseline_setpoint_c=52).baseline_setpoint_c == 52
    assert GuardrailConfig(baseline_setpoint_c=48.0).baseline_setpoint_c == 48
    template = pathlib.Path(__file__).resolve().parents[1] / "deploy" / "config.production.yaml"
    g = yaml.safe_load(template.read_text())["guardrails"]
    GuardrailConfig(**{k: v for k, v in g.items() if k in GuardrailConfig.model_fields})


def test_create_app_logs_guardrail_warnings_at_boot(caplog, tmp_path):
    # create_app alone, no lifespan: the warning is logged before anything starts
    cfg = _cfg(setback_setpoint_c=40, unattended_min_setpoint_c=45)
    cfg.db_path = str(tmp_path / "test.db")   # create_app keeps its UI secret beside the db
    with caplog.at_level(logging.WARNING, logger="bridge.main"):
        create_app(cfg)
    messages = [r.getMessage() for r in caplog.records if r.name == "bridge.main"]
    assert any("setback_setpoint_c 40" in m and "floor 45" in m and "refused" in m for m in messages)
