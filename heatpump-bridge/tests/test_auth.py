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


def make_app(tmp_path, protect="off", tokens=None, ui_password=None):
    cfg = AppConfig(
        pumps=[PumpConfig(id="pump1", name="P1", host="127.0.0.1", port=59999,
                          write_enabled=True, poll_interval_s=999)],
        auth=AuthConfig(protect=protect, tokens=tokens or [], ui_password=ui_password),
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
        assert (who["authenticated"], who["source"], who["can_write"]) == (True, "tempiq", True)
        # a bad token on whoami reports unauthenticated rather than erroring
        assert c.get("/api/whoami", headers=bearer("bad")).json()["authenticated"] is False


def test_source_attribution_comes_from_token_not_body(tmp_path):
    with TestClient(make_app(tmp_path, "writes", both_tokens())) as c:
        # setpoint is the one thing a machine token may do; source must come from the token
        c.post("/api/pumps/pump1/setpoint", json={"value": 45, "source": "ui"},
               headers=bearer(CONTROL))
        events = c.get("/api/pumps/pump1/events", headers=bearer(CONTROL)).json()
        writes = [e for e in events if e["type"] == "setpoint_write"]
        # offline-rejected, but audited with source=tempiq (from the token), never body "ui"
        assert writes and all(e["detail"]["source"] == "tempiq" for e in writes)


def test_machine_token_is_setpoint_only_under_restriction(tmp_path):
    # fusion audit risk 2: automated clients may set setpoints but not power/mode/params
    with TestClient(make_app(tmp_path, "writes", both_tokens())) as c:
        assert c.post("/api/pumps/pump1/power", json={"value": False},
                      headers=bearer(CONTROL)).status_code == 403
        assert c.post("/api/pumps/pump1/mode", json={"value": "cooling"},
                      headers=bearer(CONTROL)).status_code == 403
        assert c.post("/api/pumps/pump1/parameter", json={"key": "max_water_temp_c", "value": 60},
                      headers=bearer(CONTROL)).status_code == 403
        # setpoint IS allowed for the machine (reaches the poller, offline-rejected != 403-auth)
        assert c.post("/api/pumps/pump1/setpoint", json={"value": 45},
                      headers=bearer(CONTROL)).status_code not in (401, 403)


def test_protect_off_auto_mints_browser_session(tmp_path):
    with TestClient(make_app(tmp_path)) as c:
        setc = c.get("/").headers.get("set-cookie", "")
        assert "a2w_ui" in setc and "httponly" in setc.lower() and "samesite=strict" in setc.lower()
        # the cookie is a signed token, NOT the raw server secret
        val = c.cookies.get("a2w_ui")
        assert "." in val and val != c.app.state.ui_secret


def test_loading_page_does_NOT_grant_control_under_protect(tmp_path):
    # regression for the HIGH finding: a public/LAN caller must not get a free write
    # session just by loading the page
    with TestClient(make_app(tmp_path, "writes", ui_password="hunter2pass")) as c:
        c.get("/")                                        # loads page
        assert "a2w_ui" not in c.cookies                  # no session handed out
        assert c.post("/api/pumps/pump1/setpoint",
                      json={"value": 45}).status_code == 401


def test_ui_password_login_flow(tmp_path):
    with TestClient(make_app(tmp_path, "all", ui_password="hunter2pass")) as c:
        assert c.get("/api/pumps").status_code == 401     # locked out until login
        assert c.post("/api/session", json={"password": "wrong"}).status_code == 401
        assert c.post("/api/session", json={"password": "hunter2pass"}).status_code == 200
        assert "a2w_ui" in c.cookies                       # session issued
        assert c.get("/api/pumps").status_code == 200      # now authorized
        r = c.post("/api/pumps/pump1/setpoint", json={"value": 45})
        assert r.status_code not in (401, 403)             # control granted
        c.post("/api/logout")
        assert c.get("/api/pumps").status_code == 401       # logout clears it


def test_login_throttle(tmp_path):
    import bridge.auth as auth
    auth._fail_times.clear()
    with TestClient(make_app(tmp_path, "writes", ui_password="hunter2pass")) as c:
        for _ in range(11):
            c.post("/api/session", json={"password": "nope"})
        # after >10 failures/min, even the correct password is refused briefly
        assert c.post("/api/session", json={"password": "hunter2pass"}).status_code == 429
    auth._fail_times.clear()


def test_config_rejects_short_and_duplicate_tokens(tmp_path):
    with pytest.raises(Exception):
        AuthConfig(tokens=[ApiToken(token="tooshort", source="x", can_write=True)])
    with pytest.raises(Exception):
        AuthConfig(tokens=[ApiToken(token=CONTROL, source="a"),
                           ApiToken(token=CONTROL, source="b")])
