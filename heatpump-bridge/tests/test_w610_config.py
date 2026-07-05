# @purpose: Verify our half of the vendor UDP config conversation against a scripted
# fake W610 (handshake, query, set-only-what-differs, restart). The real device's half
# is a bench-day verification item.
from __future__ import annotations

import asyncio
import socket

import pytest

from bridge.w610_config import configure_w610


class FakeW610(asyncio.DatagramProtocol):
    """Speaks the documented USR vendor protocol with configurable initial settings."""

    def __init__(self, uart="115200,8,1,NONE,NFC", tmode="cmd", answer_at=True):
        self.uart = uart
        self.tmode = tmode
        self.answer_at = answer_at
        self.commands: list[str] = []
        self.restarted = False
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        text = data.decode(errors="ignore").strip()
        if data == b"www.usr.cn":
            self.transport.sendto(b"10.0.0.9,D8B04C123456,USR-W610", addr)
            return
        if text == "+ok":
            return
        if not self.answer_at:
            return
        self.commands.append(text)
        if text == "AT+UART":
            self.transport.sendto(f"+ok={self.uart}\r\n".encode(), addr)
        elif text.startswith("AT+UART="):
            self.uart = text.split("=", 1)[1]
            self.transport.sendto(b"+ok\r\n", addr)
        elif text == "AT+TMODE":
            self.transport.sendto(f"+ok={self.tmode}\r\n".encode(), addr)
        elif text.startswith("AT+TMODE="):
            self.tmode = text.split("=", 1)[1]
            self.transport.sendto(b"+ok\r\n", addr)
        elif text == "AT+NETP":
            self.transport.sendto(b"+ok=TCP,Server,8899,10.0.0.9\r\n", addr)
        elif text == "AT+Z":
            self.restarted = True  # no reply, like the real thing


async def start_fake(**kwargs) -> tuple[FakeW610, int]:
    loop = asyncio.get_running_loop()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    fake = FakeW610(**kwargs)
    await loop.create_datagram_endpoint(lambda: fake, sock=sock)
    return fake, port


async def test_configures_factory_fresh_unit():
    fake, port = await start_fake()  # factory: 115200 baud, AT/cmd mode
    report = await configure_w610("127.0.0.1", port=port)
    assert report["ok"] is True
    assert report["reachable"] is True
    assert report["before"]["uart"] == "115200,8,1,NONE,NFC"
    assert any("uart" in c for c in report["changed"])
    assert any("tmode" in c for c in report["changed"])
    assert fake.uart == "2400,8,1,NONE,NFC"
    assert fake.tmode == "throughput"
    assert fake.restarted is True


async def test_already_configured_changes_nothing():
    fake, port = await start_fake(uart="2400,8,1,NONE,NFC", tmode="throughput")
    report = await configure_w610("127.0.0.1", port=port)
    assert report["ok"] is True
    assert report["changed"] == []
    assert fake.restarted is False
    assert not any(c.startswith("AT+UART=") for c in fake.commands)


async def test_no_device_reports_cleanly():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.bind(("127.0.0.1", 0))
        dead_port = s.getsockname()[1]
    report = await configure_w610("127.0.0.1", port=dead_port)
    assert report["ok"] is False
    assert report["reachable"] is False
    assert "web console" in report["error"]


async def test_discovery_only_firmware_reports_cleanly():
    fake, port = await start_fake(answer_at=False)  # answers search, ignores AT
    report = await configure_w610("127.0.0.1", port=port)
    assert report["ok"] is False
    assert report["reachable"] is True
    assert "web console" in report["error"]
