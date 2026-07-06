# @purpose: Best-effort push alerts (ntfy) + external dead-man heartbeat. Addresses the
# fusion audit's risk 3: pull-only alerting misses a 2am fault, and an alert path that
# shares fate with the Pi can't report the ice-storm outage you most need to hear. No new
# dependencies (urllib in a thread); never raises into the caller.
from __future__ import annotations

import asyncio
import logging
import urllib.request

log = logging.getLogger(__name__)


async def ntfy(cfg, *, title: str, message: str, priority: str = "default",
               tags: str = "") -> None:
    """Fire-and-forget push to an ntfy topic. No-op if not configured."""
    if not cfg or not cfg.ntfy_topic:
        return
    url = f"{cfg.ntfy_server.rstrip('/')}/{cfg.ntfy_topic}"

    def _post():
        try:
            req = urllib.request.Request(
                url, data=message.encode("utf-8"), method="POST",
                headers={"Title": title, "Priority": priority, "Tags": tags})
            urllib.request.urlopen(req, timeout=8).read()
        except Exception as exc:  # noqa: BLE001 — alerting must never break the poller
            log.warning("ntfy push failed: %s", exc)

    await asyncio.to_thread(_post)


async def heartbeat(url: str | None) -> None:
    """Ping an external dead-man monitor (healthchecks.io etc). No-op if not configured."""
    if not url:
        return

    def _get():
        try:
            urllib.request.urlopen(url, timeout=8).read()
        except Exception:  # noqa: BLE001
            pass

    await asyncio.to_thread(_get)
