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


# --- email layout: the same as planner/src/alertemail.ts (owner 2026-10-20: "really hard to skim") ------------------
# tier banner in words → headline → WHAT TO DO box → facts table → details (small, grey) → footer. Tables and inline
# styles only, light surface; the plain-text body is always sent alongside.
_INK, _INK2, _MUTED, _RULE, _TILE, _LINK = "#0b0b0b", "#52514e", "#8a8984", "#e8e7e3", "#f4f5f7", "#2a78d6"
_BANNERS = {"page": ("🚨 URGENT · act now", "#ffffff", "#b3261e"),
            "attention": ("NEEDS A LOOK · this week", "#6b4400", "#fff1d6"),
            "record": ("FYI", "#33322f", "#eeeeec")}
_RESOLVED = ("✅ RESOLVED · no action needed", "#055c05", "#e6f4e6")
_WHY = {"page": "You got this because the house may lose heat or hot water, or something needs a hand at the panel.",
        "attention": "You got this because something should be looked at this week. Nothing is wrong right now.",
        "record": "Informational."}
DASH_URL = "https://a2w-analytics-mirror.vercel.app"


def clean_title(t: str) -> str:
    core = t.strip().lstrip("⚠✓✅🚨\ufe0f ").strip()
    for label in ("A2W:", "A2W —", "A2W -"):
        if core.startswith(label):
            core = core[len(label):].strip()
    return core or t.strip()


def render_html(*, tier: str, title: str, message: str, resolved: bool = False, action: str | None = None,
                facts: list[tuple[str, str]] | None = None, source: str = "A2W Pi", at: float | None = None) -> str:
    from html import escape as e
    import time as _t
    label, fg, bg = _RESOLVED if resolved else _BANNERS[tier]
    when = _t.strftime("%a, %b %-d, %-I:%M %p", _t.localtime(at or _t.time()))
    parts = [f'<div style="display:inline-block;background:{bg};color:{fg};font-size:12px;font-weight:700;'
             f'letter-spacing:.04em;padding:5px 9px;border-radius:4px;margin:4px 0 10px">{e(label)}</div>',
             f'<h1 style="font-size:21px;line-height:1.25;margin:0 0 14px;font-weight:700">{e(clean_title(title))}</h1>']
    if action and not resolved:
        edge = "#b3261e" if tier == "page" else "#c98a00"
        parts.append(f'<div style="border-left:4px solid {edge};background:{_TILE};padding:10px 12px;margin:0 0 16px;'
                     f'border-radius:0 6px 6px 0"><div style="font-size:12px;font-weight:700;letter-spacing:.04em;'
                     f'color:{_INK2};margin-bottom:3px">WHAT TO DO</div><div style="font-size:16px;line-height:1.4">'
                     f'{e(action)}</div></div>')
    if facts:
        rows = "".join(
            f'<tr><td style="padding:6px 12px 6px 0;color:{_INK2};font-size:14px;white-space:nowrap;vertical-align:top;'
            f'border-bottom:1px solid {_RULE}">{e(k)}</td><td style="padding:6px 0;font-size:15px;font-weight:600;'
            f'vertical-align:top;border-bottom:1px solid {_RULE}">{e(v)}</td></tr>' for k, v in facts)
        parts.append(f'<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;'
                     f'width:100%;margin:0 0 16px">{rows}</table>')
    if message.strip():
        paras = "".join(f'<p style="margin:0 0 10px;font-size:13px;line-height:1.45;color:{_INK2}">'
                        f'{e(p).replace(chr(10), "<br>")}</p>' for p in message.strip().split("\n\n") if p.strip())
        parts.append(f'<div style="font-size:12px;font-weight:700;letter-spacing:.04em;color:{_MUTED};margin:0 0 4px">'
                     f'DETAILS</div>{paras}')
    why = "This closes an alert you were sent earlier." if resolved else _WHY[tier]
    parts.append(f'<div style="border-top:1px solid {_RULE};margin-top:18px;padding-top:10px;font-size:12px;'
                 f'line-height:1.5;color:{_MUTED}">{e(when)} · {e(source)} · <a href="{DASH_URL}" style="color:{_LINK}">'
                 f'Dashboard</a><br>{e(why)} Everything else is in the Monday digest.</div>')
    return ('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,'
            'initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;padding:0;'
            'background:#ffffff"><div style="max-width:560px;margin:0 auto;padding:12px 14px;font-family:-apple-system,'
            f"BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:{_INK}\">" + "".join(parts) + "</div></body></html>")


async def alert(cfg, *, tier: str, title: str, message: str, priority: str = "default", tags: str = "",
                resolved: bool = False, tag: str = "", action: str | None = None,
                facts: list[tuple[str, str]] | None = None) -> None:
    """The one way the bridge tells anyone anything. Never raises (bad tier aside). `action` and `facts` shape the
    email (render_html): what to do, boxed first, then a short label/value table."""
    push, mail = route(tier, resolved)
    log.info("alert %s%s: %s (push %s, email %s)", tier, " resolved" if resolved else "", title.strip(), push, mail)
    jobs = [ntfy(cfg, title=title, message=message, priority=priority, tags=tags)]
    if push:
        # the tag names the incident, so its all-clear replaces it on the phone
        jobs.append(sixbb_push(cfg, title=title, message=message,
                               priority="default" if resolved else ("urgent" if priority == "urgent" else "high"), tag=tag))
    if mail:
        jobs.append(email(cfg, subject=tier_subject(title, tier, resolved), body=message,
                          html=render_html(tier=tier, title=title, message=message, resolved=resolved,
                                           action=action, facts=facts)))
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


async def email(cfg, *, subject: str, body: str, html: str | None = None) -> None:
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
        **({"html": html} if html else {}),
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
