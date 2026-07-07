# @purpose: Read-only analytics mirror push. Every ~60s the Pi POSTs a compact state
# snapshot to a Vercel app (analytics-mirror/) which stores the time series for a hosted
# dashboard. Deliberately OUT of the control loop: best-effort, no retries, failures
# swallowed — if the cloud is down, control and the local dashboard are unaffected. No new
# dependencies (urllib in a thread). The Pi only ever pushes OUT; it never receives
# commands from the cloud (control stays on the Funnel/API path).
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import urllib.request

from .config import AnalyticsConfig
from .poller import PumpPoller

log = logging.getLogger(__name__)


class Exporter:
    def __init__(self, cfg: AnalyticsConfig, pollers: dict[str, PumpPoller]):
        self.cfg = cfg
        self.pollers = pollers
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self.cfg.endpoint_url and self.cfg.token:
            self._task = asyncio.create_task(self._run(), name="exporter")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def _run(self) -> None:
        while True:
            try:
                await self.push_once()
            except Exception:  # noqa: BLE001 — a mirror push must never break the bridge
                log.exception("analytics push failed")
            await asyncio.sleep(self.cfg.interval_s)

    def snapshot(self) -> dict:
        """Compact per-pump state for the cloud time series — no control-relevant fields."""
        pumps = []
        for p in self.pollers.values():
            s = p.snapshot
            pumps.append({
                "id": p.cfg.id,
                "name": p.cfg.name,
                "online": bool(s.get("online")),
                "state": s.get("state", "offline"),
                "mode_kind": s.get("mode_kind"),
                "setpoint_c": s.get("setpoint_c"),
                "inlet_c": s.get("inlet_c"),
                "outlet_c": s.get("outlet_c"),
                "ambient_c": s.get("ambient_c"),
                "power_w": (s.get("power_sys1") or 0) + (s.get("power_sys2") or 0),
                "active_faults": len(s.get("active_faults", [])),
                "error_rate": p.client.stats.as_dict()["error_rate"],
            })
        return {"ts": time.time(), "pumps": pumps}

    async def push_once(self) -> None:
        if not (self.cfg.endpoint_url and self.cfg.token):
            return
        payload = json.dumps(self.snapshot()).encode("utf-8")
        url, token = self.cfg.endpoint_url, self.cfg.token

        def _post():
            try:
                req = urllib.request.Request(
                    url, data=payload, method="POST",
                    headers={"Content-Type": "application/json",
                             "Authorization": f"Bearer {token}"})
                urllib.request.urlopen(req, timeout=10).read()
            except Exception as exc:  # noqa: BLE001
                log.warning("analytics push failed: %s", exc)

        await asyncio.to_thread(_post)
