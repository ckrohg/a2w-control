# @purpose: Daily on/off timers — the bridge-side superset of the wall controller's two
# timer groups (§2.7): any number of rules, per pump, surviving reboots (SQLite), firing
# through the same guarded write path as a human tap (source="schedule", audited).
from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import datetime
from pathlib import Path

from . import notify
from .guardrails import GuardrailError
from .poller import PumpPoller
from .store import Store

log = logging.getLogger(__name__)

CHECK_INTERVAL_S = 20      # < 1 minute so no HH:MM slot is ever skipped
MAINTENANCE_HHMM = "03:30"  # nightly backup + retention pruning
BACKUPS_KEEP = 7


class Scheduler:
    def __init__(self, store: Store, pollers: dict[str, PumpPoller],
                 heartbeat_url: str | None = None):
        self.store = store
        self.pollers = pollers
        self.heartbeat_url = heartbeat_url
        self._task: asyncio.Task | None = None
        self._last_maintenance_date: str | None = None

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
            # external dead-man: ping every cycle so silence (Pi/WiFi/power dead) alarms
            await notify.heartbeat(self.heartbeat_url)
            await asyncio.sleep(CHECK_INTERVAL_S)

    async def check_once(self, now: datetime) -> None:
        """Fire every enabled rule matching this minute (at most once per rule per day)."""
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
                await poller.write_setpoint(g.comfort_setpoint_c, source="schedule")
        else:  # "off" becomes a setback, never a shutdown
            await poller.write_setpoint(g.setback_setpoint_c, source="schedule")

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
