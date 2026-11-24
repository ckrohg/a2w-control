# @purpose: Unit tests for the Wi-Fi part of the system-health sampler (bridge/sysstat.py, #76):
# /proc/net/wireless and nmcli are both faked (a temp file and a monkeypatched subprocess.run),
# so these run the same on the Mac dev box and in CI. Covers normal values, an absent
# interface, nmcli failing or timing out, the BSSID-change counter, and the store migration
# that adds the wifi_* columns to a system_stats table created before them.
from __future__ import annotations

import sqlite3
import subprocess

import pytest

from bridge import sysstat
from bridge.store import Store, _SYSTEM_COLS
from bridge.sysstat import SystemStats

PROC_TEXT = (
    "Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE\n"
    " face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22\n"
    " wlan0: 0000   45.  -65.  -256        0      0      0      0      0        0\n"
)
BSSID_A = "AA:BB:CC:DD:EE:01"
BSSID_B = "AA:BB:CC:DD:EE:02"


# @purpose: nmcli terse output with `in_use` as the associated AP (colons escaped as nmcli
# does) next to one other AP, the way the cached scan list looks on the Pi.
def nmcli_text(in_use: str, freq: int = 2437) -> str:
    esc = in_use.replace(":", "\\:")
    return (" :11\\:22\\:33\\:44\\:55\\:66:5180 MHz:40\n"
            f"*:{esc}:{freq} MHz:72\n")


# @purpose: Point the sampler at a fake /proc/net/wireless (None = file absent) and a fake
# nmcli. `nmcli` is the stdout text, or an exception instance to raise; the returned list
# records every argv so a test can assert what was (not) run.
def fake_sources(monkeypatch, tmp_path, proc: str | None, nmcli, returncode: int = 0):
    path = tmp_path / "wireless"
    if proc is not None:
        path.write_text(proc)
    monkeypatch.setattr(sysstat, "PROC_WIRELESS", str(path))
    calls: list[dict] = []

    def fake_run(argv, **kw):
        calls.append({"argv": argv, **kw})
        if isinstance(nmcli, BaseException):
            raise nmcli
        return subprocess.CompletedProcess(argv, returncode, stdout=nmcli, stderr="")

    monkeypatch.setattr(sysstat.subprocess, "run", fake_run)
    return calls


def wifi(sample: dict) -> dict:
    return {k: v for k, v in sample.items() if k.startswith("wifi_")}


def test_normal_values(monkeypatch, tmp_path):
    calls = fake_sources(monkeypatch, tmp_path, PROC_TEXT, nmcli_text(BSSID_A))
    assert wifi(SystemStats(str(tmp_path)).read()) == {
        "wifi_signal_dbm": -65, "wifi_link_quality": 45, "wifi_bssid": BSSID_A,
        "wifi_freq_mhz": 2437, "wifi_bssid_changes": 0}
    # nmcli only, on the configured interface, without a rescan, bounded at 1 s
    (call,) = calls
    assert call["argv"][0] == "nmcli" and "iw" not in call["argv"]
    assert call["argv"][-4:] == ["ifname", "wlan0", "--rescan", "no"]
    assert call["timeout"] == 1.0


def test_interface_name_is_configurable(monkeypatch, tmp_path):
    calls = fake_sources(monkeypatch, tmp_path, PROC_TEXT.replace("wlan0", "wlan1"),
                         nmcli_text(BSSID_A, freq=5180))
    s = SystemStats(str(tmp_path), wifi_iface="wlan1").read()
    assert s["wifi_signal_dbm"] == -65 and s["wifi_freq_mhz"] == 5180
    assert "wlan1" in calls[0]["argv"]


def test_interface_absent(monkeypatch, tmp_path):
    # another interface's row only, and nmcli lists no in-use AP
    fake_sources(monkeypatch, tmp_path, PROC_TEXT.replace("wlan0", "wlan9"),
                 " :11\\:22\\:33\\:44\\:55\\:66:5180 MHz:40\n")
    assert wifi(SystemStats(str(tmp_path)).read()) == {
        "wifi_signal_dbm": None, "wifi_link_quality": None, "wifi_bssid": None,
        "wifi_freq_mhz": None, "wifi_bssid_changes": 0}


def test_proc_file_absent_keeps_nmcli_fields(monkeypatch, tmp_path):
    fake_sources(monkeypatch, tmp_path, None, nmcli_text(BSSID_A))
    s = SystemStats(str(tmp_path)).read()
    assert s["wifi_signal_dbm"] is None and s["wifi_link_quality"] is None
    assert s["wifi_bssid"] == BSSID_A and s["wifi_freq_mhz"] == 2437


@pytest.mark.parametrize("failure", [
    subprocess.TimeoutExpired(cmd="nmcli", timeout=1.0),
    FileNotFoundError("nmcli"),
    PermissionError("nmcli"),
])
def test_nmcli_raising_leaves_none_and_keeps_proc_fields(monkeypatch, tmp_path, failure):
    fake_sources(monkeypatch, tmp_path, PROC_TEXT, failure)
    s = SystemStats(str(tmp_path)).read()
    assert s["wifi_bssid"] is None and s["wifi_freq_mhz"] is None
    assert s["wifi_signal_dbm"] == -65 and s["wifi_link_quality"] == 45
    assert s["disk_total_gb"] > 0  # the rest of the sample is intact


def test_nmcli_nonzero_exit_or_garbage_leaves_none(monkeypatch, tmp_path):
    fake_sources(monkeypatch, tmp_path, PROC_TEXT, nmcli_text(BSSID_A), returncode=10)
    assert SystemStats(str(tmp_path)).read()["wifi_bssid"] is None

    fake_sources(monkeypatch, tmp_path, "garbage\n wlan0: x\n", "*\n*:only-two\n\n")
    assert wifi(SystemStats(str(tmp_path)).read()) == {
        "wifi_signal_dbm": None, "wifi_link_quality": None, "wifi_bssid": None,
        "wifi_freq_mhz": None, "wifi_bssid_changes": 0}


def test_bssid_change_counter_increments_across_reads(monkeypatch, tmp_path):
    reader = SystemStats(str(tmp_path))

    fake_sources(monkeypatch, tmp_path, PROC_TEXT, nmcli_text(BSSID_A))
    assert reader.read()["wifi_bssid_changes"] == 0   # the first association is not a roam
    assert reader.read()["wifi_bssid_changes"] == 0   # same AP

    fake_sources(monkeypatch, tmp_path, PROC_TEXT, nmcli_text(BSSID_B))
    s = reader.read()
    assert s["wifi_bssid"] == BSSID_B and s["wifi_bssid_changes"] == 1

    # a blind read (nmcli timed out) neither counts nor forgets the last AP
    fake_sources(monkeypatch, tmp_path, PROC_TEXT,
                 subprocess.TimeoutExpired(cmd="nmcli", timeout=1.0))
    assert reader.read()["wifi_bssid_changes"] == 1

    fake_sources(monkeypatch, tmp_path, PROC_TEXT, nmcli_text(BSSID_B))
    assert reader.read()["wifi_bssid_changes"] == 1   # back on the same AP: no change
    fake_sources(monkeypatch, tmp_path, PROC_TEXT, nmcli_text(BSSID_A.lower()))
    assert reader.read()["wifi_bssid_changes"] == 2   # case-normalised, and a real roam


async def test_store_keeps_wifi_fields_and_migrates_an_old_table(monkeypatch, tmp_path):
    # a DB created before #76: system_stats without the wifi_* columns, one old row in it
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE system_stats (id INTEGER PRIMARY KEY, ts REAL NOT NULL, cpu_pct REAL,"
        " load1 REAL, load5 REAL, load15 REAL, ncpu INTEGER, mem_used_pct REAL,"
        " mem_total_mb INTEGER, mem_avail_mb INTEGER, disk_used_pct REAL, disk_free_gb REAL,"
        " disk_total_gb REAL, cpu_temp_c REAL, uptime_s REAL)")
    conn.execute("INSERT INTO system_stats (ts, cpu_pct) VALUES (1.0, 5.0)")
    conn.commit()
    conn.close()

    fake_sources(monkeypatch, tmp_path, PROC_TEXT, nmcli_text(BSSID_A))
    store = Store(str(db))
    await store.open()
    try:
        old = await store.get_system_latest()
        assert set(old) == set(_SYSTEM_COLS)
        assert old["cpu_pct"] == 5.0 and old["wifi_bssid"] is None

        await store.add_system_stat(SystemStats(str(tmp_path)).read())
        latest = await store.get_system_latest()
        assert latest["wifi_signal_dbm"] == -65 and latest["wifi_link_quality"] == 45
        assert latest["wifi_bssid"] == BSSID_A and latest["wifi_freq_mhz"] == 2437
        assert latest["wifi_bssid_changes"] == 0

        row = (await store.get_system_history(1))[-1]
        assert row["wifi_signal_dbm"] == -65 and row["wifi_bssid_changes"] == 0
        # beyond 48 h the 5-min rollup AVG/MAX runs over the migrated Wi-Fi columns too
        bucket = (await store.get_system_history(72))[-1]
        assert bucket["wifi_signal_dbm"] == -65 and bucket["wifi_bssid_changes"] == 0
    finally:
        await store.close()


async def test_a_failed_wifi_migration_does_not_stop_the_store_opening(monkeypatch, tmp_path):
    """#308 review: an ALTER that raises (a locked DB at restart) is logged and skipped, never fatal to the bridge."""
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE system_stats (id INTEGER PRIMARY KEY, ts REAL NOT NULL, cpu_pct REAL)")
    conn.commit()
    conn.close()
    real_connect = sqlite3.connect

    class LockedAlter:
        def __init__(self, inner): self._inner = inner
        def execute(self, sql, *a):
            if sql.startswith("ALTER TABLE system_stats"):
                raise sqlite3.OperationalError("database is locked")
            return self._inner.execute(sql, *a)
        def __getattr__(self, name): return getattr(self._inner, name)
        def __setattr__(self, name, value):
            if name == "_inner": object.__setattr__(self, name, value)
            else: setattr(self._inner, name, value)

    monkeypatch.setattr(sqlite3, "connect", lambda *a, **kw: LockedAlter(real_connect(*a, **kw)))
    store = Store(str(db))
    await store.open()   # must not raise
    await store.close()

    # reopening an already-migrated DB is a no-op
    again = Store(str(db))
    await again.open()
    await again.close()
