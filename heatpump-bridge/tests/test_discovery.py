# @purpose: Pin LAN discovery's rules without real sockets — USR broadcast reply parsing,
# the UDP/port-scan candidate merge, and discover()'s identity rule: the ARP (station) MAC
# wins, the broadcast (base) MAC survives as broadcast_mac only on a real mismatch (found
# on W610 hardware 2026-07-12), and pairs the bridge is using are never scanned or probed.
from __future__ import annotations

import pytest

from bridge import discovery
from bridge.discovery import merge_candidates, parse_usr_reply
from bridge.registers import TEMP_SCALE


# --- parse_usr_reply -------------------------------------------------------------------

def test_parses_valid_reply():
    assert parse_usr_reply(b"192.168.1.61,D8B04C010203,USR-W610") == "d8:b0:4c:01:02:03"


def test_parses_two_field_reply():
    assert parse_usr_reply(b"192.168.1.61,d8b04c0a0b0c") == "d8:b0:4c:0a:0b:0c"


@pytest.mark.parametrize("data", [
    b"",
    b"garbage",
    b"192.168.1.61",                         # no mac field
    b"192.168.1.61,D8B04C0102,USR-W610",     # too short
    b"192.168.1.61,D8B04C01020304,USR-W610",  # too long
    b"192.168.1.61,D8B04C01020G,USR-W610",   # non-hex
    b"192.168.1.61,D8:B0:4C:01:02:03,USR",   # already colon-separated: not the USR format
    b"192.168.1.61, D8B04C010203,USR-W610",  # stray whitespace
    b"\xff\xfe\x00",                         # undecodable bytes
])
def test_rejects_malformed_reply(data):
    assert parse_usr_reply(data) is None


# --- merge_candidates ------------------------------------------------------------------

def test_merge_udp_only():
    out = merge_candidates({"10.0.0.5": "d8:b0:4c:01:02:03"}, [])
    assert out == {"10.0.0.5": {"ip": "10.0.0.5", "port": 8899,
                                "mac": "d8:b0:4c:01:02:03", "source": "usr-broadcast"}}


def test_merge_scan_only():
    out = merge_candidates({}, [("10.0.0.6", 502)])
    assert out == {"10.0.0.6": {"ip": "10.0.0.6", "port": 502,
                                "mac": None, "source": "port-scan"}}


def test_merge_seen_by_both_keeps_broadcast_mac_and_source_takes_scan_port():
    out = merge_candidates({"10.0.0.7": "d8:b0:4c:01:02:03"}, [("10.0.0.7", 8898)])
    assert out == {"10.0.0.7": {"ip": "10.0.0.7", "port": 8898,
                                "mac": "d8:b0:4c:01:02:03", "source": "usr-broadcast"}}


def test_merge_all_three_kinds_together():
    out = merge_candidates(
        {"10.0.0.1": "aa:aa:aa:aa:aa:01", "10.0.0.2": "aa:aa:aa:aa:aa:02"},
        [("10.0.0.2", 8899), ("10.0.0.3", 8899)])
    assert set(out) == {"10.0.0.1", "10.0.0.2", "10.0.0.3"}
    assert out["10.0.0.1"]["source"] == "usr-broadcast"
    assert out["10.0.0.2"]["source"] == "usr-broadcast"
    assert out["10.0.0.3"]["source"] == "port-scan"
    assert out["10.0.0.3"]["mac"] is None


# --- discover() with every network touchpoint faked -----------------------------------

class FakeNet:
    def __init__(self, udp=None, open_ports=None, arp=None, probe_result=None):
        self.udp = udp or {}
        self.open_ports = open_ports or []
        self.arp = arp or {}
        self.probe_result = probe_result if probe_result is not None else {"inlet_c": 40}
        self.scan_calls: list[dict] = []
        self.probed: list[tuple[str, int]] = []

    def install(self, monkeypatch):
        async def usr_udp_discover(timeout_s=1.5):
            return dict(self.udp)

        def local_subnet_hosts():
            return ["10.0.0.1", "10.0.0.2"]

        async def tcp_scan(hosts, ports, timeout_s=0.4, exclude=None):
            self.scan_calls.append({"hosts": hosts, "ports": ports, "exclude": exclude})
            return [p for p in self.open_ports if not (exclude and p in exclude)]

        async def get_mac_for_ip(host):
            return self.arp.get(host)

        async def probe_heatpump(host, port, device_id=1, timeout_s=3.0):
            self.probed.append((host, port))
            return dict(self.probe_result)

        monkeypatch.setattr(discovery, "usr_udp_discover", usr_udp_discover)
        monkeypatch.setattr(discovery, "local_subnet_hosts", local_subnet_hosts)
        monkeypatch.setattr(discovery, "tcp_scan", tcp_scan)
        monkeypatch.setattr(discovery, "get_mac_for_ip", get_mac_for_ip)
        monkeypatch.setattr(discovery, "probe_heatpump", probe_heatpump)
        return self


def by_ip(results):
    return {e["ip"]: e for e in results}


async def test_arp_mac_wins_and_broadcast_mac_kept_on_real_mismatch(monkeypatch):
    # The real W610: broadcast reports the base MAC, ARP sees base+1 on the station side.
    FakeNet(udp={"10.0.0.5": "d4:ad:20:e3:67:e4"},
            open_ports=[("10.0.0.5", 8899)],
            arp={"10.0.0.5": "d4:ad:20:e3:67:e5"}).install(monkeypatch)
    e = by_ip(await discovery.discover())["10.0.0.5"]
    assert e["mac"] == "d4:ad:20:e3:67:e5"
    assert e["broadcast_mac"] == "d4:ad:20:e3:67:e4"
    assert e["source"] == "usr-broadcast"


async def test_no_broadcast_mac_when_macs_match_after_normalising(monkeypatch):
    # macOS arp prints unpadded upper/lower octets; same MAC, so no discrepancy recorded.
    FakeNet(udp={"10.0.0.5": "d8:b0:4c:01:02:03"},
            open_ports=[("10.0.0.5", 8899)],
            arp={"10.0.0.5": "D8:B0:4C:1:2:3"}).install(monkeypatch)
    e = by_ip(await discovery.discover())["10.0.0.5"]
    assert "broadcast_mac" not in e
    assert e["mac"] == "D8:B0:4C:1:2:3"  # ARP string adopted as-is


async def test_falls_back_to_broadcast_mac_when_arp_unresolvable(monkeypatch):
    FakeNet(udp={"10.0.0.5": "d8:b0:4c:01:02:03"}).install(monkeypatch)
    e = by_ip(await discovery.discover())["10.0.0.5"]
    assert e["mac"] == "d8:b0:4c:01:02:03"
    assert "broadcast_mac" not in e


async def test_scan_only_candidate_gets_arp_mac_without_broadcast_mac(monkeypatch):
    FakeNet(open_ports=[("10.0.0.6", 8899)],
            arp={"10.0.0.6": "aa:bb:cc:dd:ee:ff"}).install(monkeypatch)
    e = by_ip(await discovery.discover())["10.0.0.6"]
    assert e["mac"] == "aa:bb:cc:dd:ee:ff"
    assert e["source"] == "port-scan"
    assert "broadcast_mac" not in e


async def test_skip_probe_pairs_never_scanned_or_probed_but_stay_candidates(monkeypatch):
    live = ("10.0.0.7", 8899)
    net = FakeNet(open_ports=[live, ("10.0.0.8", 8899)]).install(monkeypatch)
    out = by_ip(await discovery.discover(skip_probe={live}))

    assert net.scan_calls[0]["exclude"] == {live}
    assert live not in net.probed
    assert ("10.0.0.8", 8899) in net.probed

    skipped = out["10.0.0.7"]
    assert skipped["probe"] is None
    assert skipped["probe_skipped"] == "connected to this bridge"
    assert skipped["port"] == 8899
    assert out["10.0.0.8"]["probe"] == {"inlet_c": 40}
    assert "probe_skipped" not in out["10.0.0.8"]


async def test_skip_probe_entry_also_seen_on_broadcast(monkeypatch):
    live = ("10.0.0.7", 8899)
    net = FakeNet(udp={"10.0.0.7": "d8:b0:4c:01:02:03"}).install(monkeypatch)
    e = by_ip(await discovery.discover(skip_probe={live}))["10.0.0.7"]
    assert e["source"] == "usr-broadcast"
    assert e["probe"] is None and e["probe_skipped"]
    assert net.probed == []


async def test_probe_false_leaves_probe_unset(monkeypatch):
    net = FakeNet(open_ports=[("10.0.0.8", 8899)]).install(monkeypatch)
    e = by_ip(await discovery.discover(probe=False))["10.0.0.8"]
    assert "probe" not in e
    assert net.probed == []


async def test_extra_ports_reach_the_scan(monkeypatch):
    net = FakeNet().install(monkeypatch)
    await discovery.discover(extra_ports={502})
    assert net.scan_calls[0]["ports"] == {8899, 502}


async def test_output_sorted_by_ip(monkeypatch):
    FakeNet(udp={"10.0.0.9": "aa:aa:aa:aa:aa:09", "10.0.0.3": "aa:aa:aa:aa:aa:03"},
            open_ports=[("10.0.0.7", 8899), ("10.0.0.1", 8899)]).install(monkeypatch)
    ips = [e["ip"] for e in await discovery.discover()]
    assert ips == ["10.0.0.1", "10.0.0.3", "10.0.0.7", "10.0.0.9"]


# --- probe_heatpump signed temps (no socket: fake Modbus client) ----------------------

class _Resp:
    def __init__(self, regs, error=False):
        self.registers = regs
        self._error = error

    def isError(self):
        return self._error


def _fake_client(regs, connect=True, error=False):
    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def connect(self):
            return connect

        async def read_holding_registers(self, address, count, device_id):
            assert (address, count) == (2050, 3)
            return _Resp(regs, error)

        def close(self):
            pass
    return FakeClient


async def test_probe_decodes_negative_temps(monkeypatch):
    # expected values follow TEMP_SCALE so this checks sign decoding, not the
    # scale constant (commissioning may set it to 0.1 on hardware day)
    monkeypatch.setattr(discovery, "AsyncModbusTcpClient", _fake_client([45, 0xFFFB, 0x7FFF]))
    assert await discovery.probe_heatpump("10.0.0.5", 8899) == {
        "inlet_c": 45 * TEMP_SCALE, "outlet_c": -5 * TEMP_SCALE,
        "ambient_c": 32767 * TEMP_SCALE}


async def test_probe_none_on_error_or_no_connect(monkeypatch):
    monkeypatch.setattr(discovery, "AsyncModbusTcpClient", _fake_client([0, 0, 0], error=True))
    assert await discovery.probe_heatpump("10.0.0.5", 8899) is None
    monkeypatch.setattr(discovery, "AsyncModbusTcpClient", _fake_client([0, 0, 0], connect=False))
    assert await discovery.probe_heatpump("10.0.0.5", 8899) is None
