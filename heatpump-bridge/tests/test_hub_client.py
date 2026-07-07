# @purpose: Tests the Pi-side hub client against a real in-process fake hub. A minimal
# 'websockets' server stands in for the Railway hub; a HubClient dials OUT to it and we
# assert the CONTRACT: a relayed setpoint command routes through the guarded write path
# (changing the pump register + acking ok), an out-of-bounds command nacks and leaves the
# register untouched, a non-setpoint action is ignored (no register/power/mode change), and
# the Pi pushes a state frame on connect.
from __future__ import annotations

import asyncio
import json
import socket
import uuid

import pytest
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from bridge import registers as R
from bridge.config import AppConfig, GuardrailConfig, HubConfig, PumpConfig
from bridge.hub_client import HubClient
from bridge.guardrails import SetpointGuard
from bridge.poller import PumpPoller
from bridge.store import Store
from sim.fake_pump import FakePump


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeHub:
    """Minimal stand-in for the Railway hub: accepts one Pi WS, records every frame the
    Pi pushes, and can relay commands to it."""

    def __init__(self):
        self.received: list[dict] = []
        self.auth_header: str | None = None
        self.ws = None
        self.connected = asyncio.Event()

    async def handler(self, ws):
        self.auth_header = ws.request.headers.get("Authorization")
        self.ws = ws
        self.connected.set()
        try:
            async for raw in ws:
                self.received.append(json.loads(raw))
        except ConnectionClosed:
            pass

    async def send_command(self, **fields) -> str:
        command_id = str(uuid.uuid4())
        await self.ws.send(json.dumps(
            {"type": "command", "command_id": command_id, **fields}))
        return command_id

    def acks(self) -> list[dict]:
        return [m for m in self.received if m.get("type") == "ack"]

    def states(self) -> list[dict]:
        return [m for m in self.received if m.get("type") == "state"]

    async def wait_ack(self, command_id: str, timeout: float = 5.0) -> dict:
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            for m in self.acks():
                if m.get("command_id") == command_id:
                    return m
            await asyncio.sleep(0.02)
        raise AssertionError(f"no ack for command {command_id} within {timeout}s")

    async def wait_state(self, timeout: float = 5.0) -> dict:
        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout
        while loop.time() < deadline:
            if self.states():
                return self.states()[0]
            await asyncio.sleep(0.02)
        raise AssertionError(f"no state frame within {timeout}s")


@pytest.fixture
async def hubrig(tmp_path):
    """A live fake pump + poller (polled once, online, writable) wired to a HubClient that
    is connected to an in-process fake hub."""
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
    await poller.poll_once()  # -> online, setpoint_c == 45 (heating)

    hub = FakeHub()
    hub_port = free_port()
    server = await serve(hub.handler, "127.0.0.1", hub_port)

    client = HubClient(
        HubConfig(url=f"ws://127.0.0.1:{hub_port}/pi", token="pi-token",
                  state_interval_s=0.2),
        {"p1": poller})
    client.start()
    await asyncio.wait_for(hub.connected.wait(), timeout=5)

    yield pump, poller, store, hub

    await client.stop()
    server.close()
    await server.wait_closed()
    poller.client.close()
    await pump.server.shutdown()
    await store.close()


async def test_hub_client_authenticates_and_pushes_state_on_connect(hubrig):
    pump, poller, store, hub = hubrig
    # (d) a state frame arrives (the Pi pushes state on connect)
    state = await hub.wait_state()
    assert state["type"] == "state" and "ts" in state
    assert len(state["pumps"]) == 1
    p = state["pumps"][0]
    assert p["id"] == "p1" and p["setpoint_c"] == 45
    assert "remote_lease_until" in p          # hub-specific extra beyond exporter.snapshot
    # the Pi dialed out with its bearer token
    assert hub.auth_header == "Bearer pi-token"


async def test_hub_setpoint_command_writes_and_acks_ok(hubrig):
    pump, poller, store, hub = hubrig
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 45

    command_id = await hub.send_command(action="setpoint", pump_id="p1",
                                        value_c=48, lease_minutes=None,
                                        source="optimizer")
    ack = await hub.wait_ack(command_id)
    assert ack["ok"] is True
    assert ack["setpoint_c"] == 48
    # (a) it went through the guarded write path and changed the register
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 48
    # audit trail attributes the write to the hub source
    events = await store.get_events("p1", 1)
    write = next(e for e in events if e["type"] == "setpoint_write")
    assert write["code"] == "accepted"
    assert write["detail"]["source"] == "hub:optimizer"


async def test_hub_out_of_bounds_command_nacks_and_leaves_register(hubrig):
    pump, poller, store, hub = hubrig
    before = await pump.get_reg(R.REG_SETPOINT_HEATING)

    command_id = await hub.send_command(action="setpoint", pump_id="p1", value_c=200)
    ack = await hub.wait_ack(command_id)
    # (b) a nack is a NORMAL outcome; the guardrail rejected the clamp violation
    assert ack["ok"] is False
    assert ack["setpoint_c"] is None
    assert "200" in ack["detail"]
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == before  # nothing written


async def test_hub_non_numeric_value_nacks_cleanly(hubrig):
    pump, poller, store, hub = hubrig
    before = await pump.get_reg(R.REG_SETPOINT_HEATING)

    # A malformed payload must nack cleanly (not raise a bare TypeError in the write path,
    # and not leave the socket wedged). Both value_c and lease_minutes are validated.
    bad_val = await hub.send_command(action="setpoint", pump_id="p1", value_c="warm")
    ack = await hub.wait_ack(bad_val)
    assert ack["ok"] is False and "invalid value_c" in ack["detail"]

    bad_lease = await hub.send_command(action="setpoint", pump_id="p1",
                                       value_c=48, lease_minutes="soon")
    ack = await hub.wait_ack(bad_lease)
    assert ack["ok"] is False and "invalid lease_minutes" in ack["detail"]

    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == before  # nothing written

    # the link is still healthy — a good command right after still lands
    good = await hub.send_command(action="setpoint", pump_id="p1", value_c=48)
    ack = await hub.wait_ack(good)
    assert ack["ok"] is True and ack["setpoint_c"] == 48


async def test_hub_non_setpoint_action_is_ignored(hubrig):
    pump, poller, store, hub = hubrig
    on_before = await pump.get_reg(R.REG_ON_OFF)
    mode_before = await pump.get_reg(R.REG_MODE)

    # (c) power / mode are human-only on the direct path — the hub must never relay them,
    # and the client must ignore them entirely (no register change, no ack)
    power_id = await hub.send_command(action="power", pump_id="p1", value_c=0)
    mode_id = await hub.send_command(action="mode", pump_id="p1", value_c=0)
    await asyncio.sleep(0.4)  # give the client time to (not) act / (not) ack

    assert await pump.get_reg(R.REG_ON_OFF) == on_before      # power untouched
    assert await pump.get_reg(R.REG_MODE) == mode_before      # mode untouched
    acked_ids = {a.get("command_id") for a in hub.acks()}
    assert power_id not in acked_ids and mode_id not in acked_ids  # ignored, no ack
