# @purpose: Best-effort push alerts (ntfy) + external dead-man heartbeat. Addresses the
# fusion audit's risk 3: pull-only alerting misses a 2am fault, and an alert path that
# shares fate with the Pi can't report the ice-storm outage you most need to hear. No new
# dependencies (urllib in a thread); never raises into the caller.
from __future__ import annotations

import asyncio
import json
import logging
import urllib.request

log = logging.getLogger(__name__)

# Owner alert policy (knowledge/reference/alert-policy.md, 2026-10-20) — the same tiers as the planner and hub:
#   page       6bb phone push + email   the house is at risk, or a human must act soon
#   attention  email only               worth a look this week
#   record     ntfy log only            the events table, the dashboard and the Monday digest carry it
# ntfy (which nobody subscribes to) gets everything as the log. An all-clear carries the tier of the alert it
# resolves, and only a page gets one. ntfy priority only tunes loudness; it never picks a channel.
TIERS = ("page", "attention", "record")


def route(tier: str, resolved: bool = False) -> tuple[bool, bool]:
    """(push, email) for a tier. Raises on an unknown tier, so a typo can never silently drop a page."""
    if tier not in TIERS:
        raise ValueError(f"unknown alert tier {tier!r}")
    if resolved:
        return (tier == "page", tier == "page")
    return (tier == "page", tier != "record")


def tier_subject(title: str, tier: str, resolved: bool = False) -> str:
    core = title.strip().lstrip("⚠✓✅🚨\ufe0f ").strip() or title.strip()
    if resolved:
        return f"✅ A2W RESOLVED — {core}"
    if tier == "page":
        return f"🚨 A2W — {core}"
    if tier == "attention":
        return f"A2W needs a look — {core}"
    return core if core.lower().startswith("a2w") else f"A2W — {core}"


async def alert(cfg, *, tier: str, title: str, message: str, priority: str = "default", tags: str = "",
                resolved: bool = False, tag: str = "") -> None:
    """The one way the bridge tells anyone anything. Never raises (bad tier aside)."""
    push, mail = route(tier, resolved)
    log.info("alert %s%s: %s (push %s, email %s)", tier, " resolved" if resolved else "", title.strip(), push, mail)
    jobs = [ntfy(cfg, title=title, message=message, priority=priority, tags=tags)]
    if push:
        # the tag names the incident, so its all-clear replaces it on the phone
        jobs.append(sixbb_push(cfg, title=title, message=message,
                               priority="default" if resolved else ("urgent" if priority == "urgent" else "high"), tag=tag))
    if mail:
        jobs.append(email(cfg, subject=tier_subject(title, tier, resolved), body=message))
    await asyncio.gather(*jobs, return_exceptions=True)


async def sixbb_push(cfg, *, title: str, message: str, priority: str, tag: str = "") -> bool:
    """Push to the owner's devices through 6bb's /api/external/alert. No-op unless configured; never raises."""
    if not cfg or not getattr(cfg, "sixbb_alert_url", None) or not getattr(cfg, "sixbb_alert_key", None):
        return False
    slug = "".join(ch if ch.isalnum() else "-" for ch in title.lower()).strip("-")
    payload = json.dumps({"source": "a2w-pi", "title": title.strip(), "body": message, "priority": priority,
                          "tag": tag or "a2w-pi-" + "-".join(p for p in slug.split("-") if p)[:44]}).encode("utf-8")

    def _post() -> bool:
        try:
            req = urllib.request.Request(
                cfg.sixbb_alert_url, data=payload, method="POST",
                headers={"Authorization": f"Bearer {cfg.sixbb_alert_key}", "Content-Type": "application/json",
                         "User-Agent": "a2w-bridge/1.0"})
            urllib.request.urlopen(req, timeout=10).read()
            return True
        except Exception as exc:  # noqa: BLE001 — alerting must never break the poller
            log.warning("6bb push failed: %s", exc)
            return False

    return await asyncio.to_thread(_post)


async def ntfy(cfg, *, title: str, message: str, priority: str = "default",
               tags: str = "") -> None:
    """Fire-and-forget post to the ntfy topic — the alert LOG. Reaches no human; use alert() for that."""
    await _ntfy_post(cfg, title=title, message=message, priority=priority, tags=tags)


async def _ntfy_post(cfg, *, title: str, message: str, priority: str, tags: str) -> None:
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


async def email(cfg, *, subject: str, body: str) -> None:
    """Fire-and-forget email alert via Resend. No-op unless configured. The CALLER decides
    what deserves email — this sends whenever invoked. Subject/body are JSON (UTF-8), so
    emoji are fine here."""
    if not cfg or not cfg.resend_api_key or not cfg.resend_to:
        return
    payload = json.dumps({
        "from": cfg.resend_from,
        "to": [cfg.resend_to],
        "subject": subject,
        "text": body,
    }).encode("utf-8")

    def _post():
        try:
            # Cloudflare in front of Resend rejects the default Python-urllib browser
            # signature (403, CF error 1010) — every bridge email silently failed on it
            # until diagnosed 2026-08-06. Any honest non-urllib UA passes; curl always did.
            req = urllib.request.Request(
                "https://api.resend.com/emails", data=payload, method="POST",
                headers={"Authorization": f"Bearer {cfg.resend_api_key}",
                         "Content-Type": "application/json",
                         "User-Agent": "a2w-bridge/1.0"})
            urllib.request.urlopen(req, timeout=10).read()
        except Exception as exc:  # noqa: BLE001 — alerting must never break the poller
            log.warning("resend email failed: %s", exc)

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
