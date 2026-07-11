# @purpose: Async Modbus client wrapper for one heat pump behind a USR-W610 in transparent
# mode: RTU framing over a TCP socket (FramerType.RTU — NOT Modbus TCP). Owns reconnect
# logic and the comm error counters that validate the unshielded-wire decision.
from __future__ import annotations

import asyncio
import logging
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
    io_errors: int = 0          # includes CRC/framing errors surfaced by pymodbus
    exception_responses: int = 0  # Modbus exception PDUs from the pump
    connect_failures: int = 0   # TCP connect refused/unreachable (≠ timeout: see triage table)
    reconnects: int = 0
    consecutive_failures: int = 0
    last_ok_ts: float | None = None  # unix time of last fully successful poll

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
            "error_rate": round(self.error_polls / total, 4) if total else 0.0,
        }


class ModbusError(Exception):
    """Wraps any transport/protocol failure with a category for stats."""

    def __init__(self, message: str, category: str = "io"):
        super().__init__(message)
        self.category = category


class PumpClient:
    """One RTU-over-TCP connection to one heat pump. The bridge is the only Modbus
    master on each bus, so no cross-request locking beyond this client's own mutex."""

    def __init__(self, host: str, port: int, device_id: int, timeout_s: float = 5.0):
        self.host = host
        self.port = port
        self.device_id = device_id
        self.stats = CommStats()
        # retries=0: NO pymodbus retransmits. RTU-over-TCP has no transaction IDs, so a
        # response that arrives after its timeout would be matched to whatever request is
        # pending NEXT — a retransmit doubles the pump's responses and creates exactly that
        # stale frame. The poller's own cycle (every poll_interval_s) is the retry policy;
        # at 2400 baud a lost frame costs one failed poll, not corrupted data.
        self._client = AsyncModbusTcpClient(
            host, port=port, framer=FramerType.RTU, timeout=timeout_s, retries=0,
        )
        self._lock = asyncio.Lock()  # serialize requests on the half-duplex bus
        self._was_connected = False

    async def _ensure_connected(self) -> None:
        if self._client.connected:
            return
        ok = await self._client.connect()
        if not ok:
            self.stats.connect_failures += 1
            raise ModbusError(f"cannot connect to {self.host}:{self.port}", "connect")
        if self._was_connected:
            self.stats.reconnects += 1
        self._was_connected = True

    def _flush_socket(self, category: str) -> None:
        """After a timeout/garbage failure, drop the TCP session so the next request
        starts on a fresh socket. The W610 discards its buffered serial bytes when the
        client disconnects, so a response still in flight (WiFi stall) can never be
        matched to a LATER request — RTU framing has no transaction IDs to catch that."""
        if category in ("timeout", "io"):
            self._client.close()

    async def read_block(self, block: ReadBlock) -> dict[int, int]:
        """Read one batched register block, returning {address: raw}."""
        async with self._lock:
            await self._ensure_connected()
            try:
                resp = await self._client.read_holding_registers(
                    block.start, count=block.count, device_id=self.device_id,
                )
            except ModbusException as exc:
                # pymodbus 3.13 swallows asyncio timeouts internally and surfaces
                # them as ModbusIOException — classify by message so stats.timeouts
                # actually counts them
                category = self._classify(exc)
                self._flush_socket(category)
                raise ModbusError(f"{category} reading {block.start}: {exc}", category) from exc
            if resp.isError():
                self.stats.exception_responses += 1
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
            try:
                resp = await self._client.write_register(address, value, device_id=self.device_id)
            except ModbusException as exc:
                category = self._classify(exc)
                self._flush_socket(category)
                raise ModbusError(f"{category} writing {address}: {exc}", category) from exc
            if resp.isError():
                self.stats.exception_responses += 1
                raise ModbusError(f"exception response writing {address}: {resp}", "exception")
        return await self.read_register(address)

    def _classify(self, exc: Exception) -> str:
        text = str(exc).lower()
        if "timeout" in text or "timed out" in text or "no response" in text:
            self.stats.timeouts += 1
            return "timeout"
        self.stats.io_errors += 1
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
