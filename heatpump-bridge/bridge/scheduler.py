# @purpose: Daily on/off timers — the bridge-side superset of the wall controller's two
# timer groups (§2.7): any number of rules, per pump, surviving reboots (SQLite), firing
# through the same guarded write path as a human tap (source="schedule", audited).
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from datetime import datetime
from pathlib import Path

from . import notify
from .config import NotifyConfig
from .guardrails import GuardrailError
from .poller import PumpPoller
from .store import Store
from .sysstat import SystemStats

log = logging.getLogger(__name__)

CHECK_INTERVAL_S = 20      # < 1 minute so no HH:MM slot is ever skipped
MAINTENANCE_HHMM = "03:30"  # nightly backup + retention pruning
BACKUPS_KEEP = 7
SYSTEM_SAMPLE_S = 60       # Pi health cadence — ~1 row/min, pruned to 90 days

# Health-alert thresholds (Raspberry Pi 5). Each has a raise + a clear point: the gap is
# hysteresis so a metric hovering at the edge can't flap a push every minute. The SoC starts
# thermal-throttling ~80–85°C; free disk on the SD/NVMe is the one resource that grows.
TEMP_ALERT_C = 80.0
TEMP_CLEAR_C = 75.0
DISK_FREE_ALERT_PCT = 10.0
DISK_FREE_CLEAR_PCT = 13.0


class Scheduler:
    def __init__(self, store: Store, pollers: dict[str, PumpPoller],
                 heartbeat_url: str | None = None,
                 notifications: NotifyConfig | None = None):
        self.store = store
        self.pollers = pollers
        self.heartbeat_url = heartbeat_url
        self.notifications = notifications
        self._task: asyncio.Task | None = None
        self._last_maintenance_date: str | None = None
        # One sampler for the process lifetime (CPU% is a delta across reads); disk usage is
        # measured on the volume that holds the DB, which is what actually fills up.
        self._sysstat = SystemStats(str(Path(store.path).parent))
        self._last_sysstat = 0.0
        # Latched health conditions (e.g. "cpu_temp", "disk_low") — push once on crossing in,
        # once on recovery, and hold the dead-man heartbeat to /fail while any is active.
        self._health_alerts: set[str] = set()

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name="scheduler")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _run(self) -> None:
        while True:
            try:
                await self.check_once(datetime.now())
            except Exception:
                log.exception("scheduler check failed")
            await self._sample_system()
            # external dead-man: ping every cycle so silence (Pi/WiFi/power dead) alarms;
            # drive it to /fail while any pump is offline or in a high/critical fault, so
            # the reliable heartbeat channel doubles as the fault alarm
            unhealthy = bool(self._health_alerts) or any(
                (not p.online) or any(
                    f["severity"] in ("high", "critical")
                    for f in p.snapshot.get("active_faults", []))
                for p in self.pollers.values())
            await notify.heartbeat(self.heartbeat_url, fail=unhealthy)
            await asyncio.sleep(CHECK_INTERVAL_S)

    async def check_once(self, now: datetime) -> None:
        """Fire every enabled rule matching this minute (at most once per rule per day)."""
        # optimizer-lease watchdog: revert to baseline if a remote setpoint lease lapses
        ts = now.timestamp()
        for poller in self.pollers.values():
            await poller.check_lease(ts)
        if (now.strftime("%H:%M") == MAINTENANCE_HHMM
                and self._last_maintenance_date != now.strftime("%Y-%m-%d")):
            self._last_maintenance_date = now.strftime("%Y-%m-%d")
            await self.run_maintenance(now)
        due = await self.store.due_schedules(now.strftime("%H:%M"), now.strftime("%Y-%m-%d"))
        # catch-up semantics: mark ALL due rules fired, but execute only the LATEST per
        # pump — after downtime spanning "on at 06:00, off at 09:00", the net state
        # (off) is what fires, and the power-write rate limiter is never asked to run
        # a burst of contradictory writes.
        latest_per_pump: dict[str, dict] = {}
        for rule in due:
            # mark first: a failing write must not retry every 20s for the whole minute
            await self.store.mark_schedule_fired(rule["id"], now.strftime("%Y-%m-%d"))
            latest_per_pump[rule["pump_id"]] = rule  # due is ordered by time_hhmm
        for rule in latest_per_pump.values():
            poller = self.pollers.get(rule["pump_id"])
            if not poller:
                continue
            try:
                await self._fire(poller, rule["action"])
                log.info("schedule %s: %s -> %s (%s)", rule["id"], rule["pump_id"],
                         rule["action"], rule["time_hhmm"])
            except GuardrailError as exc:
                # already audited by the write path; nothing else to do
                log.warning("schedule %s failed: %s", rule["id"], exc)

    async def _sample_system(self) -> None:
        """Record one Pi-health row every ~SYSTEM_SAMPLE_S, then check alert thresholds.
        Best-effort: a sampling error must never disturb the heat-pump control loop this
        scheduler also drives."""
        mono = time.monotonic()
        if mono - self._last_sysstat < SYSTEM_SAMPLE_S:
            return
        self._last_sysstat = mono
        try:
            sample = self._sysstat.read()
            await self.store.add_system_stat(sample)
            await self._evaluate_health_alerts(sample)
        except Exception:
            log.exception("system stat sample failed")

    async def _evaluate_health_alerts(self, s: dict) -> None:
        """Push once when a metric crosses INTO alert, once when it recovers (with hysteresis).
        A latched alert also drives the dead-man heartbeat to /fail (see _run), so the reliable
        channel alarms even if the best-effort push is dropped — same level-based design as the
        pump-fault alerts."""
        temp = s.get("cpu_temp_c")
        used = s.get("disk_used_pct")
        disk_free_pct = None if used is None else 100.0 - used
        free_gb = s.get("disk_free_gb")

        await self._health_alert(
            "cpu_temp",
            raise_now=temp is not None and temp >= TEMP_ALERT_C,
            clear_now=temp is not None and temp < TEMP_CLEAR_C,
            title="⚠ a2w Pi running hot",
            message=(f"CPU {temp:.0f}°C — throttles ~80°C. Check ventilation/load."
                     if temp is not None else ""),
            clear_title="✓ a2w Pi cooled down",
            clear_message=f"CPU back to {temp:.0f}°C." if temp is not None else "",
        )
        await self._health_alert(
            "disk_low",
            raise_now=disk_free_pct is not None and disk_free_pct <= DISK_FREE_ALERT_PCT,
            clear_now=disk_free_pct is not None and disk_free_pct >= DISK_FREE_CLEAR_PCT,
            title="⚠ a2w Pi disk almost full",
            message=(f"Only {disk_free_pct:.0f}% free ({free_gb} GB) on the DB volume."
                     if disk_free_pct is not None else ""),
            clear_title="✓ a2w Pi disk recovered",
            clear_message=(f"{disk_free_pct:.0f}% free again." if disk_free_pct is not None else ""),
        )

    async def _health_alert(self, key: str, *, raise_now: bool, clear_now: bool,
                            title: str, message: str, clear_title: str,
                            clear_message: str) -> None:
        active = key in self._health_alerts
        if raise_now and not active:
            self._health_alerts.add(key)
            await self._push_alert(title, message, "high")  # high → also emails (sticky)
        elif clear_now and active:
            self._health_alerts.discard(key)
            await self._push_alert(clear_title, clear_message, "default")  # recovery: push-only

    async def _push_alert(self, title: str, message: str, priority: str) -> None:
        tags = "warning" if title.startswith("⚠") else "white_check_mark"
        await notify.ntfy(self.notifications, title=title, message=message,
                          priority=priority, tags=tags)
        await notify.email(self.notifications, subject=title, body=message, priority=priority)

    async def _fire(self, poller: PumpPoller, action: str) -> None:
        """Execute a timer. Under unattended-write restriction (default), the scheduler
        NEVER powers a pump off — an "off" timer sets a setback setpoint (unit keeps
        running, can't latch a cold state if connectivity then drops); "on" powers on and
        optionally sets a comfort setpoint. Powering ON is always safe (toward heat)."""
        g = poller.app_cfg.guardrails
        if not g.restrict_unattended_writes:
            await poller.write_power(action == "on", source="schedule")
            return
        if action == "on":
            await poller.write_power(True, source="schedule")
            if g.comfort_setpoint_c is not None:
                await poller.write_setpoint(g.comfort_setpoint_c, source="schedule",
                                            unattended=True)
        else:  # "off" becomes a setback, never a shutdown
            await poller.write_setpoint(g.setback_setpoint_c, source="schedule",
                                        unattended=True)

    async def run_maintenance(self, now: datetime) -> None:
        """Nightly: consistent DB backup (rotated) + retention pruning. A dead SD card
        costs at most a day of history plus a bootstrap re-run."""
        backups = Path(self.store.path).parent / "backups"
        backups.mkdir(exist_ok=True)
        dest = backups / f"bridge-{now.strftime('%Y%m%d')}.db"
        try:
            await self.store.backup(str(dest))
            for old in sorted(backups.glob("bridge-*.db"))[:-BACKUPS_KEEP]:
                old.unlink()
            await self.store.prune()
            log.info("maintenance: backup %s written, retention pruned", dest.name)
        except Exception:
            log.exception("maintenance failed")
