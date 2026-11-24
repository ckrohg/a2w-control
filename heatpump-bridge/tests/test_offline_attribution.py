# @purpose: Offline attribution (#76 item 3): the comm/offline event records, at the moment
# a pump is declared offline, whether the hub link was up, whether the other pump was
# online and whether (and why not) this pump's gateway accepted a TCP connect — additive keys next to the
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

ATTRIBUTION_KEYS = {"hub_link_up", "peer_pump_online", "gateway_reachable", "gateway_probe_result",
                    "last_error_category"}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeProbe:
    """Stands in for probe_gateway: records each call and returns (or does) what it is told."""

    def __init__(self, result="ok", hang_s: float = 0.0, raises: Exception | None = None):
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
    probe = FakeProbe("ok")
    poller._gateway_probe = probe
    poller.hub_link_up = lambda: True
    poller.peers = {"p1": poller, "p2": SimpleNamespace(online=True)}

    await _go_offline(poller, cfg)

    (event,) = await _offline_events(store)
    assert event["detail"] == {"category": "timeout", "hub_link_up": True,
                               "peer_pump_online": True, "gateway_reachable": True,
                               "gateway_probe_result": "ok", "last_error_category": "timeout"}
    # one connect, to this pump's own gateway, with the 1 s bound
    assert probe.calls == [("127.0.0.1", poller.cfg.port, 1.0)]


async def test_offline_edge_with_hub_down_reads_as_pi_side(rig):
    poller, store, cfg = rig
    poller._gateway_probe = FakeProbe("unreachable")
    poller.hub_link_up = lambda: False
    poller.peers = {"p1": poller, "p2": SimpleNamespace(online=False)}

    await _go_offline(poller, cfg)

    (event,) = await _offline_events(store)
    assert event["detail"]["hub_link_up"] is False
    assert event["detail"]["gateway_reachable"] is False
    assert event["detail"]["gateway_probe_result"] == "unreachable"
    assert event["detail"]["peer_pump_online"] is False


async def test_probe_that_hangs_gives_none_and_costs_no_more_than_its_bound(rig, monkeypatch):
    poller, store, cfg = rig
    monkeypatch.setattr(poller_mod, "GATEWAY_PROBE_TIMEOUT_S", 0.05)
    monkeypatch.setattr(poller_mod, "GATEWAY_PROBE_GRACE_S", 0.05)
    poller._gateway_probe = FakeProbe("ok", hang_s=30)
    poller.hub_link_up = lambda: True

    started = time.monotonic()
    await _go_offline(poller, cfg)
    elapsed = time.monotonic() - started

    assert elapsed < 2.0                       # nowhere near the 30 s the probe would take
    (event,) = await _offline_events(store)
    assert event["detail"]["gateway_reachable"] is None
    assert event["detail"]["gateway_probe_result"] == "timeout"
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
    assert event["detail"]["gateway_probe_result"] == "error"


async def test_unwired_poller_and_unknown_gateway_address_record_none(rig):
    """Nothing set by main.py (a single-pump or test rig) and no gateway address: every
    attribution field is None and no connect is attempted."""
    poller, store, cfg = rig
    probe = FakeProbe("ok")
    poller._gateway_probe = probe
    poller.cfg.host = ""

    await _go_offline(poller, cfg)

    (event,) = await _offline_events(store)
    assert event["detail"]["hub_link_up"] is None
    assert event["detail"]["peer_pump_online"] is None
    assert event["detail"]["gateway_reachable"] is None
    assert event["detail"]["gateway_probe_result"] is None
    assert probe.calls == []


async def test_open_session_counts_as_reachable_without_a_second_connect(rig, monkeypatch):
    """The W610 accepts one client: while the bridge still holds its session (the pump
    answered with an exception, or a decode failed) a probe would kick that socket."""
    poller, store, cfg = rig
    probe = FakeProbe("refused")
    poller._gateway_probe = probe
    monkeypatch.setattr(PumpClient, "connected", property(lambda self: True))

    await _go_offline(poller, cfg)

    (event,) = await _offline_events(store)
    assert event["detail"]["gateway_reachable"] is True
    assert event["detail"]["gateway_probe_result"] == "ok"
    assert probe.calls == []


async def test_offline_event_keeps_what_it_carried_and_fires_when_it_did(rig):
    poller, store, cfg = rig
    probe = FakeProbe("ok")
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


async def test_empty_last_error_category_after_a_rediscovery_records_none(rig):
    """apply_gateway rebuilds the PumpClient, so its stats start over with category ""."""
    poller, store, cfg = rig
    poller._gateway_probe = FakeProbe("ok")

    async def read_block(block):
        raise ModbusError("timeout reading 2000", "timeout")   # stats never set a category

    poller.client.read_block = read_block
    await _go_offline(poller, cfg)

    (event,) = await _offline_events(store)
    assert event["detail"]["last_error_category"] is None


async def test_probe_gateway_ok_for_a_listener_refused_for_a_dead_port():
    # No wait for the server to accept: the probe resets its socket (SO_LINGER 0) at once,
    # and a BSD stack drops a reset connection from the accept queue before accept sees it.
    async def on_connect(reader, writer):
        writer.close()

    server = await asyncio.start_server(on_connect, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        assert await probe_gateway("127.0.0.1", port, 1.0) == "ok"
    finally:
        server.close()
        await server.wait_closed()
    assert await probe_gateway("127.0.0.1", free_port(), 1.0) == "refused"


async def test_gateway_that_never_answers_records_a_timeout_within_the_bound(rig, monkeypatch):
    """The real probe_gateway against a connect that never completes, as a W610 that has lost its
    Wi-Fi never answers a SYN. (A full listen backlog is not a portable way to make that: macOS
    still completes the handshake.) The probe's own timeout ends it, inside the poller's bound."""
    poller, store, cfg = rig
    monkeypatch.setattr(poller_mod, "GATEWAY_PROBE_TIMEOUT_S", 0.3)
    poller._gateway_probe = probe_gateway                  # the real function, not the fake

    async def never_connects(host, port, *a, **kw):
        await asyncio.sleep(30)

    monkeypatch.setattr(poller_mod.asyncio, "open_connection", never_connects)
    poller.cfg.host = "127.0.0.1"

    started = time.monotonic()
    await _go_offline(poller, cfg)
    elapsed = time.monotonic() - started

    (event,) = await _offline_events(store)
    assert event["detail"]["gateway_reachable"] is False
    assert event["detail"]["gateway_probe_result"] == "timeout"
    assert elapsed < 0.3 + poller_mod.GATEWAY_PROBE_GRACE_S + 1.0


async def test_pump_client_connected_follows_the_real_socket():
    """No monkeypatching: the property itself must exist and track the transport."""
    accepted: asyncio.Queue = asyncio.Queue()

    async def on_conn(reader, writer):
        await accepted.put(writer)

    server = await asyncio.start_server(on_conn, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    client = PumpClient("127.0.0.1", port, 1, timeout_s=0.5)
    writer = None
    try:
        assert client.connected is False            # nothing dialled yet
        await client._ensure_connected()
        writer = await asyncio.wait_for(accepted.get(), 2)
        assert client.connected is True
        client._hard_close()
        assert client.connected is False
    finally:
        client.close()
        if writer is not None:
            writer.transport.abort()
        server.close()
        await asyncio.wait_for(server.wait_closed(), 2)


def test_main_wires_hub_link_up_as_none_while_the_hub_is_disabled(tmp_path):
    from fastapi.testclient import TestClient

    from bridge.main import create_app

    cfg = AppConfig(
        pumps=[PumpConfig(id="p1", name="Pump 1", host="127.0.0.1", port=free_port(),
                          poll_interval_s=999)],
        db_path=str(tmp_path / "b.db"), ui_dir="ui")
    with TestClient(create_app(cfg)) as c:
        poller = c.app.state.pollers["p1"]
        assert poller.hub_link_up() is None          # no hub configured: unknown, not "down"
        assert poller.peers is c.app.state.pollers


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
