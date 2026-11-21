# @purpose: Async Modbus client wrapper for one heat pump behind a USR-W610 in transparent
# mode: RTU framing over a TCP socket (FramerType.RTU — NOT Modbus TCP). Owns reconnect
# logic and the comm error counters that validate the unshielded-wire decision.
from __future__ import annotations

import asyncio
import logging
import socket
import struct
import time
from dataclasses import dataclass, field

from pymodbus import FramerType, ModbusException
from pymodbus.client import AsyncModbusTcpClient

from .registers import ReadBlock, block_dict

log = logging.getLogger(__name__)


@dataclass
class CommStats:
    ok_polls: int = 0
    error_polls: int = 0
    timeouts: int = 0
    io_errors: int = 0          # non-timeout transport errors + wrong-length replies
    exception_responses: int = 0  # Modbus exception PDUs from the pump
    connect_failures: int = 0   # TCP connect refused/unreachable (≠ timeout: see triage table)
    reconnects: int = 0
    consecutive_failures: int = 0
    last_ok_ts: float | None = None  # unix time of last fully successful poll
    # most recent failure kind, so the UI can say WHICH layer is down: "connect" = the
    # W610 gateway is unreachable (TCP failed); timeout/io/exception = gateway answered
    # but the pump behind it didn't. Empty while healthy.
    last_error_category: str = ""
    # #76 item 4 — additive. crc_errors is an "of which" count ALONGSIDE the counters
    # above, never instead of them: a reply that arrived but was not a usable frame. Two
    # sources: (a) reply bytes reached the socket yet pymodbus found no valid frame in
    # them (bad CRC or a short frame — pymodbus drops those silently, so the request also
    # counts in timeouts); (b) a valid frame of the wrong length (also counts in io_errors,
    # as before). timeouts − (a) is therefore "true silence".
    crc_errors: int = 0
    # round trip of the most recent ANSWERED request (send → reply, monotonic clock), the
    # worst one since these stats were created, and how many ran over the slow threshold:
    # "slow with the link up". Unanswered requests are in timeouts, not here.
    last_rtt_ms: float | None = None
    max_rtt_ms: float | None = None
    slow_requests: int = 0

    def as_dict(self) -> dict:
        total = self.ok_polls + self.error_polls
        return {
            "ok_polls": self.ok_polls,
            "error_polls": self.error_polls,
            "timeouts": self.timeouts,
            "io_errors": self.io_errors,
            "exception_responses": self.exception_responses,
            "connect_failures": self.connect_failures,
            "reconnects": self.reconnects,
            "consecutive_failures": self.consecutive_failures,
            "last_ok_ts": self.last_ok_ts,
            "last_error_category": self.last_error_category,
            "error_rate": round(self.error_polls / total, 4) if total else 0.0,
            "crc_errors": self.crc_errors,
            "last_rtt_ms": self.last_rtt_ms,
            "max_rtt_ms": self.max_rtt_ms,
            "slow_requests": self.slow_requests,
        }


class ModbusError(Exception):
    """Wraps any transport/protocol failure with a category for stats."""

    def __init__(self, message: str, category: str = "io"):
        super().__init__(message)
        self.category = category


# Rebuild the pymodbus transport after this many consecutive failed connects (~10 min at
# a 20 s poll interval). The 2026-08-20 blackout ran 3 days of connect failures against
# ONE AsyncModbusTcpClient instance and only a Pi reboot recovered it — the async client
# can wedge in a state where connect() fails instantly forever (dead internal reconnect
# task). MAC-follow rediscovery never helps in that state because the gateway hasn't
# moved. A fresh client object is the cheapest rung of the self-heal ladder; the
# bridge-watchdog timer (deploy/bridge-watchdog.sh) escalates above it.
REBUILD_AFTER_CONNECT_FAILURES = 30

# An answered request slower than this counts in CommStats.slow_requests (#76 item 4). At
# 2400 baud the largest poll block (51 registers = 107 reply bytes) is ~0.5 s of pure wire
# time, so a healthy link sits well under 1 s; above it the WiFi leg is stalling.
SLOW_RTT_MS = 1000.0


class PumpClient:
    """One RTU-over-TCP connection to one heat pump. The bridge is the only Modbus
    master on each bus, so no cross-request locking beyond this client's own mutex."""

    def __init__(self, host: str, port: int, device_id: int, timeout_s: float = 5.0,
                 *, slow_rtt_ms: float = SLOW_RTT_MS, clock=time.monotonic):
        self.host = host
        self.port = port
        self.device_id = device_id
        self._timeout_s = timeout_s
        self._slow_rtt_ms = slow_rtt_ms
        self._clock = clock   # injectable so tests can make a reply "slow" without sleeping
        self._rx_bytes = 0    # reply bytes seen on the socket since the current request began
        self.stats = CommStats()
        # retries=0: NO pymodbus retransmits. RTU-over-TCP has no transaction IDs, so a
        # response that arrives after its timeout would be matched to whatever request is
        # pending NEXT — a retransmit doubles the pump's responses and creates exactly that
        # stale frame. The poller's own cycle (every poll_interval_s) is the retry policy;
        # at 2400 baud a lost frame costs one failed poll, not corrupted data.
        self._client = self._new_transport()
        self._lock = asyncio.Lock()  # serialize requests on the half-duplex bus
        self._was_connected = False
        self._consecutive_connect_failures = 0

    def _new_transport(self) -> AsyncModbusTcpClient:
        return AsyncModbusTcpClient(
            self.host, port=self.port, framer=FramerType.RTU,
            timeout=self._timeout_s, retries=0, trace_packet=self._trace_packet,
        )

    # @purpose: Passive byte counter on pymodbus's packet trace hook — the only place a
    # reply that fails CRC is visible at all (the RTU framer discards it without raising).
    # Returns the data untouched: it observes the stream, it never alters framing.
    def _trace_packet(self, sending: bool, data: bytes) -> bytes:
        if not sending:
            self._rx_bytes += len(data)
        return data

    # @purpose: Mark the start of one request: zero the reply-byte counter and return the
    # monotonic start time for _record_rtt.
    def _begin_request(self) -> float:
        self._rx_bytes = 0
        return self._clock()

    # @purpose: Record the round trip of a request that got a reply (good, exception or
    # wrong-shape): last / max since these stats were created / count over the threshold.
    def _record_rtt(self, started: float) -> None:
        rtt_ms = round((self._clock() - started) * 1000.0, 1)
        self.stats.last_rtt_ms = rtt_ms
        if self.stats.max_rtt_ms is None or rtt_ms > self.stats.max_rtt_ms:
            self.stats.max_rtt_ms = rtt_ms
        if rtt_ms > self._slow_rtt_ms:
            self.stats.slow_requests += 1

    # @purpose: After a request timed out, tell "the pump said nothing" from "bytes came
    # back but no valid frame was in them" (bad CRC / short frame) and count the latter.
    def _note_garbled_reply(self, category: str) -> None:
        if category == "timeout" and self._rx_bytes > 0:
            self.stats.crc_errors += 1

    async def _ensure_connected(self) -> None:
        if self._client.connected:
            return
        ok = await self._client.connect()
        if not ok:
            self.stats.connect_failures += 1
            self.stats.last_error_category = "connect"
            self._consecutive_connect_failures += 1
            if self._consecutive_connect_failures % REBUILD_AFTER_CONNECT_FAILURES == 0:
                log.warning(
                    "%s:%s unreachable for %d consecutive connects — rebuilding the "
                    "pymodbus transport (wedged-client self-heal)",
                    self.host, self.port, self._consecutive_connect_failures)
                self._client.close()
                self._client = self._new_transport()
            raise ModbusError(f"cannot connect to {self.host}:{self.port}", "connect")
        self._consecutive_connect_failures = 0
        if self._was_connected:
            self.stats.reconnects += 1
        self._was_connected = True

    def _flush_socket(self, category: str) -> None:
        """After a timeout/garbage failure, drop the TCP session so the next request
        starts on a fresh socket. The W610 discards its buffered serial bytes when the
        client disconnects, so a response still in flight (WiFi stall) can never be
        matched to a LATER request — RTU framing has no transaction IDs to catch that."""
        if category in ("timeout", "io"):
            self._hard_close()

    def _hard_close(self) -> None:
        """Close with SO_LINGER 0 (RST), not the default graceful FIN. A timeout usually
        means the Pi's WiFi stalled with our request frame still unacknowledged in the
        kernel's send queue; a graceful close leaves that orphaned socket retransmitting,
        so the stale frame can reach the W610 — and HP2's CN22 bus — after the link comes
        back, alongside the fresh session's first poll. RST discards it instead."""
        transport = getattr(getattr(self._client, "ctx", None), "transport", None)
        sock = transport.get_extra_info("socket") if transport is not None else None
        if sock is not None:
            try:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            except OSError:
                pass  # already dead — the plain close below is all that's left to do
        self._client.close()

    async def read_block(self, block: ReadBlock) -> dict[int, int]:
        """Read one batched register block, returning {address: raw}."""
        async with self._lock:
            await self._ensure_connected()
            started = self._begin_request()
            try:
                resp = await self._client.read_holding_registers(
                    block.start, count=block.count, device_id=self.device_id,
                )
            except ModbusException as exc:
                # pymodbus 3.13 swallows asyncio timeouts internally and surfaces
                # them as ModbusIOException — classify by message so stats.timeouts
                # actually counts them
                category = self._classify(exc)
                self._note_garbled_reply(category)
                self._flush_socket(category)
                raise ModbusError(f"{category} reading {block.start}: {exc}", category) from exc
            self._record_rtt(started)
            if resp.isError():
                self.stats.exception_responses += 1
                self.stats.last_error_category = "exception"
                raise ModbusError(f"exception response for {block.start}: {resp}", "exception")
            # Shape check: pymodbus matches replies to requests ONLY by device id (RTU has
            # no transaction ids), so a delayed response can be accepted as the answer to a
            # DIFFERENT block — mapping control values onto fault bitfields (phantom fault
            # pages) or onto temps (plausible-looking garbage). The three poll blocks have
            # pairwise-distinct counts (40/51/9), so a strict length check makes that
            # cross-attribution structurally impossible.
            regs = getattr(resp, "registers", None)
            if regs is None or len(regs) != block.count:
                self.stats.io_errors += 1
                self.stats.crc_errors += 1  # framing trouble; io_errors keeps its old total
                self.stats.last_error_category = "io"
                self._flush_socket("io")
                got = "no registers" if regs is None else f"{len(regs)} registers"
                raise ModbusError(
                    f"mismatched response for block {block.start}: got {got}, "
                    f"expected {block.count} — stale/foreign frame discarded", "io")
            return block_dict(block, regs)

    async def read_register(self, address: int) -> int:
        regs = await self.read_block(ReadBlock(address, 1))
        return regs[address]

    async def write_register_verified(self, address: int, value: int) -> int:
        """Write a single register then read it back. Returns the read-back value;
        caller decides whether a mismatch is an error (it is, for setpoints)."""
        async with self._lock:
            await self._ensure_connected()
            started = self._begin_request()
            try:
                resp = await self._client.write_register(address, value, device_id=self.device_id)
            except ModbusException as exc:
                category = self._classify(exc)
                self._note_garbled_reply(category)
                self._flush_socket(category)
                raise ModbusError(f"{category} writing {address}: {exc}", category) from exc
            self._record_rtt(started)
            if resp.isError():
                self.stats.exception_responses += 1
                self.stats.last_error_category = "exception"
                raise ModbusError(f"exception response writing {address}: {resp}", "exception")
        return await self.read_register(address)

    def _classify(self, exc: Exception) -> str:
        text = str(exc).lower()
        if "timeout" in text or "timed out" in text or "no response" in text:
            self.stats.timeouts += 1
            self.stats.last_error_category = "timeout"
            return "timeout"
        self.stats.io_errors += 1
        self.stats.last_error_category = "io"
        return "io"

    def record_poll(self, ok: bool) -> None:
        if ok:
            self.stats.ok_polls += 1
            self.stats.consecutive_failures = 0
            self.stats.last_ok_ts = time.time()
        else:
            self.stats.error_polls += 1
            self.stats.consecutive_failures += 1

    def close(self) -> None:
        self._client.close()
