# @purpose: #76 item 4 — "slow with the link up" and CRC/framing trouble are visible in
# CommStats instead of folded into generic counters: per-request round trip (last / max /
# slow count, on an injected clock), and crc_errors counted ALONGSIDE timeouts / io_errors.
# The raw-socket tests pin the pymodbus behaviour the split rests on: a bad-CRC or short
# reply is dropped by the RTU framer without raising, so it surfaces as a timeout.
from __future__ import annotations

import asyncio
import socket

import pytest
from pymodbus.exceptions import ModbusIOException

from bridge import registers as R
from bridge.config import AppConfig, GuardrailConfig, PumpConfig
from bridge.guardrails import SetpointGuard
from bridge.modbus_client import SLOW_RTT_MS, CommStats, ModbusError, PumpClient
from bridge.poller import PumpPoller
from bridge.store import Store
from sim.fake_pump import FakePump


class _Clock:
    """Monotonic clock the test advances by hand — no real sleeps."""

    def __init__(self):
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


class _FakeResp:
    def __init__(self, n, error=False):
        self.registers = [0] * n
        self._error = error

    def isError(self):
        return self._error


def _stub_client(clock: _Clock, **kw) -> PumpClient:
    client = PumpClient("127.0.0.1", 1, 1, clock=clock, **kw)

    async def no_connect():
        return None

    client._ensure_connected = no_connect
    return client


def _reply_after(client: PumpClient, clock: _Clock, seconds: float, n: int = 9, error=False):
    async def read(addr, count=1, device_id=1):
        clock.t += seconds
        return _FakeResp(n, error)

    client._client.read_holding_registers = read


def _crc16(data: bytes) -> bytes:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return bytes([crc & 0xFF, crc >> 8])


def _status_reply() -> bytes:
    """A well-formed RTU reply to a 9-register read from device 1, CRC included."""
    body = bytes([1, 3, 18]) + bytes(18)
    return body + _crc16(body)


async def test_good_reply_records_rtt_and_is_not_slow():
    clock = _Clock()
    client = _stub_client(clock)
    _reply_after(client, clock, 0.12)
    await client.read_block(R.BLOCK_STATUS)
    s = client.stats
    assert s.last_rtt_ms == pytest.approx(120.0)
    assert s.max_rtt_ms == pytest.approx(120.0)
    assert s.slow_requests == 0
    assert s.crc_errors == 0 and s.io_errors == 0 and s.timeouts == 0
    d = s.as_dict()
    assert d["last_rtt_ms"] == s.last_rtt_ms and d["max_rtt_ms"] == s.max_rtt_ms
    assert d["slow_requests"] == 0 and d["crc_errors"] == 0


async def test_reply_past_threshold_counts_slow_and_max_holds():
    clock = _Clock()
    client = _stub_client(clock)
    _reply_after(client, clock, SLOW_RTT_MS / 1000 + 0.5)
    await client.read_block(R.BLOCK_STATUS)
    assert client.stats.slow_requests == 1
    assert client.stats.max_rtt_ms == pytest.approx(SLOW_RTT_MS + 500)

    _reply_after(client, clock, 0.1)                      # a fast one afterwards
    await client.read_block(R.BLOCK_STATUS)
    assert client.stats.last_rtt_ms == pytest.approx(100.0)
    assert client.stats.max_rtt_ms == pytest.approx(SLOW_RTT_MS + 500)   # max is sticky
    assert client.stats.slow_requests == 1


async def test_slow_threshold_is_configurable_and_exactly_at_it_is_not_slow():
    clock = _Clock()
    client = _stub_client(clock, slow_rtt_ms=250.0)
    _reply_after(client, clock, 0.25)
    await client.read_block(R.BLOCK_STATUS)
    assert client.stats.slow_requests == 0
    _reply_after(client, clock, 0.5)
    await client.read_block(R.BLOCK_STATUS)
    assert client.stats.slow_requests == 1


async def test_exception_response_still_records_rtt():
    """A NAK is an answer: the link's round trip is known even though the read failed."""
    clock = _Clock()
    client = _stub_client(clock)
    _reply_after(client, clock, 0.2, error=True)
    with pytest.raises(ModbusError) as exc:
        await client.read_block(R.BLOCK_STATUS)
    assert exc.value.category == "exception"
    assert client.stats.last_rtt_ms == pytest.approx(200.0)
    assert client.stats.exception_responses == 1 and client.stats.crc_errors == 0


async def test_silent_timeout_is_not_a_crc_error_and_has_no_rtt():
    clock = _Clock()
    client = _stub_client(clock)

    async def silent(addr, count=1, device_id=1):
        clock.t += 5.0
        raise ModbusIOException("No response received after 0 retries")

    client._client.read_holding_registers = silent
    with pytest.raises(ModbusError) as exc:
        await client.read_block(R.BLOCK_STATUS)
    assert exc.value.category == "timeout"
    s = client.stats
    assert s.timeouts == 1 and s.crc_errors == 0 and s.io_errors == 0
    assert s.last_rtt_ms is None and s.max_rtt_ms is None and s.slow_requests == 0


async def test_timeout_with_reply_bytes_counts_crc_alongside_timeout():
    """Bytes came back but pymodbus found no valid frame: the request is still a timeout
    (unchanged), and ALSO a crc_error. The byte count restarts with each request."""
    clock = _Clock()
    client = _stub_client(clock)

    async def garbled(addr, count=1, device_id=1):
        client._trace_packet(True, b"\x01\x03\x08\x3e\x00\x09")      # our request: not counted
        assert client._trace_packet(False, b"\x01\x03\x12\xff") == b"\x01\x03\x12\xff"
        raise ModbusIOException("No response received after 0 retries")

    async def silent(addr, count=1, device_id=1):
        raise ModbusIOException("No response received after 0 retries")

    client._client.read_holding_registers = garbled
    with pytest.raises(ModbusError) as exc:
        await client.read_block(R.BLOCK_STATUS)
    assert exc.value.category == "timeout"
    assert client.stats.timeouts == 1 and client.stats.crc_errors == 1
    assert client.stats.io_errors == 0

    client._client.read_holding_registers = silent       # next request: nothing arrives
    with pytest.raises(ModbusError):
        await client.read_block(R.BLOCK_STATUS)
    assert client.stats.timeouts == 2 and client.stats.crc_errors == 1


async def test_wrong_length_frame_counts_crc_and_keeps_io_errors():
    clock = _Clock()
    client = _stub_client(clock)
    _reply_after(client, clock, 0.1, n=40)                # a 40-register reply to a 9 read
    with pytest.raises(ModbusError) as exc:
        await client.read_block(R.BLOCK_STATUS)
    assert exc.value.category == "io"
    assert client.stats.io_errors == 1                    # backward compatible total
    assert client.stats.crc_errors == 1


async def _one_reply_server(reply: bytes):
    """Raw TCP stand-in for a W610: answer the first request with `reply` verbatim."""
    writers = []

    async def on_conn(reader, writer):
        writers.append(writer)
        try:
            await reader.readexactly(8)                   # one read-holding-registers request
            writer.write(reply)
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass

    server = await asyncio.start_server(on_conn, "127.0.0.1", 0)
    return server, writers


async def _read_status_against(reply: bytes) -> tuple[PumpClient, Exception | None]:
    server, writers = await _one_reply_server(reply)
    client = PumpClient("127.0.0.1", server.sockets[0].getsockname()[1], 1, timeout_s=0.4)
    err = None
    try:
        await client.read_block(R.BLOCK_STATUS)
    except ModbusError as exc:
        err = exc
    finally:
        client.close()
        for w in writers:
            w.transport.abort()   # else server.wait_closed() waits on this peer forever
        server.close()
        await asyncio.wait_for(server.wait_closed(), 2)
    return client, err


async def test_wire_good_frame_passes_through_the_trace_hook():
    """The byte counter is passive: a well-formed reply still decodes."""
    client, err = await _read_status_against(_status_reply())
    assert err is None
    assert client.stats.crc_errors == 0 and client.stats.timeouts == 0
    assert client.stats.last_rtt_ms is not None and client.stats.slow_requests == 0


async def test_wire_crc_mismatch_reply_counts_crc_error():
    good = _status_reply()
    bad = good[:-1] + bytes([good[-1] ^ 0xFF])            # same frame, wrong CRC
    client, err = await _read_status_against(bad)
    assert isinstance(err, ModbusError) and err.category == "timeout"
    assert client.stats.crc_errors == 1
    assert client.stats.timeouts == 1 and client.stats.io_errors == 0


async def test_wire_short_frame_counts_crc_error():
    client, err = await _read_status_against(_status_reply()[:7])   # cut off mid-payload
    assert isinstance(err, ModbusError) and err.category == "timeout"
    assert client.stats.crc_errors == 1
    assert client.stats.timeouts == 1 and client.stats.io_errors == 0


def test_fresh_stats_start_empty():
    d = CommStats().as_dict()
    assert d["last_rtt_ms"] is None and d["max_rtt_ms"] is None
    assert d["slow_requests"] == 0 and d["crc_errors"] == 0


async def test_max_resets_with_the_client_on_gateway_change(tmp_path):
    """CommStats have exactly one reset point: apply_gateway swaps in a fresh PumpClient.
    The max goes with it, and the live snapshot carries the new fields."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    pump = FakePump(1, port)
    await pump.start()
    await pump.tick()
    cfg = AppConfig(
        pumps=[PumpConfig(id="p1", name="Pump 1", host="127.0.0.1", port=port,
                          poll_interval_s=1)],
        guardrails=GuardrailConfig(),
        db_path=str(tmp_path / "test.db"),
    )
    store = Store(cfg.db_path)
    await store.open()
    poller = PumpPoller(cfg.pumps[0], cfg, store, SetpointGuard(cfg.guardrails))
    try:
        await poller.poll_once()
        assert poller.online is True
        comm = poller.snapshot["comm"]
        assert comm["max_rtt_ms"] is not None and comm["last_rtt_ms"] is not None
        assert comm["crc_errors"] == 0 and comm["slow_requests"] == 0

        await poller.apply_gateway("127.0.0.1", port, source="test")
        assert poller.client.stats.max_rtt_ms is None
        assert poller.client.stats.last_rtt_ms is None
        assert poller.client.stats.slow_requests == 0
    finally:
        poller.client.close()
        await pump.server.shutdown()
        await store.close()
