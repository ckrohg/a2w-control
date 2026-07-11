# @purpose: LAN discovery of W610 gateways so nobody hand-hunts IPs. Two sweeps merged:
# the USR-vendor UDP broadcast (WIFI232 family answers "www.usr.cn" on :48899 with
# ip,mac) and a fast TCP scan of the local /24 for the Modbus port. Candidates can be
# probed with a real register read to confirm "this is a heat pump". Also home of the
# MAC helpers used by the poller's identity check.
from __future__ import annotations

import asyncio
import logging
import os
import re
import socket
import subprocess

from pymodbus import FramerType
from pymodbus.client import AsyncModbusTcpClient

log = logging.getLogger(__name__)

USR_DISCOVERY_PORT = 48899
USR_DISCOVERY_PAYLOAD = b"www.usr.cn"


def normalize_mac(mac: str) -> str:
    """Case/zero-pad tolerant: 'D8:B0:4C:1:2:3' == 'd8:b0:4c:01:02:03'."""
    return ":".join(part.zfill(2) for part in mac.lower().strip().replace("-", ":").split(":"))


async def get_mac_for_ip(host: str) -> str | None:
    """Best-effort ARP lookup for the MAC behind an IP we have talked to recently.
    Returns None when unresolvable (localhost/sim, cold ARP cache) — callers must
    treat None as 'cannot verify', never as a mismatch."""
    def _lookup() -> str | None:
        try:
            if os.path.exists("/proc/net/arp"):  # Linux / the Pi
                with open("/proc/net/arp") as f:
                    for line in f.readlines()[1:]:
                        parts = line.split()
                        if len(parts) >= 4 and parts[0] == host:
                            return None if parts[3] == "00:00:00:00:00:00" else parts[3]
            else:  # macOS dev
                out = subprocess.run(["arp", "-n", host], capture_output=True,
                                     text=True, timeout=2)
                m = re.search(r"(([0-9a-f]{1,2}:){5}[0-9a-f]{1,2})", out.stdout.lower())
                return m.group(1) if m else None
        except Exception:
            return None
        return None
    return await asyncio.to_thread(_lookup)


def local_subnet_hosts() -> list[str]:
    """The /24 around this machine's primary LAN address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no packets sent; just resolves the local address
        own = s.getsockname()[0]
    except OSError:
        return []
    finally:
        s.close()
    base = own.rsplit(".", 1)[0]
    return [f"{base}.{i}" for i in range(1, 255)]


async def usr_udp_discover(timeout_s: float = 1.5) -> dict[str, str]:
    """USR vendor broadcast discovery -> {ip: mac}. Harmless no-op if nothing answers."""
    found: dict[str, str] = {}
    try:
        loop = asyncio.get_running_loop()

        class Proto(asyncio.DatagramProtocol):
            def datagram_received(self, data, addr):
                # replies look like b"192.168.1.61,D8B04CXXXXXX,USR-W610"
                try:
                    parts = data.decode(errors="ignore").split(",")
                    if len(parts) >= 2 and re.fullmatch(r"[0-9A-Fa-f]{12}", parts[1]):
                        mac = ":".join(parts[1][i:i + 2] for i in range(0, 12, 2)).lower()
                        found[addr[0]] = mac
                except Exception:
                    pass

        transport, _ = await loop.create_datagram_endpoint(
            Proto, local_addr=("0.0.0.0", 0), allow_broadcast=True)
        try:
            transport.sendto(USR_DISCOVERY_PAYLOAD, ("255.255.255.255", USR_DISCOVERY_PORT))
            await asyncio.sleep(timeout_s)
        finally:
            transport.close()
    except Exception as exc:
        log.debug("usr broadcast discovery unavailable: %s", exc)
    return found


async def tcp_scan(hosts: list[str], ports: set[int], timeout_s: float = 0.4,
                   exclude: set[tuple[str, int]] | None = None) -> list[tuple[str, int]]:
    """Which (host, port) pairs accept a TCP connection. ~2s for a /24.
    exclude: pairs never to touch — with max-clients=1 on a W610, even this plain
    connect can kick/collide with the bridge's live polling connection."""
    sem = asyncio.Semaphore(64)

    async def check(host: str, port: int):
        async with sem:
            try:
                _, writer = await asyncio.wait_for(
                    asyncio.open_connection(host, port), timeout_s)
                writer.close()
                return (host, port)
            except Exception:
                return None

    tasks = [check(h, p) for h in hosts for p in sorted(ports)
             if not (exclude and (h, p) in exclude)]
    return [r for r in await asyncio.gather(*tasks) if r]


async def probe_heatpump(host: str, port: int, device_id: int = 1,
                         timeout_s: float = 3.0) -> dict | None:
    """One real RTU-over-TCP read of inlet/outlet/ambient — confirms 'this gateway has
    a Macon heat pump behind it' and helps tell pump 1 from pump 2 by temperature."""
    client = AsyncModbusTcpClient(host, port=port, framer=FramerType.RTU, timeout=timeout_s)
    try:
        if not await client.connect():
            return None
        rr = await client.read_holding_registers(2050, count=3, device_id=device_id)
        if rr.isError():
            return None
        def sign(v): return v - 0x10000 if v > 0x7FFF else v
        return {"inlet_c": sign(rr.registers[0]), "outlet_c": sign(rr.registers[1]),
                "ambient_c": sign(rr.registers[2])}
    except Exception:
        return None
    finally:
        client.close()


async def discover(extra_ports: set[int] | None = None, probe: bool = True,
                   skip_probe: set[tuple[str, int]] | None = None) -> list[dict]:
    """Full sweep -> [{ip, port, mac, source, probe}]. Modbus port default 8899.
    skip_probe: (host, port) pairs NOT to open ANY connection to — gateways this bridge
    is actively using. With max-clients=1 on the W610, even the plain TCP-connect of the
    port scan (not just the Modbus probe) can kick or collide with the bridge's live
    polling connection, so these pairs are excluded from the scan entirely. The UDP
    broadcast still covers them (it never touches :8899), so they stay discoverable."""
    ports = {8899} | (extra_ports or set())
    udp_found = await usr_udp_discover()
    open_ports = await tcp_scan(local_subnet_hosts(), ports, exclude=skip_probe)
    # skipped pairs are open by definition — the bridge holds a live connection to them
    open_ports += list(skip_probe or ())

    candidates: dict[str, dict] = {}
    for ip, mac in udp_found.items():
        candidates[ip] = {"ip": ip, "port": 8899, "mac": mac, "source": "usr-broadcast"}
    for ip, port in open_ports:
        entry = candidates.setdefault(ip, {"ip": ip, "mac": None, "source": "port-scan"})
        entry["port"] = port
        entry.setdefault("source", "port-scan")

    for entry in candidates.values():
        if not entry.get("mac"):
            entry["mac"] = await get_mac_for_ip(entry["ip"])
        if probe and entry.get("port"):
            if skip_probe and (entry["ip"], entry["port"]) in skip_probe:
                entry["probe"] = None
                entry["probe_skipped"] = "connected to this bridge"
            else:
                entry["probe"] = await probe_heatpump(entry["ip"], entry["port"])
    return sorted(candidates.values(), key=lambda e: e["ip"])
