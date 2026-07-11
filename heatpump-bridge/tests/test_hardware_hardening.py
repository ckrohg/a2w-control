# @purpose: Regression guards from the pre-hardware readiness review — the failure modes a
# real W610 at 2400 baud can produce that the localhost simulator never could: stale/foreign
# frames matched to the wrong request (RTU-over-TCP has no transaction ids), decode crashes
# leaving an "online" zombie, a pump that was NEVER online failing to alert, and the
# reserved-hole split fallback for a spec-strict pump.
from __future__ import annotations

import socket

import pytest

from bridge import registers as R
from bridge.config import AppConfig, GuardrailConfig, PumpConfig
from bridge.guardrails import SetpointGuard
from bridge.modbus_client import ModbusError, PumpClient
from bridge.poller import PumpPoller
from bridge.store import Store
from sim.fake_pump import FakePump


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
async def rig(tmp_path):
    """Live fake pump + poller, mirroring test_integration's rig."""
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
    yield pump, poller, store
    poller.client.close()
    await pump.server.shutdown()
    await store.close()


class _FakeResp:
    def __init__(self, n):
        self.registers = [0] * n

    def isError(self):
        return False


async def test_mismatched_response_length_is_rejected_not_mismapped():
    """A stale/foreign frame (wrong register count) must raise, not be silently mapped
    onto the wrong block — the RTU-over-TCP cross-attribution guard."""
    client = PumpClient("127.0.0.1", 1, 1)

    async def no_connect():
        return None

    async def wrong_shape(addr, count=1, device_id=1):
        return _FakeResp(40)  # a BLOCK_CONTROL-sized reply...

    client._ensure_connected = no_connect
    client._client.read_holding_registers = wrong_shape
    with pytest.raises(ModbusError) as exc:
        await client.read_block(R.BLOCK_STATUS)  # ...answering a 9-register request
    assert exc.value.category == "io"
    assert "mismatched" in str(exc.value)
    assert client.stats.io_errors == 1


async def test_decode_failure_counts_as_failed_poll_not_online_zombie(rig, monkeypatch):
    pump, poller, store = rig

    def boom(regs):
        raise ValueError("decode bug")

    monkeypatch.setattr(R, "decode_snapshot", boom)
    await poller.poll_once()   # must not raise, and must NOT count as a good poll
    assert poller.client.stats.ok_polls == 0
    assert poller.client.stats.error_polls == 1
    assert poller.online is False

    monkeypatch.undo()
    await poller.poll_once()   # healthy again
    assert poller.online is True


async def test_never_online_pump_still_alerts_offline_once(tmp_path):
    """Fresh boot into a dead gateway (the bench-day case): must alert at the threshold,
    exactly once, with a message pointing at the triage table."""
    cfg = AppConfig(
        pumps=[PumpConfig(id="p1", name="Pump 1", host="127.0.0.1", port=free_port(),
                          poll_interval_s=1)],   # nothing listens on this port
        db_path=str(tmp_path / "t.db"),
    )
    store = Store(cfg.db_path)
    await store.open()
    poller = PumpPoller(cfg.pumps[0], cfg, store, SetpointGuard(cfg.guardrails))
    try:
        for _ in range(cfg.guardrails.offline_after_failed_polls + 2):
            await poller.poll_once()
        events = await store.get_events("p1", 1)
        offline = [e for e in events if e["code"] == "offline"]
        assert len(offline) == 1                          # alerted, and only once
        assert "never responded" in offline[0]["message"]
        assert "triage" in offline[0]["message"]
    finally:
        poller.client.close()
        await store.close()


async def test_split_reserved_hole_fallback_polls_and_writes(rig, monkeypatch):
    """The bench fallback for a pump that NAKs reads spanning 2006-2009: with the flag
    flipped, both the poll loop and the write path read control regs in two blocks."""
    pump, poller, store = rig
    monkeypatch.setattr(R, "SPLIT_RESERVED_HOLE", True)
    assert len(R.control_blocks()) == 2

    await poller.poll_once()
    assert poller.online is True
    assert poller.snapshot["setpoint_c"] == 45            # from block A (2000-2005)
    assert poller.snapshot["max_water_temp_c"] == 90      # from block B (2010-2039)

    result = await poller.write_setpoint(48, source="test")   # _read_control merges both
    assert result["setpoint_c"] == 48 and result["verified"] is True
