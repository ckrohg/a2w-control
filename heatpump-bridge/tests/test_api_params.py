# @purpose: Query/body parameter hygiene on the bridge API. The history windows (`hours`,
# `days`) are clamped to [1, cap]; a non-finite value (`?hours=nan`, `?days=inf`) used to
# slip through `min(max(nan, 1), cap)` as NaN and come back from the store as an empty list
# indistinguishable from 'no data' — it is now a 422. SetpointRequest.lease_minutes rejects
# Infinity/NaN so the HTTP write path agrees with hub_client's WebSocket check. Runs the real
# app via TestClient against one offline pump, with the store's query methods stubbed to
# record the window the route actually passed.
from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from bridge.api import EVENTS_MAX_DAYS, HISTORY_MAX_HOURS, SetpointRequest, _window
from bridge.config import AppConfig, AuthConfig, PumpConfig
from bridge.main import create_app


def make_app(tmp_path):
    cfg = AppConfig(
        pumps=[PumpConfig(id="pump1", name="P1", host="127.0.0.1", port=59999,
                          write_enabled=True, poll_interval_s=999)],
        auth=AuthConfig(protect="off"),
        db_path=str(tmp_path / "b.db"),
        ui_dir="ui",
    )
    return create_app(cfg)


class RecordingStore:
    """Replaces the three window queries on the live Store (the pollers hold the same
    object as app.state.store) and records the window each route handed down."""

    def __init__(self, store):
        self.calls: list[tuple[str, float]] = []
        self._store = store

    def install(self):
        async def get_history(pump_id, hours):
            self.calls.append(("history", hours))
            return []

        async def get_events(pump_id, days):
            self.calls.append(("events", days))
            return []

        async def get_system_history(hours):
            self.calls.append(("system", hours))
            return []

        self._store.get_history = get_history
        self._store.get_events = get_events
        self._store.get_system_history = get_system_history
        return self

    def last(self):
        return self.calls[-1]


@pytest.fixture
def client(tmp_path):
    app = make_app(tmp_path)
    with TestClient(app) as c:
        rec = RecordingStore(app.state.store).install()
        yield c, rec


# --- the helper itself -----------------------------------------------------------------

def test_window_clamps_and_passes_finite_values():
    assert _window(0, 1, 10) == 1
    assert _window(-5, 1, 10) == 1
    assert _window(5, 1, 10) == 5
    assert _window(99999, 1, 10) == 10
    assert _window(1, 1, 10) == 1 and _window(10, 1, 10) == 10   # bounds inclusive


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_window_rejects_non_finite_with_422(bad):
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as ei:
        _window(bad, 1, 10, "hours")
    assert ei.value.status_code == 422
    assert "hours" in ei.value.detail


# --- the three history routes ----------------------------------------------------------

@pytest.mark.parametrize("path,param", [
    ("/api/pumps/pump1/history", "hours"),
    ("/api/pumps/pump1/events", "days"),
    ("/api/system/history", "hours"),
])
@pytest.mark.parametrize("value", ["nan", "inf", "-inf", "NaN", "Infinity"])
def test_non_finite_window_is_422_not_empty_list(client, path, param, value):
    c, rec = client
    r = c.get(path, params={param: value})
    assert r.status_code == 422, r.text
    assert rec.calls == []            # the store never saw the NaN/inf


def test_history_hours_clamp_low_and_high(client):
    c, rec = client
    assert c.get("/api/pumps/pump1/history", params={"hours": 0}).status_code == 200
    assert rec.last() == ("history", 1)
    assert c.get("/api/pumps/pump1/history", params={"hours": -7}).status_code == 200
    assert rec.last() == ("history", 1)
    assert c.get("/api/pumps/pump1/history", params={"hours": 99999}).status_code == 200
    assert rec.last() == ("history", HISTORY_MAX_HOURS)
    assert HISTORY_MAX_HOURS == 24 * 90   # the 90-day cap the clamp used to spell inline
    # in-range values pass through untouched (default included)
    assert c.get("/api/pumps/pump1/history", params={"hours": 36.5}).status_code == 200
    assert rec.last() == ("history", 36.5)
    assert c.get("/api/pumps/pump1/history").status_code == 200
    assert rec.last() == ("history", 24)


def test_events_days_clamp_low_and_high(client):
    c, rec = client
    assert c.get("/api/pumps/pump1/events", params={"days": 0}).status_code == 200
    assert rec.last() == ("events", 1)
    assert c.get("/api/pumps/pump1/events", params={"days": 99999}).status_code == 200
    assert rec.last() == ("events", EVENTS_MAX_DAYS)
    assert EVENTS_MAX_DAYS == 365
    assert c.get("/api/pumps/pump1/events").status_code == 200
    assert rec.last() == ("events", 7)


def test_system_history_hours_clamp_low_and_high(client):
    c, rec = client
    assert c.get("/api/system/history", params={"hours": 0}).status_code == 200
    assert rec.last() == ("system", 1)
    assert c.get("/api/system/history", params={"hours": 99999}).status_code == 200
    assert rec.last() == ("system", HISTORY_MAX_HOURS)
    assert c.get("/api/system/history").status_code == 200
    assert rec.last() == ("system", 24)


def test_non_numeric_window_is_still_422(client):
    c, rec = client
    assert c.get("/api/pumps/pump1/history", params={"hours": "abc"}).status_code == 422
    assert c.get("/api/pumps/pump1/events", params={"days": "7d"}).status_code == 422
    assert rec.calls == []


# --- SetpointRequest.lease_minutes --------------------------------------------------------

@pytest.mark.parametrize("bad", [float("inf"), float("-inf"), float("nan")])
def test_lease_minutes_model_rejects_non_finite(bad):
    with pytest.raises(ValidationError):
        SetpointRequest(value=45, lease_minutes=bad)


def test_lease_minutes_model_keeps_existing_rules():
    assert SetpointRequest(value=45).lease_minutes is None
    assert SetpointRequest(value=45, lease_minutes=None).lease_minutes is None
    assert SetpointRequest(value=45, lease_minutes=30).lease_minutes == 30
    assert SetpointRequest(value=45, lease_minutes=0.5).lease_minutes == 0.5
    with pytest.raises(ValidationError):        # gt=0 still applies
        SetpointRequest(value=45, lease_minutes=0)
    with pytest.raises(ValidationError):
        SetpointRequest(value=45, lease_minutes=-10)


JSON = {"content-type": "application/json"}


@pytest.mark.parametrize("token", ["Infinity", "-Infinity", "NaN"])
def test_setpoint_post_with_non_finite_lease_is_422(client, token):
    """Python's default json.dumps emits bare `Infinity` / `NaN`, and Starlette's json.loads
    accepts them — so this is exactly what a sloppy client can put on the wire. Sent as raw
    bytes so the assertion does not depend on the test client's own serializer. Before the
    fix, inf > 0 satisfied gt=0 and the write reached the poller."""
    c, _ = client
    body = ('{"value": 45, "lease_minutes": %s}' % token).encode()
    r = c.post("/api/pumps/pump1/setpoint", content=body, headers=JSON)
    assert r.status_code == 422, r.text
    assert "lease_minutes" in r.text


def test_setpoint_post_with_normal_lease_reaches_the_guard_as_before(client):
    """A finite lease is NOT a validation problem: the request passes pydantic and reaches
    the guarded write, which refuses it for the pump being offline (not 401/403/422)."""
    c, _ = client
    r = c.post("/api/pumps/pump1/setpoint", json={"value": 45, "lease_minutes": 30})
    assert r.status_code not in (401, 403, 422), r.text
    r = c.post("/api/pumps/pump1/setpoint", json={"value": 45})          # no lease at all
    assert r.status_code not in (401, 403, 422), r.text
    assert math.isfinite(SetpointRequest(value=45, lease_minutes=30).lease_minutes)
