# @purpose: End-to-end tests against a real in-process simulated pump: RTU-over-TCP
# round trip, poller snapshot + sample persistence, fault edge detection (on once,
# off once), guarded write with read-back, and offline watchdog.
from __future__ import annotations

import asyncio
import socket

import pytest

from bridge import registers as R
from bridge.config import AppConfig, GuardrailConfig, PumpConfig
from bridge.guardrails import GuardrailError, SetpointGuard
from bridge.poller import PumpPoller
from bridge.store import Store
from sim.fake_pump import FakePump


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
async def rig(tmp_path):
    """A running fake pump + store + poller (loop not started; tests call poll_once)."""
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
    guard = SetpointGuard(cfg.guardrails)
    poller = PumpPoller(cfg.pumps[0], cfg, store, guard)

    yield pump, poller, store

    poller.client.close()
    await pump.server.shutdown()
    await store.close()


async def test_poll_reads_snapshot_and_persists(rig):
    pump, poller, store = rig
    await poller.poll_once()
    snap = poller.snapshot
    assert snap["online"] is True
    assert snap["setpoint_c"] == 45
    assert 20 < snap["inlet_c"] < 60
    assert snap["state"] in ("heating", "idle")
    history = await store.get_history("p1", 1)
    assert len(history) == 1


async def test_fault_edge_detection_on_once_off_once(rig):
    pump, poller, store = rig
    await poller.poll_once()
    assert poller.snapshot["active_faults"] == []

    await pump.inject_fault("P01", on=True)
    await poller.poll_once()
    await poller.poll_once()  # persistent fault: must NOT log a second fault_on
    faults = poller.snapshot["active_faults"]
    assert len(faults) == 1
    assert faults[0]["code"] == "P01"
    assert faults[0]["severity"] == "critical"
    assert poller.snapshot["state"] == "fault"

    await pump.inject_fault("P01", on=False)
    await poller.poll_once()
    assert poller.snapshot["active_faults"] == []

    events = await store.get_events("p1", 1)
    fault_events = [e for e in events if e["type"].startswith("fault")]
    assert [e["type"] for e in fault_events] == ["fault_off", "fault_on"]  # newest first


async def test_p17_is_info_and_does_not_set_fault_state(rig):
    pump, poller, store = rig
    await pump.inject_fault("P17", on=True)
    await poller.poll_once()
    faults = poller.snapshot["active_faults"]
    assert len(faults) == 1
    assert faults[0]["severity"] == "info"
    assert poller.snapshot["state"] != "fault"  # anti-freeze never alarms the chip


async def test_guarded_write_with_readback(rig):
    pump, poller, store = rig
    await poller.poll_once()
    result = await poller.write_setpoint(48, source="test")
    assert result == {"setpoint_c": 48, "verified": True, "mode": "heating"}
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 48

    # audit trail: accepted write recorded with old/new/source
    events = await store.get_events("p1", 1)
    write = next(e for e in events if e["type"] == "setpoint_write")
    assert write["code"] == "accepted"
    assert write["detail"]["source"] == "test"
    assert write["detail"]["requested"] == 48


async def test_write_rejections_are_audited(rig):
    pump, poller, store = rig
    await poller.poll_once()
    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(85, source="test")  # hardware max, above clamp
    assert exc.value.status_code == 422
    events = await store.get_events("p1", 1)
    rejected = next(e for e in events if e["type"] == "setpoint_write")
    assert rejected["code"] == "rejected"


async def test_offline_watchdog_and_write_refusal(rig):
    pump, poller, store = rig
    await poller.poll_once()
    assert poller.online

    await pump.server.shutdown()  # kill the "W610"
    for _ in range(3):
        await poller.poll_once()
    assert not poller.online
    assert poller.snapshot["state"] == "offline"

    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(45, source="test")  # never queue stale writes
    assert exc.value.status_code == 503

    events = await store.get_events("p1", 1)
    assert any(e["type"] == "comm" and e["code"] == "offline" for e in events)


async def test_unit_max_reg2027_caps_the_clamp(rig):
    pump, poller, store = rig
    await pump.set_reg(R.REG_MAX_WATER_TEMP, 50)  # unit's own limit below config's 55
    await poller.poll_once()
    assert poller.snapshot["setpoint_bounds_c"] == [30, 50]
    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(52, source="test")  # fine for config, above unit max
    assert exc.value.status_code == 422
    assert "unit max 50" in str(exc.value)


async def test_cooling_mode_targets_reg_2002_with_cooling_bounds(rig):
    pump, poller, store = rig
    await pump.set_reg(R.REG_MODE, 0)  # someone set cooling at the wall controller
    await pump.tick()
    await poller.poll_once()
    snap = poller.snapshot
    assert snap["mode_kind"] == "cooling"
    assert snap["setpoint_c"] == 16          # active setpoint is now reg 2002
    assert snap["setpoint_bounds_c"] == [12, 25]

    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(45, source="test")  # heating value, cooling mode
    assert exc.value.status_code == 422

    result = await poller.write_setpoint(18, source="test")
    assert result["mode"] == "cooling"
    assert await pump.get_reg(R.REG_SETPOINT_COOLING) == 18
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 45  # untouched


async def test_write_rereads_mode_fresh_not_from_snapshot(rig):
    pump, poller, store = rig
    await poller.poll_once()                 # snapshot says heating
    await pump.set_reg(R.REG_MODE, 0)        # mode flips AFTER the poll
    result = await poller.write_setpoint(18, source="test")
    assert result["mode"] == "cooling"       # fresh read routed to reg 2002
    assert await pump.get_reg(R.REG_SETPOINT_COOLING) == 18


async def test_hot_water_mode_refuses_remote_setpoint(rig):
    pump, poller, store = rig
    await pump.set_reg(R.REG_MODE, 5)
    await poller.poll_once()
    assert poller.snapshot["setpoint_bounds_c"] is None
    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(45, source="test")
    assert exc.value.status_code == 409


async def test_mode_switch_guarded_write(rig):
    pump, poller, store = rig
    await poller.poll_once()
    assert poller.snapshot["mode_kind"] == "heating"

    result = await poller.write_mode("cooling", source="test")
    assert result == {"mode": "cooling", "verified": True}
    assert await pump.get_reg(R.REG_MODE) == 0
    # the immediate re-poll refreshed the snapshot: mode, active setpoint, bounds
    assert poller.snapshot["mode_kind"] == "cooling"
    assert poller.snapshot["setpoint_bounds_c"] == [12, 25]

    events = await store.get_events("p1", 1)
    mode_event = next(e for e in events if e["type"] == "mode_write")
    assert mode_event["code"] == "accepted"
    assert mode_event["detail"]["source"] == "test"


async def test_power_toggle_guarded_write(rig):
    pump, poller, store = rig
    await poller.poll_once()
    result = await poller.write_power(False, source="test")
    assert result == {"on": False, "verified": True}
    assert await pump.get_reg(R.REG_ON_OFF) == 0
    assert poller.snapshot["on"] is False
    assert poller.snapshot["state"] == "off"

    events = await store.get_events("p1", 1)
    assert any(e["type"] == "power_write" and e["code"] == "accepted" for e in events)


async def test_control_writes_have_independent_rate_limits(rig):
    pump, poller, store = rig
    await poller.poll_once()
    # a mode write must not consume the setpoint limiter, and vice versa
    await poller.write_mode("cooling", source="test")
    await poller.write_setpoint(18, source="test")   # allowed immediately after
    await poller.write_power(False, source="test")   # and power has its own lane


async def test_control_writes_refused_when_disabled(rig):
    pump, poller, store = rig
    await poller.poll_once()
    poller.cfg.write_enabled = False
    for call in (poller.write_mode("cooling", source="test"),
                 poller.write_power(False, source="test")):
        with pytest.raises(GuardrailError) as exc:
            await call
        assert exc.value.status_code == 403
    poller.cfg.write_enabled = True


async def test_parameter_write_guarded(rig):
    pump, poller, store = rig
    await poller.poll_once()
    # happy path: lower the unit's own max water temp; setpoint bounds follow
    result = await poller.write_parameter("max_water_temp_c", 60, source="test")
    assert result == {"key": "max_water_temp_c", "value": 60, "verified": True}
    assert await pump.get_reg(R.REG_MAX_WATER_TEMP) == 60
    assert poller.snapshot["setpoint_bounds_c"] == [30, 60]

    # negative values encode as two's complement and verify correctly
    await asyncio.sleep(0.15)  # param writes share one rate-limit lane
    result = await poller.write_parameter("defrost_enter_coil_c", -5, source="test")
    assert result["verified"] is True
    assert R.to_signed(await pump.get_reg(2015)) == -5

    events = await store.get_events("p1", 1)
    writes = [e for e in events if e["type"] == "param_write" and e["code"] == "accepted"]
    assert len(writes) == 2


async def test_parameter_write_rejects_out_of_doc_range(rig):
    pump, poller, store = rig
    await poller.poll_once()
    with pytest.raises(GuardrailError) as exc:
        await poller.write_parameter("defrost_enter_coil_c", 5, source="test")  # doc: -15..-1
    assert exc.value.status_code == 422
    with pytest.raises(GuardrailError) as exc:
        await poller.write_parameter("not_a_param", 1, source="test")
    assert exc.value.status_code == 404


async def test_scheduler_fires_once_per_day(rig):
    from datetime import datetime
    from bridge.scheduler import Scheduler

    pump, poller, store = rig
    await poller.poll_once()
    assert poller.snapshot["on"] is True

    await store.add_schedule("p1", "06:00", "off")
    sched = Scheduler(store, {"p1": poller})
    now = datetime(2026, 7, 4, 6, 0, 10)

    await sched.check_once(now)
    assert poller.snapshot["on"] is False           # fired through the guarded path
    await sched.check_once(now)                     # same minute: must not re-fire
    events = await store.get_events("p1", 1)
    fired = [e for e in events if e["type"] == "power_write" and e["code"] == "accepted"]
    assert len(fired) == 1
    assert fired[0]["detail"]["source"] == "schedule"

    await sched.check_once(datetime(2026, 7, 4, 7, 0))   # different minute: no match
    assert len([e for e in await store.get_events("p1", 1)
                if e["type"] == "power_write" and e["code"] == "accepted"]) == 1

    await store.delete_schedule("p1", (await store.list_schedules("p1"))[0]["id"])
    assert await store.list_schedules("p1") == []


async def test_open_faults_survive_restart(rig):
    pump, poller, store = rig
    await pump.inject_fault("E18", on=True)
    await poller.poll_once()
    since = poller.snapshot["active_faults"][0]["since"]

    # simulate bridge restart: fresh poller, same store
    guard = SetpointGuard(poller.app_cfg.guardrails)
    poller2 = PumpPoller(poller.cfg, poller.app_cfg, store, guard)
    await poller2.start()
    try:
        await asyncio.sleep(0)  # let start() finish; active_faults loaded before task runs
        assert list(poller2.active_faults.values())[0]["since"] == pytest.approx(since)
        await poller2.poll_once()
        events = await store.get_events("p1", 1)
        fault_ons = [e for e in events if e["type"] == "fault_on"]
        assert len(fault_ons) == 1  # NOT re-logged after restart
    finally:
        await poller2.stop()
