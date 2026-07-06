# @purpose: API authentication — token gating, read/write scope, source attribution,
# UI session cookie, and the open/writes/all enforcement modes. Runs the real app via
# TestClient against one offline pump (auth is checked before any pump I/O).
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from bridge.config import ApiToken, AppConfig, AuthConfig, PumpConfig
from bridge.main import create_app

CONTROL = "c" * 24
READONLY = "r" * 24


def make_app(tmp_path, protect="off", tokens=None):
    cfg = AppConfig(
        pumps=[PumpConfig(id="pump1", name="P1", host="127.0.0.1", port=59999,
                          write_enabled=True, poll_interval_s=999)],
        auth=AuthConfig(protect=protect, tokens=tokens or []),
        db_path=str(tmp_path / "b.db"),
        ui_dir="ui",
    )
    return create_app(cfg)


def both_tokens():
    return [ApiToken(token=CONTROL, source="tempiq", can_write=True),
            ApiToken(token=READONLY, source="observer", can_write=False)]


def bearer(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_open_mode_allows_anonymous(tmp_path):
    with TestClient(make_app(tmp_path)) as c:
        assert c.get("/api/pumps").status_code == 200
        # write reaches the poller (auth open) and is rejected for being offline, NOT auth
        r = c.post("/api/pumps/pump1/setpoint", json={"value": 45})
        assert r.status_code not in (401, 403)


def test_writes_mode_gates_control_but_not_reads(tmp_path):
    with TestClient(make_app(tmp_path, "writes", both_tokens())) as c:
        assert c.get("/api/pumps").status_code == 200          # reads open
        assert c.post("/api/pumps/pump1/setpoint",
                      json={"value": 45}).status_code == 401   # anonymous write blocked
        assert c.post("/api/pumps/pump1/setpoint", json={"value": 45},
                      headers=bearer(READONLY)).status_code == 403  # read-only token
        r = c.post("/api/pumps/pump1/setpoint", json={"value": 45},
                   headers=bearer(CONTROL))
        assert r.status_code not in (401, 403)                 # control token passes auth
        assert c.post("/api/pumps/pump1/setpoint", json={"value": 45},
                      headers=bearer("wrong")).status_code == 401  # bad token


def test_all_mode_gates_reads_too(tmp_path):
    with TestClient(make_app(tmp_path, "all", both_tokens())) as c:
        assert c.get("/api/pumps").status_code == 401
        assert c.get("/api/pumps", headers=bearer(READONLY)).status_code == 200
        assert c.get("/api/pumps", headers=bearer(CONTROL)).status_code == 200


def test_health_and_whoami_always_open(tmp_path):
    with TestClient(make_app(tmp_path, "all", both_tokens())) as c:
        assert c.get("/api/health").status_code == 200
        assert c.get("/api/health").json()["auth_mode"] == "all"
        anon = c.get("/api/whoami").json()
        assert anon["authenticated"] is False
        who = c.get("/api/whoami", headers=bearer(CONTROL)).json()
        assert who == {"authenticated": True, "source": "tempiq", "can_write": True}
        # a bad token on whoami reports unauthenticated rather than erroring
        assert c.get("/api/whoami", headers=bearer("bad")).json()["authenticated"] is False


def test_source_attribution_comes_from_token_not_body(tmp_path):
    with TestClient(make_app(tmp_path, "writes", both_tokens())) as c:
        # even if a caller tries to claim source:"ui" in the body, the token's source wins
        c.post("/api/pumps/pump1/power", json={"value": False, "source": "ui"},
               headers=bearer(CONTROL))
        events = c.get("/api/pumps/pump1/events", headers=bearer(CONTROL)).json()
        writes = [e for e in events if e["type"] == "power_write"]
        # the write is offline-rejected, but the audit records source=tempiq (from the
        # token) — never the body's claimed "ui"
        assert writes and all(e["detail"]["source"] == "tempiq" for e in writes)


def test_ui_cookie_authorizes_browser_without_a_token(tmp_path):
    with TestClient(make_app(tmp_path, "all", both_tokens())) as c:
        # httpx TestClient shares a cookie jar; loading the page mints the session
        assert c.get("/api/pumps").status_code == 401     # no cookie yet
        c.get("/")                                        # sets a2w_ui cookie
        assert "a2w_ui" in c.cookies
        assert c.get("/api/pumps").status_code == 200     # cookie now carries auth
        # and the cookie is httponly + samesite
        setc = TestClient(make_app(tmp_path, "all")).get("/").headers.get("set-cookie", "")
        assert "httponly" in setc.lower() and "samesite=strict" in setc.lower()


def test_config_rejects_short_and_duplicate_tokens(tmp_path):
    with pytest.raises(Exception):
        AuthConfig(tokens=[ApiToken(token="tooshort", source="x", can_write=True)])
    with pytest.raises(Exception):
        AuthConfig(tokens=[ApiToken(token=CONTROL, source="a"),
                           ApiToken(token=CONTROL, source="b")])
