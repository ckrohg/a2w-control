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
