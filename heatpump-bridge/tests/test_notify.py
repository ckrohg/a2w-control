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
        captured["body"] = json.loads(req.data)
        return _FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cfg = NotifyConfig(resend_api_key="re_test", resend_to="me@example.com")
    await notify.email(cfg, subject="⚠ Pump 1 offline", body="down", priority="high")

    assert captured["url"] == "https://api.resend.com/emails"
    assert captured["auth"] == "Bearer re_test"
    assert captured["body"]["to"] == ["me@example.com"]
    assert captured["body"]["subject"] == "⚠ Pump 1 offline"   # emoji fine in JSON subject
    assert captured["body"]["text"] == "down"
    assert captured["body"]["from"] == "A2W Alerts <onboarding@resend.dev>"


async def test_resend_email_skips_low_priority_and_unconfigured(monkeypatch):
    calls = 0

    def fake_urlopen(req, timeout=10):
        nonlocal calls
        calls += 1
        return _FakeResp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    cfg = NotifyConfig(resend_api_key="re_test", resend_to="me@example.com")
    await notify.email(cfg, subject="back online", body="ok", priority="low")   # recovery
    await notify.email(NotifyConfig(), subject="x", body="y", priority="high")  # unconfigured
    assert calls == 0
