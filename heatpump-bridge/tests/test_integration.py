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
    assert result == {"setpoint_c": 48, "verified": True}
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
