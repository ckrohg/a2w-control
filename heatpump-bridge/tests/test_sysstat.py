# @purpose: Unit tests for the stdlib system-health sampler (bridge/sysstat.py) and the
# system_stats store round-trip + retention. Cross-platform by design: Linux-only metrics
# (CPU%, temp, /proc mem) may be None on the macOS dev box, so assertions accept None-or-value
# rather than requiring /proc — disk (shutil) is the one field guaranteed everywhere.
from __future__ import annotations

from bridge.store import Store, _SYSTEM_COLS
from bridge.sysstat import SystemStats

EXPECTED_KEYS = {"ts", "cpu_pct", "load1", "load5", "load15", "ncpu", "mem_used_pct",
                 "mem_total_mb", "mem_avail_mb", "disk_used_pct", "disk_free_gb",
                 "disk_total_gb", "cpu_temp_c", "uptime_s"}


def test_read_returns_full_key_set():
    s = SystemStats().read()
    assert set(s) == EXPECTED_KEYS
    # disk is measured via shutil (macOS + Linux), so it is always populated
    assert s["disk_total_gb"] and s["disk_total_gb"] > 0
    assert s["disk_used_pct"] is not None and 0 <= s["disk_used_pct"] <= 100


def test_values_are_json_safe_and_cpu_needs_two_reads():
    s = SystemStats().read()
    for v in s.values():
        assert v is None or isinstance(v, (int, float))
    # first read has no previous /proc/stat baseline → cpu_pct can't be a delta yet
    assert s["cpu_pct"] is None


def test_cpu_pct_bounded_after_two_reads():
    reader = SystemStats()
    reader.read()
    cpu = reader.read()["cpu_pct"]  # None off-Linux, else a real busy fraction
    assert cpu is None or 0.0 <= cpu <= 100.0


def test_store_cols_cover_exactly_the_sampler_fields():
    # a drift here (new metric added to read() but not to _SYSTEM_COLS) would silently drop
    # the column on insert — this guards the two lists staying in lockstep.
    assert set(_SYSTEM_COLS) == EXPECTED_KEYS


async def test_store_round_trip_and_prune(tmp_path):
    store = Store(str(tmp_path / "sys.db"))
    await store.open()
    try:
        assert await store.get_system_latest() is None  # empty before any sample

        sample = SystemStats(str(tmp_path)).read()
        await store.add_system_stat(sample)

        latest = await store.get_system_latest()
        assert latest is not None
        assert set(latest) == set(_SYSTEM_COLS)
        assert latest["disk_total_gb"] == sample["disk_total_gb"]

        assert len(await store.get_system_history(24)) == 1

        # retention: a 0-day window drops every row (ts is already in the past)
        await store.prune(system_days=0)
        assert await store.get_system_latest() is None
        assert await store.get_system_history(24) == []
    finally:
        await store.close()


async def test_health_alerts_latch_clear_and_hysteresis(monkeypatch, tmp_path):
    from bridge import notify
    from bridge.config import NotifyConfig
    from bridge.scheduler import Scheduler

    pushes: list[tuple[str, str]] = []

    async def fake_ntfy(cfg, *, title, message, priority="default", tags=""):
        pushes.append((title, priority))

    async def fake_email(cfg, **kw):
        pass

    monkeypatch.setattr(notify, "ntfy", fake_ntfy)
    monkeypatch.setattr(notify, "email", fake_email)

    store = Store(str(tmp_path / "a.db"))
    await store.open()
    try:
        sched = Scheduler(store, {}, notifications=NotifyConfig())

        # cool + roomy → silence
        await sched._evaluate_health_alerts({"cpu_temp_c": 55, "disk_used_pct": 30})
        assert pushes == [] and sched._health_alerts == set()

        # crosses hot → exactly one high-priority raise
        await sched._evaluate_health_alerts({"cpu_temp_c": 83, "disk_used_pct": 30})
        assert len(pushes) == 1 and pushes[0][1] == "high" and "cpu_temp" in sched._health_alerts

        # still hot but inside the hysteresis gap (75–80) → no repeat push
        await sched._evaluate_health_alerts({"cpu_temp_c": 78, "disk_used_pct": 30})
        assert len(pushes) == 1

        # drops below the clear point → one recovery push, latch released
        await sched._evaluate_health_alerts({"cpu_temp_c": 70, "disk_used_pct": 30})
        assert len(pushes) == 2 and pushes[1][1] == "default" and "cpu_temp" not in sched._health_alerts

        # disk fills (5% free) → independent raise
        await sched._evaluate_health_alerts({"cpu_temp_c": 70, "disk_used_pct": 95,
                                             "disk_free_gb": 2.0})
        assert len(pushes) == 3 and "disk_low" in sched._health_alerts

        # missing metrics never raise
        await sched._evaluate_health_alerts({"cpu_temp_c": None, "disk_used_pct": None})
        assert len(pushes) == 3
    finally:
        await store.close()
