# @purpose: Reconnect quarantine (knowledge/reference/hp2-e21-reconnect-analysis.md): after
# an outage of >= reconnect_min_outage_s, writes are refused for reconnect_write_hold_s and
# the first polls are paced; a timed-out socket is closed with RST so a stalled request
# frame can't be delivered to the W610 after the WiFi comes back.
from __future__ import annotations

import asyncio
import socket
import time

import pytest

import bridge.poller as poller_mod
from bridge.config import AppConfig, GuardrailConfig, PumpConfig
from bridge.guardrails import GuardrailError, SetpointGuard
from bridge.modbus_client import ModbusError, PumpClient
from bridge.poller import PumpPoller
from bridge.store import Store
from sim.fake_pump import FakePump

MIN_OUTAGE_S = 0.2
HOLD_S = 0.4


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _make_rig(tmp_path, hold_s=HOLD_S, **guardrails):
    port = free_port()
    pump = FakePump(1, port)
    await pump.start()
    await pump.tick()
    cfg = AppConfig(
        pumps=[PumpConfig(id="p1", name="Pump 1", host="127.0.0.1", port=port,
                          poll_interval_s=1, write_enabled=True)],
        guardrails=GuardrailConfig(min_write_interval_s=0.0,
                                   reconnect_min_outage_s=MIN_OUTAGE_S,
                                   reconnect_write_hold_s=hold_s, **guardrails),
        db_path=str(tmp_path / "test.db"),
    )
    store = Store(cfg.db_path)
    await store.open()
    poller = PumpPoller(cfg.pumps[0], cfg, store, SetpointGuard(cfg.guardrails))
    return pump, poller, store


@pytest.fixture
async def rig(tmp_path):
    pump, poller, store = await _make_rig(tmp_path)
    yield pump, poller, store
    poller.client.close()
    await pump.server.shutdown()
    await store.close()


def _outage_switch(poller: PumpPoller) -> dict:
    """Wrap the client's read_block so a test can turn the gateway 'unreachable'."""
    state = {"down": False, "reads": []}
    real = poller.client.read_block

    async def read_block(block):
        if state["down"]:
            raise ModbusError("cannot connect to 127.0.0.1", "connect")
        state["reads"].append(time.monotonic())
        return await real(block)

    poller.client.read_block = read_block
    return state


async def _outage(poller: PumpPoller, sw: dict, seconds: float) -> None:
    sw["down"] = True
    await poller.poll_once()
    await asyncio.sleep(seconds)
    await poller.poll_once()
    sw["down"] = False


async def _codes(store: Store) -> list[str]:
    return [e["code"] for e in await store.get_events("p1", 1)]


async def test_long_outage_holds_writes_then_releases(rig):
    pump, poller, store = rig
    sw = _outage_switch(poller)
    await poller.poll_once()
    await _outage(poller, sw, MIN_OUTAGE_S + 0.05)

    await poller.poll_once()                       # first good poll after the outage
    assert poller.online is True
    assert "reconnect_hold" in await _codes(store)

    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(48, source="hub:phase-b")
    assert exc.value.status_code == 503
    assert "reconnect quarantine" in str(exc.value)
    rejected = [e for e in await store.get_events("p1", 1)
                if e["type"] == "setpoint_write" and e["code"] == "rejected"]
    assert rejected, "a held write must be audited like any other refusal"

    with pytest.raises(GuardrailError):            # mode/param/power-off writes too
        await poller.write_mode("heating", source="hub:phase-b")

    await asyncio.sleep(HOLD_S + 0.05)
    result = await poller.write_setpoint(48, source="hub:phase-b")
    assert result["setpoint_c"] == 48 and result["verified"] is True


async def test_short_blip_does_not_hold_writes(rig):
    pump, poller, store = rig
    sw = _outage_switch(poller)
    await poller.poll_once()
    sw["down"] = True
    await poller.poll_once()                       # one failed poll, well under the minimum
    sw["down"] = False
    await poller.poll_once()

    assert "reconnect_hold" not in await _codes(store)
    result = await poller.write_setpoint(48, source="hub:phase-b")
    assert result["verified"] is True


async def test_first_polls_after_outage_are_paced(rig, monkeypatch):
    pump, poller, store = rig
    monkeypatch.setattr(poller_mod, "RECONNECT_BLOCK_GAP_S", 0.2)
    sw = _outage_switch(poller)
    await poller.poll_once()
    await _outage(poller, sw, MIN_OUTAGE_S + 0.05)

    sw["reads"].clear()
    await poller.poll_once()                       # the reconnect poll
    paced = sw["reads"]
    assert len(paced) >= 2
    assert all(b - a >= 0.15 for a, b in zip(paced, paced[1:]))

    await asyncio.sleep(HOLD_S + 0.05)
    sw["reads"].clear()
    await poller.poll_once()                       # quarantine over: back to a tight burst
    healthy = sw["reads"]
    assert all(b - a < 0.15 for a, b in zip(healthy, healthy[1:]))


async def test_safety_and_owner_writes_are_never_held(rig, monkeypatch):
    pump, poller, store = rig
    monkeypatch.setattr(poller_mod, "RECONNECT_BLOCK_GAP_S", 0.0)  # keep the hold window
    sw = _outage_switch(poller)
    await poller.poll_once()
    await _outage(poller, sw, MIN_OUTAGE_S + 0.05)
    await poller.poll_once()
    assert "reconnect_hold" in await _codes(store)

    for source, value in (("ui", 47), ("hub:dashboard", 49), ("hub:armed-dashboard", 50)):
        result = await poller.write_setpoint(value, source=source)
        assert result["setpoint_c"] == value
    await poller.write_power(True, source="hub:phase-b")   # toward heat: never held
    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(51, source="hub:phase-b")
    assert "reconnect quarantine" in str(exc.value)


async def test_baseline_revert_lands_during_a_hold(tmp_path):
    """FINDING-1 is armed on the Pi: a lapsed lease must revert to the warm baseline even
    if it lapses inside a reconnect hold."""
    pump, poller, store = await _make_rig(tmp_path, baseline_setpoint_c=52)
    try:
        sw = _outage_switch(poller)
        await poller.poll_once()
        await poller.write_setpoint(60, source="hub:phase-b", unattended=True,
                                    lease_minutes=90)
        await _outage(poller, sw, MIN_OUTAGE_S + 0.05)
        await poller.poll_once()
        assert "reconnect_hold" in await _codes(store)

        poller._lease["until"] = time.time() - 1          # the planner went silent
        await poller.check_lease(time.time())
        assert poller._lease is None and poller._reverted is True
        assert poller.snapshot["setpoint_c"] == 52
    finally:
        poller.client.close()
        await pump.server.shutdown()
        await store.close()


async def test_flapping_gateway_gets_one_hold_per_window(rig, monkeypatch):
    """Down >= the minimum, back, down again: the second return must not restart the
    hold, or a flapping link would keep every planner write out indefinitely."""
    pump, poller, store = rig
    sw = _outage_switch(poller)
    await poller.poll_once()
    await _outage(poller, sw, MIN_OUTAGE_S + 0.05)
    await poller.poll_once()                       # hold #1
    await asyncio.sleep(HOLD_S + 0.05)
    await _outage(poller, sw, MIN_OUTAGE_S + 0.05)
    await poller.poll_once()                       # inside the spacing window: no hold
    assert (await _codes(store)).count("reconnect_hold") == 1
    result = await poller.write_setpoint(48, source="hub:phase-b")
    assert result["verified"] is True

    monkeypatch.setattr(poller_mod, "RECONNECT_HOLD_MIN_SPACING_S", 0.1)
    await _outage(poller, sw, MIN_OUTAGE_S + 0.05)
    await poller.poll_once()                       # spacing elapsed: holds again
    assert (await _codes(store)).count("reconnect_hold") == 2


async def test_audit_failure_does_not_fail_the_reconnect_poll(rig, monkeypatch):
    pump, poller, store = rig
    sw = _outage_switch(poller)
    await poller.poll_once()
    await _outage(poller, sw, MIN_OUTAGE_S + 0.05)
    real_add_event = store.add_event

    async def flaky_add_event(pump_id, type_, **kw):
        if kw.get("code") == "reconnect_hold":
            raise RuntimeError("disk full")
        return await real_add_event(pump_id, type_, **kw)

    monkeypatch.setattr(store, "add_event", flaky_add_event)
    errors = poller.client.stats.error_polls
    await poller.poll_once()
    assert poller.online is True
    assert poller.client.stats.error_polls == errors   # still a good poll
    assert poller._failing_since is None
    with pytest.raises(GuardrailError):                 # and the hold still started
        await poller.write_setpoint(48, source="hub:phase-b")


async def test_hold_zero_disables_quarantine(tmp_path):
    pump, poller, store = await _make_rig(tmp_path, hold_s=0)
    try:
        sw = _outage_switch(poller)
        await poller.poll_once()
        await _outage(poller, sw, MIN_OUTAGE_S + 0.05)
        await poller.poll_once()
        assert "reconnect_hold" not in await _codes(store)
        result = await poller.write_setpoint(48, source="hub:phase-b")
        assert result["verified"] is True
    finally:
        poller.client.close()
        await pump.server.shutdown()
        await store.close()


async def test_timed_out_socket_is_reset_not_gracefully_closed():
    """A graceful close leaves an orphaned socket retransmitting whatever request was stuck
    in the send queue; the W610 would then receive it after the WiFi returns. SO_LINGER 0
    makes the close an RST, which the peer sees as a reset, not a clean EOF."""
    accepted: asyncio.Queue = asyncio.Queue()

    async def on_conn(reader, writer):
        await accepted.put((reader, writer))

    server = await asyncio.start_server(on_conn, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    client = PumpClient("127.0.0.1", port, 1, timeout_s=0.5)
    writer = None
    try:
        await client._ensure_connected()
        reader, writer = await asyncio.wait_for(accepted.get(), 2)
        client._flush_socket("timeout")
        try:
            data = await asyncio.wait_for(reader.read(10), 2)
        except ConnectionResetError:
            data = None
        assert data is None, f"peer read {data!r}: a graceful close, not an RST"
    finally:
        client.close()
        if writer is not None:
            writer.transport.abort()   # else server.wait_closed() waits on this peer forever
        server.close()
        await asyncio.wait_for(server.wait_closed(), 2)
