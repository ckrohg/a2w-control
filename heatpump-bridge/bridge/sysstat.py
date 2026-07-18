# @purpose: Stdlib-only Pi/Linux system-health sampler — CPU%, load average, RAM, disk-free
# on the DB volume, SoC temperature, and uptime. No new dependencies (reads /proc, /sys, os,
# shutil). Degrades gracefully on the Mac dev box: Linux-only fields return None so tests and
# local dev never break. CPU% is a busy-fraction DELTA between successive read() calls, so a
# SINGLE long-lived instance must own the sampling cadence (the scheduler does — every ~60s).
from __future__ import annotations

import os
import shutil
import time


class SystemStats:
    """One sampler instance for the process lifetime. read() returns a JSON-safe dict of the
    current health metrics; every field is Optional so a missing /proc file (non-Linux, locked
    down container) never raises — the consumer just stores None for that column."""

    def __init__(self, disk_path: str = "/"):
        self.disk_path = disk_path
        self._prev_cpu: tuple[int, int] | None = None  # (total_jiffies, idle_jiffies)

    def read(self) -> dict:
        return {
            "ts": time.time(),
            "cpu_pct": self._cpu_pct(),
            **self._loadavg(),
            **self._mem(),
            **self._disk(),
            "cpu_temp_c": self._cpu_temp(),
            "uptime_s": self._uptime(),
        }

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
