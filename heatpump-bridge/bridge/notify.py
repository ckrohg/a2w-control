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
    # HTTP headers are latin-1: an emoji in the title (our alerts prefix ✓/⚠) makes urllib
    # raise UnicodeEncodeError, which the except below would swallow — so the alert would
    # SILENTLY never send. Strip the title to latin-1; the emoji is carried by `tags`
    # (warning -> ⚠️, white_check_mark -> ✓), which ntfy renders anyway. Body stays UTF-8.
    safe_title = title.encode("latin-1", "ignore").decode("latin-1").strip()

    def _post():
        try:
            req = urllib.request.Request(
                url, data=message.encode("utf-8"), method="POST",
                headers={"Title": safe_title, "Priority": priority, "Tags": tags})
            urllib.request.urlopen(req, timeout=8).read()
        except Exception as exc:  # noqa: BLE001 — alerting must never break the poller
            log.warning("ntfy push failed: %s", exc)

    await asyncio.to_thread(_post)


async def heartbeat(url: str | None, fail: bool = False) -> None:
    """Ping an external dead-man monitor (healthchecks.io etc). No-op if not configured.
    fail=True pings the monitor's /fail endpoint so an ACTIVE fault/offline condition also
    alarms through the reliable heartbeat channel — not only through best-effort ntfy
    (re-audit fix 3: level-based, so a single dropped push can't lose a 2am fault)."""
    if not url:
        return
    target = url.rstrip("/") + "/fail" if fail else url

    def _get():
        try:
            urllib.request.urlopen(target, timeout=8).read()
        except Exception:  # noqa: BLE001
            pass

    await asyncio.to_thread(_get)
