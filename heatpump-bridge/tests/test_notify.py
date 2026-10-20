# @purpose: the ntfy push path. Regression guard for the emoji-in-Title bug: HTTP headers are
# latin-1, so an emoji title (our alerts prefix ✓/⚠) made urllib raise UnicodeEncodeError,
# which the fire-and-forget except swallowed — the alert SILENTLY never sent. The title must be
# sanitized to latin-1 (emoji is carried by `tags`, which ntfy renders anyway).
from __future__ import annotations

import urllib.request

from bridge import notify
from bridge.config import NotifyConfig


class _FakeResp:
    def read(self):
        return b""


async def test_emoji_title_is_stripped_and_still_sends(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=8):
        captured["headers"] = dict(req.header_items())
        captured["url"] = req.full_url
        captured["body"] = req.data
        return _FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cfg = NotifyConfig(ntfy_topic="a2w-test", ntfy_server="http://example.invalid")

    # emoji title must NOT raise (the bug) and must still send with a latin-1-safe title
    await notify.ntfy(cfg, title="✓ Pump 1 back online", message="ok",
                      priority="low", tags="white_check_mark")

    assert captured, "ntfy never called urlopen — the alert did not send"
    assert captured["headers"]["Title"] == "Pump 1 back online"   # emoji stripped
    assert captured["headers"]["Tags"] == "white_check_mark"      # emoji carried by tags
    assert captured["body"] == b"ok"
    assert captured["url"].endswith("/a2w-test")


async def test_ntfy_noop_without_topic(monkeypatch):
    called = False

    def fake_urlopen(req, timeout=8):
        nonlocal called
        called = True
        return _FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    await notify.ntfy(NotifyConfig(), title="x", message="y")   # no topic configured
    assert called is False


async def test_resend_email_high_priority_sends_correct_request(monkeypatch):
    import json
    captured = {}

    def fake_urlopen(req, timeout=10):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["ua"] = req.get_header("User-agent")
        captured["body"] = json.loads(req.data)
        return _FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cfg = NotifyConfig(resend_api_key="re_test", resend_to="me@example.com")
    await notify.email(cfg, subject="⚠ Pump 1 offline", body="down")

    assert captured["url"] == "https://api.resend.com/emails"
    assert captured["auth"] == "Bearer re_test"
    # Cloudflare 403s (error 1010) the default Python-urllib signature — a real UA is load-bearing
    assert captured["ua"] == "a2w-bridge/1.0"
    assert captured["body"]["to"] == ["me@example.com"]
    assert captured["body"]["subject"] == "⚠ Pump 1 offline"   # emoji fine in JSON subject
    assert captured["body"]["text"] == "down"
    assert captured["body"]["from"] == "A2W Alerts <onboarding@resend.dev>"


async def test_resend_email_skips_unconfigured(monkeypatch):
    """email() sends whenever invoked — the intervention-tier decision lives at the call
    sites (poller._push email flag, scheduler priority check) — but it must still no-op
    without credentials."""
    calls = 0

    def fake_urlopen(req, timeout=10):
        nonlocal calls
        calls += 1
        return _FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    await notify.email(NotifyConfig(), subject="x", body="y")  # unconfigured
    assert calls == 0


def _channels(sent):
    out = set()
    for url, _h, _b in sent:
        out.add("6bb" if "6bb" in url else "email" if "resend" in url else "ntfy")
    return out


async def test_tiers_pick_the_channels(monkeypatch):
    """alert-policy.md: page = phone + email, attention = email, record = the ntfy log only;
    an all-clear only for a page. Priority never picks a channel."""
    sent = []

    def fake_urlopen(req, timeout=8):
        sent.append((req.full_url, dict(req.header_items()), req.data))
        return _FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cfg = NotifyConfig(ntfy_topic="a2w-test", ntfy_server="http://ntfy.invalid", resend_api_key="re_x",
                       resend_to="owner@example.invalid",
                       sixbb_alert_url="http://6bb.invalid/api/external/alert", sixbb_alert_key="k123")

    await notify.alert(cfg, tier="page", title="⚠ Heat Pump 2: E21 for 31 min", message="fault",
                       priority="high", tag="a2w-pi-fault-pump2-x")
    assert _channels(sent) == {"ntfy", "6bb", "email"}
    url, headers, body = next(s for s in sent if "6bb" in s[0])
    assert headers["Authorization"] == "Bearer k123"
    import json as _json
    p = _json.loads(body)
    assert p["source"] == "a2w-pi" and p["priority"] == "high" and p["tag"] == "a2w-pi-fault-pump2-x"
    mail = _json.loads(next(s for s in sent if "resend" in s[0])[2])
    assert mail["subject"].startswith("🚨 A2W — Heat Pump 2: E21")

    sent.clear()
    await notify.alert(cfg, tier="page", resolved=True, title="✓ Heat Pump 2: E21 cleared", message="ok",
                       tag="a2w-pi-fault-pump2-x")
    assert _channels(sent) == {"ntfy", "6bb", "email"}, "a page's all-clear replaces it on the phone"
    assert _json.loads(next(s for s in sent if "6bb" in s[0])[2])["tag"] == "a2w-pi-fault-pump2-x"

    sent.clear()
    await notify.alert(cfg, tier="attention", title="Pi disk almost full", message="x", priority="urgent")
    assert _channels(sent) == {"ntfy", "email"}, "attention never reaches the phone, whatever its priority"

    sent.clear()
    await notify.alert(cfg, tier="attention", resolved=True, title="Pi disk recovered", message="x")
    assert _channels(sent) == {"ntfy"}

    sent.clear()
    await notify.alert(cfg, tier="record", title="✓ Heat Pump 1 back online", message="x", priority="high",
                       tags="white_check_mark")
    assert _channels(sent) == {"ntfy"}, "record: the log only, even at high priority with a check-mark tag"

    import pytest
    with pytest.raises(ValueError):
        notify.route("loud")


async def test_routine_push_does_not_reach_6bb(monkeypatch):
    sent = []
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=8: sent.append(req.full_url) or _FakeResp())
    cfg = NotifyConfig(ntfy_topic="a2w-test", ntfy_server="http://ntfy.invalid",
                       sixbb_alert_url="http://6bb.invalid/api/external/alert", sixbb_alert_key="k123")
    await notify.ntfy(cfg, title="⚠ Heat Pump 2: E21", message="fault", priority="urgent", tags="warning")
    assert sent == ["http://ntfy.invalid/a2w-test"]               # ntfy() is the log: never the phone


async def test_6bb_failure_never_raises_and_ntfy_still_sends(monkeypatch):
    sent = []

    def fake_urlopen(req, timeout=8):
        if "6bb" in req.full_url:
            raise OSError("6bb down")
        sent.append(req.full_url)
        return _FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cfg = NotifyConfig(ntfy_topic="a2w-test", ntfy_server="http://ntfy.invalid",
                       sixbb_alert_url="http://6bb.invalid/x", sixbb_alert_key="k")
    await notify.alert(cfg, tier="page", title="Heat Pump 1 offline", message="x", priority="high", tags="warning")
    assert sent == ["http://ntfy.invalid/a2w-test"]
