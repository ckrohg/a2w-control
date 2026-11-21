# @purpose: Stdlib-only Pi/Linux system-health sampler — CPU%, load average, RAM, disk-free
# on the DB volume, SoC temperature, and uptime. No new dependencies (reads /proc, /sys, os,
# shutil). Degrades gracefully on the Mac dev box: Linux-only fields return None so tests and
# local dev never break. CPU% is a busy-fraction DELTA between successive read() calls, so a
# SINGLE long-lived instance must own the sampling cadence (the scheduler does — every ~60s).
# Also samples the Pi's own Wi-Fi link (#76): signal + link quality from /proc/net/wireless,
# BSSID + frequency from nmcli (the Pi has no iw), and a count of BSSID changes (roams) seen
# by this process, so a comm flap can be attributed to the Pi's radio or ruled out.
from __future__ import annotations

import os
import re
import shutil
import subprocess
import time

WIFI_IFACE = "wlan0"                    # the Pi's only radio; SystemStats(wifi_iface=) overrides
PROC_WIRELESS = "/proc/net/wireless"    # absent on the Mac dev box and on a wired-only host
NMCLI_TIMEOUT_S = 1.0                   # the sampler must never hold its caller longer than this

_UNESCAPED_COLON = re.compile(r"(?<!\\):")


class SystemStats:
    """One sampler instance for the process lifetime. read() returns a JSON-safe dict of the
    current health metrics; every field is Optional so a missing /proc file (non-Linux, locked
    down container) never raises — the consumer just stores None for that column."""

    def __init__(self, disk_path: str = "/", wifi_iface: str = WIFI_IFACE):
        self.disk_path = disk_path
        self.wifi_iface = wifi_iface
        self._prev_cpu: tuple[int, int] | None = None  # (total_jiffies, idle_jiffies)
        self._last_bssid: str | None = None  # last BSSID seen; survives a disconnected read
        self._bssid_changes = 0

    def read(self) -> dict:
        return {
            "ts": time.time(),
            "cpu_pct": self._cpu_pct(),
            **self._loadavg(),
            **self._mem(),
            **self._disk(),
            "cpu_temp_c": self._cpu_temp(),
            "uptime_s": self._uptime(),
            **self._wifi(),
        }

    # @purpose: One Wi-Fi sample for read() (#76). Never raises; an unreadable source leaves
    # its fields None. wifi_bssid_changes counts associations to a DIFFERENT access point
    # since process start: a read with no BSSID (link down, nmcli failed) keeps the last known
    # one, so A → down → B is one change and A → down → A is none.
    def _wifi(self) -> dict:
        out = {"wifi_signal_dbm": None, "wifi_link_quality": None,
               "wifi_bssid": None, "wifi_freq_mhz": None}
        try:
            out.update(self._wifi_proc())
            out.update(self._wifi_nmcli())
            bssid = out["wifi_bssid"]
            if bssid:
                if self._last_bssid and bssid != self._last_bssid:
                    self._bssid_changes += 1
                self._last_bssid = bssid
        except Exception:  # noqa: BLE001 — a Wi-Fi read must never cost the health sample
            pass
        out["wifi_bssid_changes"] = self._bssid_changes
        return out

    # @purpose: Signal level (dBm) and link quality from the interface's /proc/net/wireless
    # row: ` wlan0: 0000   45.  -65.  -256  ...` (status, link, level, noise). Empty dict when
    # the file or the row is absent (dev Mac, radio off).
    def _wifi_proc(self) -> dict:
        try:
            with open(PROC_WIRELESS) as f:
                lines = f.readlines()
        except OSError:
            return {}
        for line in lines:
            name, sep, rest = line.partition(":")
            if not sep or name.strip() != self.wifi_iface:
                continue
            fields = rest.split()
            return {"wifi_link_quality": _int(fields[1]) if len(fields) > 1 else None,
                    "wifi_signal_dbm": _int(fields[2]) if len(fields) > 2 else None}
        return {}

    # @purpose: BSSID and frequency of the access point in use, from nmcli's cached scan list
    # (no rescan, so it is quick and does not disturb the link). Terse rows look like
    # `*:AA\:BB\:CC\:DD\:EE\:FF:2437 MHz:72`; colons inside a value are escaped. Empty dict on
    # any failure: nmcli missing, non-zero exit, the 1 s timeout, or no in-use row.
    def _wifi_nmcli(self) -> dict:
        try:
            proc = subprocess.run(
                ["nmcli", "-t", "-f", "IN-USE,BSSID,FREQ,SIGNAL", "dev", "wifi", "list",
                 "ifname", self.wifi_iface, "--rescan", "no"],
                capture_output=True, text=True, timeout=NMCLI_TIMEOUT_S,
                stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError, ValueError):
            return {}
        if proc.returncode != 0:
            return {}
        for line in (proc.stdout or "").splitlines():
            fields = _UNESCAPED_COLON.split(line)
            if len(fields) < 3 or fields[0].strip() != "*":
                continue
            bssid = fields[1].replace("\\:", ":").strip().upper()
            freq = fields[2].split()
            return {"wifi_bssid": bssid or None,
                    "wifi_freq_mhz": _int(freq[0]) if freq else None}
        return {}

    def _cpu_pct(self) -> float | None:
        """Busy fraction since the previous read, from /proc/stat aggregate line:
        `cpu  user nice system idle iowait irq softirq steal ...` (jiffies). Returns None on
        the FIRST call (a delta needs two samples) and on non-Linux."""
        try:
            with open("/proc/stat") as f:
                parts = f.readline().split()
        except OSError:
            return None
        if len(parts) < 5 or parts[0] != "cpu":
            return None
        try:
            vals = [int(x) for x in parts[1:]]
        except ValueError:
            return None
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)  # idle + iowait
        total = sum(vals)
        prev, self._prev_cpu = self._prev_cpu, (total, idle)
        if prev is None:
            return None
        d_total = total - prev[0]
        d_idle = idle - prev[1]
        if d_total <= 0:
            return None
        return round(100.0 * (d_total - d_idle) / d_total, 1)

    def _loadavg(self) -> dict:
        ncpu = os.cpu_count()
        try:
            l1, l5, l15 = os.getloadavg()  # works on Linux + macOS; not on Windows
        except (OSError, AttributeError):
            return {"load1": None, "load5": None, "load15": None, "ncpu": ncpu}
        return {"load1": round(l1, 2), "load5": round(l5, 2), "load15": round(l15, 2),
                "ncpu": ncpu}

    def _mem(self) -> dict:
        try:
            info: dict[str, int] = {}
            with open("/proc/meminfo") as f:
                for line in f:
                    key, _, rest = line.partition(":")
                    field = rest.split()
                    if field:
                        info[key] = int(field[0])  # kB
            total = info.get("MemTotal", 0)
            avail = info.get("MemAvailable", info.get("MemFree", 0))
            used_pct = round(100.0 * (total - avail) / total, 1) if total else None
            return {"mem_total_mb": round(total / 1024) if total else None,
                    "mem_avail_mb": round(avail / 1024) if total else None,
                    "mem_used_pct": used_pct}
        except (OSError, ValueError):
            return {"mem_total_mb": None, "mem_avail_mb": None, "mem_used_pct": None}

    def _disk(self) -> dict:
        try:
            u = shutil.disk_usage(self.disk_path)
        except OSError:
            return {"disk_total_gb": None, "disk_free_gb": None, "disk_used_pct": None}
        used_pct = round(100.0 * u.used / u.total, 1) if u.total else None
        return {"disk_total_gb": round(u.total / 1e9, 1),
                "disk_free_gb": round(u.free / 1e9, 1),
                "disk_used_pct": used_pct}

    def _cpu_temp(self) -> float | None:
        """Pi SoC temperature in °C, from the thermal zone (millidegrees). None off-Pi."""
        try:
            with open("/sys/class/thermal/thermal_zone0/temp") as f:
                return round(int(f.read().strip()) / 1000.0, 1)
        except (OSError, ValueError):
            return None

    def _uptime(self) -> float | None:
        try:
            with open("/proc/uptime") as f:
                return round(float(f.read().split()[0]))
        except (OSError, ValueError):
            return None


# @purpose: Parse a /proc or nmcli number that may carry a trailing dot ("-65.") or a
# fraction; None when it is not a number.
def _int(text: str) -> int | None:
    try:
        return int(float(text))
    except (ValueError, OverflowError):
        return None
