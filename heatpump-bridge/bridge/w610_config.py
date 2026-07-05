# @purpose: EXPERIMENTAL remote configuration of a USR-W610's serial side over the
# vendor UDP channel (the same :48899 protocol discovery uses): handshake, query
# current settings, fix only what differs (UART 2400 8N1 + transparent mode), restart.
# Our half is tested against a scripted fake; the W610's half gets verified on the
# bench with unit #1 — on any surprise we report and the web-console path remains.
from __future__ import annotations

import asyncio
import logging

log = logging.getLogger(__name__)

SEARCH_KEYWORD = b"www.usr.cn"
DESIRED_UART = "2400,8,1,NONE,NFC"   # baud, data bits, stop bits, parity, flow control
DESIRED_TMODE = "THROUGHPUT"         # a.k.a. transparent mode


class _UdpSession(asyncio.DatagramProtocol):
    def __init__(self):
        self.replies: asyncio.Queue[bytes] = asyncio.Queue()
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        self.replies.put_nowait(data)

    async def request(self, payload: bytes, timeout_s: float = 2.0) -> bytes | None:
        while not self.replies.empty():  # drop stale
            self.replies.get_nowait()
        self.transport.sendto(payload)
        try:
            return await asyncio.wait_for(self.replies.get(), timeout_s)
        except asyncio.TimeoutError:
            return None

    def send(self, payload: bytes) -> None:
        self.transport.sendto(payload)


async def configure_w610(host: str, *, port: int = 48899) -> dict:
    """Set the W610's serial side to what the heat pump needs. Returns a report:
    {ok, reachable, before: {uart, tmode, netp}, changed: [...], error?}."""
    report: dict = {"ok": False, "reachable": False, "before": {}, "changed": []}
    loop = asyncio.get_running_loop()
    transport, session = await loop.create_datagram_endpoint(
        _UdpSession, remote_addr=(host, port))
    try:
        # 1. handshake: search keyword -> "ip,MAC,name"; then +ok enters AT mode
        hello = await session.request(SEARCH_KEYWORD)
        if hello is None:
            report["error"] = ("no reply on the vendor config port — configure via the "
                               "W610 web console instead (deploy/w610-setup.md)")
            return report
        report["reachable"] = True
        session.send(b"+ok")
        await asyncio.sleep(0.3)

        async def at(cmd: str) -> str | None:
            reply = await session.request(f"{cmd}\r\n".encode())
            if reply is None:
                return None
            text = reply.decode(errors="ignore").strip()
            return text.removeprefix("+ok=").removeprefix("+ok").strip(" \r\n=")

        # 2. read current settings (report even if we change nothing)
        uart = await at("AT+UART")
        tmode = await at("AT+TMODE")
        netp = await at("AT+NETP")
        report["before"] = {"uart": uart, "tmode": tmode, "netp": netp}
        if uart is None and tmode is None:
            report["error"] = ("device answered discovery but not AT commands — "
                               "firmware variant? use the web console")
            return report

        # 3. fix only what differs. NETP (TCP server :8899) is factory default —
        #    report-only, never touched.
        if uart is not None and uart.upper().replace(" ", "") != DESIRED_UART:
            if (await at(f"AT+UART={DESIRED_UART}")) is None:
                report["error"] = f"AT+UART set command got no reply (was {uart})"
                return report
            report["changed"].append(f"uart {uart} -> {DESIRED_UART}")
        if tmode is not None and tmode.upper() != DESIRED_TMODE:
            if (await at("AT+TMODE=throughput")) is None:
                report["error"] = f"AT+TMODE set command got no reply (was {tmode})"
                return report
            report["changed"].append(f"tmode {tmode} -> throughput")

        # 4. restart to apply (no reply expected; brief grace so the datagram lands
        #    before we close the socket)
        if report["changed"]:
            session.send(b"AT+Z\r\n")
            await asyncio.sleep(0.3)
            report["restarted"] = True
        report["ok"] = True
        return report
    finally:
        transport.close()
