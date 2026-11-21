# @purpose: Offline attribution (#76 item 3): the comm/offline event records, at the moment
# a pump is declared offline, whether the hub link was up, whether the other pump was
# online and whether this pump's gateway accepted a TCP connect — additive keys next to the
# existing `category`, best-effort, bounded, and with no change to when the edge fires.
from __future__ import annotations

import asyncio
import socket
import time
from types import SimpleNamespace

import pytest
from websockets.asyncio.server import serve

import bridge.poller as poller_mod
from bridge.config import AppConfig, HubConfig, PumpConfig
from bridge.guardrails import SetpointGuard
from bridge.hub_client import HubClient
from bridge.modbus_client import ModbusError, PumpClient
from bridge.poller import PumpPoller, probe_gateway
from bridge.store import Store

ATTRIBUTION_KEYS = {"hub_link_up", "peer_pump_online", "gateway_reachable", "last_error_category"}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeProbe:
    """Stands in for probe_gateway: records each call and returns (or does) what it is told."""

    def __init__(self, result=True, hang_s: float = 0.0, raises: Exception | None = None):
        self.result, self.hang_s, self.raises = result, hang_s, raises
        self.calls: list[tuple] = []

    async def __call__(self, host, port, timeout_s):
        self.calls.append((host, port, timeout_s))
        if self.hang_s:
            await asyncio.sleep(self.hang_s)
        if self.raises is not None:
            raise self.raises
        return self.result


@pytest.fixture
async def rig(tmp_path):
    """A poller whose pump never answers: read_block always fails with a timeout, as a
    silent pump (or a Pi with no network) would. It has been online before, so the offline
    edge takes the routine path, not the bench-day page."""
    cfg = AppConfig(
        pumps=[PumpConfig(id="p1", name="Pump 1", host="127.0.0.1", port=free_port(),
                          poll_interval_s=1)],
        db_path=str(tmp_path / "t.db"),
    )
    store = Store(cfg.db_path)
    await store.open()
    poller = PumpPoller(cfg.pumps[0], cfg, store, SetpointGuard(cfg.guardrails))
    poller._ever_online = True

    async def read_block(block):
        poller.client.stats.timeouts += 1
        poller.client.stats.last_error_category = "timeout"
        raise ModbusError("timeout reading 2000", "timeout")

    poller.client.read_block = read_block
    yield poller, store, cfg
    poller.client.close()
    await store.close()


async def _go_offline(poller: PumpPoller, cfg: AppConfig) -> None:
    for _ in range(cfg.guardrails.offline_after_failed_polls):
        await poller.poll_once()


async def _offline_events(store: Store) -> list[dict]:
    return [e for e in await store.get_events("p1", 1) if e["code"] == "offline"]


async def test_offline_edge_with_hub_up_and_gateway_reachable(rig):
    poller, store, cfg = rig
    probe = FakeProbe(True)
    poller._gateway_probe = probe
    poller.hub_link_up = lambda: True
    poller.peers = {"p1": poller, "p2": SimpleNamespace(online=True)}

    await _go_offline(poller, cfg)

    (event,) = await _offline_events(store)
    assert event["detail"] == {"category": "timeout", "hub_link_up": True,
                               "peer_pump_online": True, "gateway_reachable": True,
                               "last_error_category": "timeout"}
    # one connect, to this pump's own gateway, with the 1 s bound
    assert probe.calls == [("127.0.0.1", poller.cfg.port, 1.0)]


async def test_offline_edge_with_hub_down_reads_as_pi_side(rig):
    poller, store, cfg = rig
    poller._gateway_probe = FakeProbe(False)
    poller.hub_link_up = lambda: False
    poller.peers = {"p1": poller, "p2": SimpleNamespace(online=False)}

    await _go_offline(poller, cfg)

    (event,) = await _offline_events(store)
    assert event["detail"]["hub_link_up"] is False
    assert event["detail"]["gateway_reachable"] is False
    assert event["detail"]["peer_pump_online"] is False


async def test_probe_that_hangs_gives_none_and_costs_no_more_than_its_bound(rig, monkeypatch):
    poller, store, cfg = rig
    monkeypatch.setattr(poller_mod, "GATEWAY_PROBE_TIMEOUT_S", 0.05)
    monkeypatch.setattr(poller_mod, "GATEWAY_PROBE_GRACE_S", 0.05)
    poller._gateway_probe = FakeProbe(True, hang_s=30)
    poller.hub_link_up = lambda: True

    started = time.monotonic()
    await _go_offline(poller, cfg)
    elapsed = time.monotonic() - started

    assert elapsed < 2.0                       # nowhere near the 30 s the probe would take
    (event,) = await _offline_events(store)
    assert event["detail"]["gateway_reachable"] is None
    assert event["detail"]["hub_link_up"] is True
    assert poller.snapshot["state"] == "offline"


async def test_default_probe_bound_is_one_second():
    assert poller_mod.GATEWAY_PROBE_TIMEOUT_S == 1.0
    assert poller_mod.GATEWAY_PROBE_GRACE_S <= 0.5


async def test_probe_or_status_that_raises_never_reaches_the_poller(rig):
    poller, store, cfg = rig
    poller._gateway_probe = FakeProbe(raises=RuntimeError("probe bug"))

    def broken_hub():
        raise RuntimeError("hub status bug")

    poller.hub_link_up = broken_hub
    poller.peers = {"p1": poller, "p2": object()}   # a peer with no .online at all

    await _go_offline(poller, cfg)                  # must not raise

    (event,) = await _offline_events(store)
    assert event["detail"]["category"] == "timeout"
    assert event["detail"]["hub_link_up"] is None
    assert event["detail"]["peer_pump_online"] is None
    assert event["detail"]["gateway_reachable"] is None


async def test_unwired_poller_and_unknown_gateway_address_record_none(rig):
    """Nothing set by main.py (a single-pump or test rig) and no gateway address: every
    attribution field is None and no connect is attempted."""
    poller, store, cfg = rig
    probe = FakeProbe(True)
    poller._gateway_probe = probe
    poller.cfg.host = ""

    await _go_offline(poller, cfg)

    (event,) = await _offline_events(store)
    assert event["detail"]["hub_link_up"] is None
    assert event["detail"]["peer_pump_online"] is None
    assert event["detail"]["gateway_reachable"] is None
    assert probe.calls == []


async def test_open_session_counts_as_reachable_without_a_second_connect(rig, monkeypatch):
    """The W610 accepts one client: while the bridge still holds its session (the pump
    answered with an exception, or a decode failed) a probe would kick that socket."""
    poller, store, cfg = rig
    probe = FakeProbe(False)
    poller._gateway_probe = probe
    monkeypatch.setattr(PumpClient, "connected", property(lambda self: True))

    await _go_offline(poller, cfg)

    (event,) = await _offline_events(store)
    assert event["detail"]["gateway_reachable"] is True
    assert probe.calls == []


async def test_offline_event_keeps_what_it_carried_and_fires_when_it_did(rig):
    poller, store, cfg = rig
    probe = FakeProbe(True)
    poller._gateway_probe = probe
    threshold = cfg.guardrails.offline_after_failed_polls

    for _ in range(threshold - 1):
        await poller.poll_once()
    assert await _offline_events(store) == [] and probe.calls == []   # not before the threshold

    await poller.poll_once()
    for _ in range(3):                                               # still offline: no second event
        await poller.poll_once()

    (event,) = await _offline_events(store)
    assert event["type"] == "comm" and event["severity"] == "high"
    assert event["message"] == f"Pump 1 unreachable for {threshold} consecutive polls"
    assert event["detail"]["category"] == "timeout"                  # the key it always had
    assert set(event["detail"]) == {"category"} | ATTRIBUTION_KEYS    # the rest is additive
    assert len(probe.calls) == 1                                     # one probe per edge, no retries
    assert poller.online is False and poller.snapshot["state"] == "offline"


async def test_probe_gateway_true_for_a_listener_false_for_a_dead_port():
    accepted = asyncio.Event()

    async def on_connect(reader, writer):
        accepted.set()
        writer.close()

    server = await asyncio.start_server(on_connect, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        assert await probe_gateway("127.0.0.1", port, 1.0) is True
        await asyncio.wait_for(accepted.wait(), 2)
    finally:
        server.close()
        await server.wait_closed()
    assert await probe_gateway("127.0.0.1", free_port(), 1.0) is False


async def test_hub_client_connected_follows_the_session():
    async def wait_until(cond, timeout: float = 5.0) -> None:
        deadline = time.monotonic() + timeout
        while not cond():
            assert time.monotonic() < deadline, "condition not reached"
            await asyncio.sleep(0.02)

    async def handler(ws):
        async for _ in ws:
            pass

    port = free_port()
    server = await serve(handler, "127.0.0.1", port)
    client = HubClient(HubConfig(url=f"ws://127.0.0.1:{port}/pi", token="pi", state_interval_s=0.2), {})
    assert client.connected is False            # nothing dialled yet
    client.start()
    try:
        await wait_until(lambda: client.connected)
        server.close()
        await server.wait_closed()
        await wait_until(lambda: not client.connected)
    finally:
        await client.stop()
    assert client.connected is False
