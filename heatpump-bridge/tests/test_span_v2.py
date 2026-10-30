# @purpose: The SPAN v2 transport and the v2-first / v1-fallback client (#199) against the fake panel
# (sim/fake_span.py + sim/fake_span_v2.py: real HTTP, real MQTT-over-TLS, real paho). The breaker/self-heal/backup/
# deliberate-stop suites already run end to end on a v2-only panel (tests/conftest.py span_transport); this file
# covers what only the transport layer can get wrong: which transport answers, never a second OPEN on v1 after a
# possibly-delivered v2 OPEN, QoS 0 writes, stale or not-ready data reading as unknown, re-registration, TLS.
from __future__ import annotations

import asyncio
import os
import ssl
import time

import pytest

from bridge import span_local, span_v2
from bridge.config import SpanConfig
from bridge.span_local import OpenAborted, OpenPermit, SpanClient, SpanLocalPoller
from bridge.store import Store
from sim import fake_span_v2
from sim.fake_span import FakeSpan


@pytest.fixture(autouse=True)
def quick(monkeypatch):
    monkeypatch.setattr(span_v2, "ECHO_WAIT_S", 0.5)
    monkeypatch.setattr(span_v2, "CONNECT_WAIT_S", 3.0)
    monkeypatch.setattr(span_v2, "TREE_GRACE_S", 1.0)


@pytest.fixture
def make(tmp_path):
    made = []

    def _make(*, v1=True, v2=True, transport="auto", state_dir=None):
        panel = FakeSpan(v1=v1, v2=v2)
        addr = panel.start()
        client = SpanClient(addr, "pw", transport=transport,
                            state_dir=str(state_dir or tmp_path / f"s{len(made)}"))
        os.makedirs(client.v2.state_dir if client.v2 else tmp_path, exist_ok=True)
        made.append((panel, client))
        return panel, client
    yield _make
    for panel, client in made:
        client.close()
        panel.stop()


def sync(panel, client):
    """Publish FakeSpan's dict changes now and wait until the client has them (the fake polls every 20 ms)."""
    panel.ebus.flush(client.v2)


def cid(client, name):
    return next(k for k, c in client._fetch_locked().items() if c["name"] == name)


def wait_for(pred, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


# --- which transport answers --------------------------------------------------------------
def test_auto_prefers_v2_and_never_touches_v1(make):
    panel, c = make()
    circuits = c._fetch_locked()
    assert {x["name"] for x in circuits.values()} >= {"Air-Water 1", "Air-Water 2", "Buffer Tank"}
    aw1 = next(x for x in circuits.values() if x["name"] == "Air-Water 1")
    assert aw1["relayState"] == "CLOSED" and aw1["isUserControllable"] is True
    assert aw1["instantPowerW"] == -2400.0          # consumption stays NEGATIVE, exactly as v1 reports it
    assert c._set_relay_sync(cid(c, "Kitchen"), "CLOSED") == "CLOSED"
    st = c.transport_status()
    assert st["read"] == "v2" and st["write"] == "v2" and st["v2"]["connected"] and st["v2"]["synced"]
    assert panel.v1_requests == []


def test_auto_falls_back_to_v1_when_the_panel_has_no_v2(make):
    panel, c = make(v2=False)
    assert cid(c, "Air-Water 2")
    assert c._set_relay_sync(cid(c, "Kitchen"), "CLOSED") == "CLOSED"
    st = c.transport_status()
    assert st["read"] == "v1" and st["write"] == "v1" and "404" in st["v2_error"]


def test_auto_falls_back_to_v1_when_the_broker_goes_away(make):
    panel, c = make()
    c._fetch_locked()
    assert c.transport_status()["read"] == "v2"
    panel.ebus.stop()                                 # the broker is gone; v1 REST still answers
    assert wait_for(lambda: not c.v2._connected)
    assert cid(c, "Air-Water 1")
    st = c.transport_status()
    assert st["read"] == "v1" and st["v2_error"] and not st["v2"]["connected"]


def test_a_rotated_broker_password_re_registers_and_v2_answers_again(make, monkeypatch):
    monkeypatch.setattr(span_v2, "_REREGISTER_COOLDOWN_S", 0.0)
    panel, c = make(v1=False)
    c._fetch_locked()
    panel.ebus.password = "rotated"                   # the panel forgot us: reconnects are refused…
    panel.ebus.drop_sessions()
    assert wait_for(lambda: c.v2._auth_failed, 5)
    c._fetch_locked()                                 # …so the next read re-registers and reconnects
    assert c.transport_status()["read"] == "v2" and len(panel.v2_registrations) == 2


def test_pinned_transports_use_only_their_own(make):
    panel, c = make(transport="v2")
    c._fetch_locked()
    c._set_relay_sync(cid(c, "Kitchen"), "CLOSED")
    assert panel.v1_requests == []
    panel, c = make(transport="v1")
    c._fetch_locked()
    c._set_relay_sync(cid(c, "Kitchen"), "CLOSED")
    assert panel.v2_registrations == [] and panel.ebus.sets == [] and c.v2 is None
    assert c.transport_status()["read"] == "v1"


def test_v2_only_panel_down_is_an_error_not_a_v1_answer(make):
    panel, c = make(v1=False)
    c._fetch_locked()
    panel.down = True
    sync(panel, c)
    with pytest.raises(ConnectionError):
        c._fetch_locked()


def test_the_release_default_is_v1_and_touches_no_v2(make, tmp_path):
    """Owner rollout 2026-10-29: the release ships pinned to v1 (no behaviour change); v2 is a later config flip."""
    assert SpanConfig().transport == "v1" and SpanConfig().v2_soak is False
    panel = FakeSpan(v1=True, v2=True)
    addr = panel.start()
    poller = SpanLocalPoller(SpanConfig(host=addr, passphrase="pw"), None, token_path=str(tmp_path / "tok"))
    try:
        poller.client._fetch_locked()
        poller.client._set_relay_sync(cid(poller.client, "Kitchen"), "CLOSED")
        st = poller.client.transport_status()
        assert st["mode"] == "v1" and st["read"] == st["write"] == "v1" and st["v2"] is None and st["soak"] is None
        assert panel.v2_registrations == [] and panel.ebus.connects == [] and panel.ebus.sets == []
    finally:
        poller.client.close()
        panel.stop()


def test_transport_config_is_validated():
    with pytest.raises(ValueError):
        SpanConfig(transport="mqtt")
    with pytest.raises(ValueError):
        SpanClient("h", "p", transport="v3")


# --- relay writes: the safety properties ----------------------------------------------------
def test_writes_are_qos0_and_validated_against_the_panels_own_description(make):
    panel, c = make(v1=False)
    k = cid(c, "Kitchen")
    c._set_relay_sync(k, "CLOSED")
    assert wait_for(lambda: panel.ebus.sets)
    assert [s[1:] for s in panel.ebus.sets] == [("CLOSED", 0)]      # QoS 0: never re-sent after a reconnect
    # the fake refuses what the real panel's $description does not allow (the #200 lesson, v2 side)
    c.v2._client.publish("ebus/5/c-k/switch/relay/set", "ON", qos=0).wait_for_publish(2)
    c.v2._client.publish("ebus/5/c-k/meter/active-power/set", "0", qos=0).wait_for_publish(2)
    assert wait_for(lambda: len(panel.ebus.rejected) == 2)
    assert panel.relay("Kitchen") == "CLOSED"


def test_open_without_a_permit_is_refused_before_anything_is_sent(make):
    panel, c = make()
    k = cid(c, "Kitchen")
    with pytest.raises(ValueError, match="CLOSE-ONLY"):
        c._set_relay_sync(k, "OPEN")
    with pytest.raises(ValueError, match="not circuit"):
        c._set_relay_sync(k, "OPEN", open_permit=OpenPermit(cid(c, "Air-Water 1"), "Air-Water 1", "t"))
    assert panel.ebus.sets == [] and panel.writes == []
    assert not [r for r in panel.v1_requests if r[1].startswith("/api/v1/circuits/")]


def test_open_with_a_permit_lands_over_v2(make):
    panel, c = make()
    k = cid(c, "Kitchen")
    assert c._set_relay_sync(k, "OPEN", open_permit=OpenPermit(k, "Kitchen", "t")) == "OPEN"
    assert panel.relay("Kitchen") == "OPEN" and panel.writes == [("Kitchen", "OPEN")]
    assert c.transport_status()["write"] == "v2"


def test_a_possibly_delivered_v2_open_is_never_resent_over_v1(make):
    panel, c = make()                                # v1 is up and would happily take an OPEN
    k = cid(c, "Kitchen")
    panel.fail_opens = 1                              # the panel takes the /set but never moves the relay
    with pytest.raises(ConnectionError, match="still shows CLOSED"):
        c._set_relay_sync(k, "OPEN", open_permit=OpenPermit(k, "Kitchen", "t"))
    assert panel.writes == [("Kitchen", "OPEN")]      # exactly one OPEN, on v2
    assert not [r for r in panel.v1_requests if r[1].startswith("/api/v1/circuits/")]


def test_an_unconfirmed_v2_close_is_retried_over_v1(make):
    panel, c = make()
    k = cid(c, "Kitchen")
    panel.set("Kitchen", relayState="OPEN")
    sync(panel, c)
    panel.fail_closes = 1                             # v2 /set lost; the v1 POST then lands
    assert c._set_relay_sync(k, "CLOSED") == "CLOSED"
    assert panel.writes == [("Kitchen", "CLOSED"), ("Kitchen", "CLOSED")]
    assert [r for r in panel.v1_requests if r[1].startswith("/api/v1/circuits/")] == [("POST", "/api/v1/circuits/c-k")]
    assert c.transport_status()["write"] == "v1"


def test_open_falls_back_to_v1_only_when_v2_sent_nothing(make):
    panel, c = make()
    k = cid(c, "Kitchen")
    panel.ebus.password = "rotated"
    panel.ebus.drop_sessions()
    assert wait_for(lambda: not c.v2._connected)
    guard_calls = []
    permit = OpenPermit(k, "Kitchen", "t", guard=lambda: guard_calls.append(1))
    assert c._set_relay_sync(k, "OPEN", open_permit=permit) == "OPEN"
    assert panel.ebus.sets == [] and panel.writes == [("Kitchen", "OPEN")]
    assert len(guard_calls) == 1                       # the guard ran at the (v1) dispatch boundary only


def test_guard_refusal_sends_nothing_on_either_transport(make):
    panel, c = make()
    k = cid(c, "Kitchen")
    permit = OpenPermit(k, "Kitchen", "t", guard=lambda: "pump started heating")
    with pytest.raises(OpenAborted, match="pump started heating"):
        c._set_relay_sync(k, "OPEN", open_permit=permit)
    assert panel.ebus.sets == [] and panel.writes == []
    assert not [r for r in panel.v1_requests if r[1].startswith("/api/v1/circuits/")]


def test_guard_may_reread_the_panel_inside_the_write(make):
    """The backup-element guard calls client._fetch_locked() at the dispatch boundary (span_control)."""
    panel, c = make(v1=False)
    k = cid(c, "Buffer Tank")
    seen = []
    permit = OpenPermit(k, "Buffer Tank", "t",
                        guard=lambda: seen.append(c._fetch_locked()[k]["instantPowerW"]) or None)
    assert c._set_relay_sync(k, "OPEN", open_permit=permit) == "OPEN"
    assert seen == [0.0]


# --- unknown is never "down" --------------------------------------------------------------
def test_a_silent_panel_is_stale_not_off(make, monkeypatch):
    panel, c = make(v1=False)
    c._fetch_locked()
    monkeypatch.setattr(span_v2, "STALE_AFTER_S", 0.3)
    panel.ebus.silent = True
    time.sleep(0.5)
    with pytest.raises(ConnectionError, match="stale"):
        c._fetch_locked()
    with pytest.raises(ConnectionError):             # and nothing is written into a tree we can't see
        c._set_relay_sync("ck", "CLOSED")
    assert panel.ebus.sets == []


def test_a_circuit_that_is_not_ready_reads_unknown(make):
    panel, c = make(v1=False)
    c._fetch_locked()
    panel.set("Air-Water 2", _v2_state="lost")
    sync(panel, c)
    a = next(x for x in c._fetch_locked().values() if x["name"] == "Air-Water 2")
    assert a["relayState"] is None and a["instantPowerW"] is None and a["isUserControllable"] is False


def test_a_relay_the_panel_reports_unknown_reads_unknown(make):
    panel, c = make(v1=False)
    c._fetch_locked()
    panel.set("Air-Water 1", relayState="UNKNOWN")    # in the real panel's enum: UNKNOWN,OPEN,CLOSED
    sync(panel, c)
    a = next(x for x in c._fetch_locked().values() if x["name"] == "Air-Water 1")
    assert a["relayState"] is None


def test_missing_power_is_none_not_zero(make):
    panel, c = make(v1=False)
    c._fetch_locked()
    panel.set("Air-Water 1", instantPowerW=None)
    sync(panel, c)
    a = next(x for x in c._fetch_locked().values() if x["name"] == "Air-Water 1")
    assert a["instantPowerW"] is None and a["relayState"] == "CLOSED"


def test_relays_switched_by_someone_else_show_up(make):
    """6bb switches these breakers too (owner decision): the live tree, not A2W's last write, is the truth."""
    panel, c = make(v1=False)
    c._fetch_locked()
    panel.set("Air-Water 2", relayState="OPEN")
    assert wait_for(lambda: next(x for x in c._fetch_locked().values()
                                 if x["name"] == "Air-Water 2")["relayState"] == "OPEN")


# --- registration, credentials, TLS ----------------------------------------------------------
def test_credentials_persist_privately_and_are_reused(make, tmp_path):
    sd = tmp_path / "shared"
    sd.mkdir()
    panel, c = make(v1=False, state_dir=sd)
    c._fetch_locked()
    creds = sd / span_v2.CREDS_FILE
    assert creds.exists() and (creds.stat().st_mode & 0o777) == 0o600
    assert panel.v2_registrations[0]["hopPassphrase"] == "pw"
    c.close()
    c2 = SpanClient(c.host, "pw", state_dir=str(sd), transport="auto")
    try:
        c2._fetch_locked()
        assert len(panel.v2_registrations) == 1           # the restart reused the stored registration
    finally:
        c2.close()


def test_a_rejected_passphrase_is_reported_and_v1_still_answers(make):
    panel, c = make()
    panel.passphrase = "something-else"
    c._fetch_locked()
    st = c.transport_status()
    assert st["read"] == "v1" and "401" in st["v2_error"]


def test_the_wrong_ca_fails_tls_falls_back_and_heals(make, tmp_path, monkeypatch):
    sd = tmp_path / "badca"
    sd.mkdir()
    other_ca, _ = fake_span_v2.make_tls(str(tmp_path))     # a CA that did not sign the broker's cert
    (sd / span_v2.CA_FILE).write_text(other_ca)
    panel, c = make(state_dir=sd)
    c._fetch_locked()
    st = c.transport_status()
    assert st["read"] == "v1" and not st["v2"]["connected"]
    # a session that never comes up is restarted with a freshly fetched CA (a re-issued panel CA heals itself)
    monkeypatch.setattr(span_v2, "NEVER_UP_S", 0.0)
    c.v2._next_start = 0.0
    c._fetch_locked()                     # restart: drops the stale CA, fetches the panel's, connects
    assert c.transport_status()["read"] == "v2"
    assert (sd / span_v2.CA_FILE).read_text() == panel.ebus.ca_pem


def test_tls_context_clears_x509_strict_only():
    ca, _ = fake_span_v2.tls()
    ctx = span_v2.tls_context(ca)
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname
    assert not ctx.verify_flags & getattr(ssl, "VERIFY_X509_STRICT", 0)


def test_capture_is_from_the_real_panel():
    """The fake must be built from shapes recorded on the real panel (deploy/span-v2-probe.py --capture)."""
    cap = fake_span_v2.CAPTURE
    assert "READ-ONLY" in cap["source"] and "r202639" in cap["source"]
    desc = cap["circuit"]["$description"]
    assert desc["type"] == span_v2.T_CIRCUIT and cap["panel"]["$description"]["type"] == span_v2.T_PANEL
    relay = desc["nodes"]["switch"]["properties"]["relay"]
    assert relay["settable"] and {"OPEN", "CLOSED"} <= set(relay["format"].split(","))
    # every property A2W reads is one the real circuit declares and publishes
    assert span_v2._declared(desc, span_v2.READS) == list(span_v2.READS)
    assert set(span_v2.READS) <= set(cap["circuit"]["properties"])
    assert float(cap["circuit"]["properties"]["meter/active-power"]) < 0     # a load reads negative


# --- the poller + what /health and the hub see ------------------------------------------------
async def test_poller_logs_power_and_reports_the_transport(tmp_path):
    panel = FakeSpan(v1=False, v2=True)
    addr = panel.start()
    store = Store(str(tmp_path / "b.db"))
    await store.open()
    poller = SpanLocalPoller(SpanConfig(host=addr, passphrase="pw", transport="auto"), store,
                             token_path=str(tmp_path / "span-local-token"))
    try:
        rows = await poller.poll_once()
        assert {r["name"]: r["power_w"] for r in rows} == {"Buffer Tank": 0.0, "Air-Water 1": -2400.0,
                                                            "Air-Water 2": -108.0}
        st = poller.status()
        assert st["read"] == "v2" and st["last_ok_ts"] and st["v2"]["serial"] == fake_span_v2.SERIAL
        assert (tmp_path / span_v2.CREDS_FILE).exists()      # creds live next to the v1 token (bridge-data)
    finally:
        await poller.stop()
        await store.close()
        panel.stop()


def test_api_health_reports_the_span_transport(tmp_path):
    from fastapi.testclient import TestClient

    from bridge.config import AppConfig, PumpConfig
    from bridge.main import create_app
    panel = FakeSpan(v1=False, v2=True)
    addr = panel.start()
    try:
        cfg = AppConfig(pumps=[PumpConfig(id="pump1", name="P1", host="127.0.0.1", port=59999, poll_interval_s=999)],
                        span=SpanConfig(host=addr, passphrase="pw", transport="auto"), db_path=str(tmp_path / "b.db"),
                        ui_dir="ui")
        with TestClient(create_app(cfg)) as c:
            # read is noted inside the fetch; last_ok_ts once the poll has stored its samples — wait for both
            assert wait_for(lambda: (lambda h: h.get("read") == "v2" and h.get("last_ok_ts"))(
                c.get("/api/health").json()["span"] or {}), 10)
            h = c.get("/api/health").json()["span"]
            assert h["mode"] == "auto" and h["last_ok_ts"] and h["v2"]["connected"] and h["v1_error"] is None
    finally:
        panel.stop()
    cfg = AppConfig(pumps=[PumpConfig(id="pump1", name="P1", host="127.0.0.1", port=59999, poll_interval_s=999)],
                    db_path=str(tmp_path / "c.db"), ui_dir="ui")
    with TestClient(create_app(cfg)) as c:
        assert c.get("/api/health").json()["span"] is None     # SPAN not configured


# --- the read-only v2 soak beside the v1 default ---------------------------------------------------
def soak_client(make, **kw):
    panel, _ = make()
    c = SpanClient(panel_addr(panel), "pw", transport="v1", v2_soak=True, **kw)
    return panel, c


def panel_addr(panel):
    return f"127.0.0.1:{panel._server.server_address[1]}"


def test_soak_shadows_v2_read_only_and_never_decides(make, tmp_path):
    panel, c = soak_client(make, state_dir=str(tmp_path))
    try:
        c._fetch_locked()                                   # first read: v2 session still starting — not waited for
        assert wait_for(lambda: c._soak.status()["synced"], 5)
        c._fetch_locked()
        c._set_relay_sync(cid(c, "Kitchen"), "CLOSED")
        st = c.transport_status()
        assert st["mode"] == "v1" and st["read"] == st["write"] == "v1" and st["v2"] is None
        assert st["soak"]["compared"] >= 1 and st["soak"]["disagree"] == 0 and st["soak"]["v2"]["connected"]
        assert panel.ebus.sets == []                        # never a v2 write
        assert [r for r in panel.v1_requests if r[1].startswith("/api/v1/circuits/")] == [("POST", "/api/v1/circuits/c-k")]
    finally:
        c.close()


def test_soak_reports_a_disagreement(make, tmp_path):
    panel, c = soak_client(make, state_dir=str(tmp_path))
    try:
        c._fetch_locked()
        assert wait_for(lambda: c._soak.status()["synced"], 5)
        panel.set("Air-Water 2", _v2_state="lost")          # v2 sees the circuit as not ready; v1 still reads it
        panel.ebus.flush(c._soak)
        c._fetch_locked()
        d = c.transport_status()["soak"]
        assert d["disagree"] == 1 and any("Air-Water 2: relayState" in x for x in d["last_disagreement"]["diffs"])
    finally:
        c.close()


def test_a_broken_v2_never_slows_or_fails_the_v1_read(make, tmp_path):
    panel, _ = make()
    panel.ebus.stop()
    c = SpanClient(panel_addr(panel), "pw", transport="v1", v2_soak=True, state_dir=str(tmp_path))
    try:
        t = time.monotonic()
        for _ in range(3):
            assert cid(c, "Air-Water 1")
        assert time.monotonic() - t < 2.0
        st = c.transport_status()
        assert st["read"] == "v1" and st["soak"]["unavailable"] >= 1 and st["soak"]["compared"] == 0
    finally:
        c.close()


# --- #239 review: F1 the soak never delays v1 / F2 registration backoff / F3 no pre-outage tree --------------------
def test_a_slow_v2_soak_start_never_delays_a_v1_read_or_close(make, tmp_path, monkeypatch):
    """F1: starting the soak session makes blocking HTTP calls (register, CA: up to timeout_s per address). They run
    on a background thread, never under the client lock a v1 read or a relay write needs."""
    panel, _ = make()
    real_start = span_v2.SpanV2._start
    started = []

    def slow_start(self):
        started.append(time.monotonic())
        time.sleep(3.0)                                   # a panel answering HTTP slowly
        real_start(self)
    monkeypatch.setattr(span_v2.SpanV2, "_start", slow_start)
    c = SpanClient(panel_addr(panel), "pw", transport="v1", v2_soak=True, state_dir=str(tmp_path))
    try:
        t = time.monotonic()
        k = cid(c, "Kitchen")                             # the first read kicks the soak start
        assert wait_for(lambda: started, 2)
        panel.set("Kitchen", relayState="OPEN")
        assert c._set_relay_sync(k, "CLOSED") == "CLOSED"     # while the soak start is still sleeping
        c._fetch_locked()
        assert time.monotonic() - t < 1.5 and time.monotonic() - started[0] < 3.0
        assert panel.relay("Kitchen") == "CLOSED"
        assert wait_for(lambda: c._soak.status()["synced"], 8)    # and the soak does come up afterwards
    finally:
        c.close()


def test_register_backoff_doubles_to_a_cap_and_survives_a_restart(tmp_path, monkeypatch):
    now = [1_000_000.0]
    monkeypatch.setattr(span_v2.time, "time", lambda: now[0])
    v = span_v2.SpanV2("h", "p", state_dir=str(tmp_path))
    assert v.register_backoff_s() == 0                     # never registered: go
    gaps = []
    for strikes in range(1, 9):
        v._reg = {"last": now[0], "strikes": strikes}
        v._save_reg()
        gaps.append(span_v2.SpanV2("h", "p", state_dir=str(tmp_path)).register_backoff_s())   # a fresh process
    assert gaps[:6] == [600, 1200, 2400, 4800, 9600, 19200] and gaps[6:] == [21600, 21600]
    assert span_v2.SpanV2("h", "p", state_dir=str(tmp_path)).status()["auth_alarm"] is True


async def test_a_broker_that_keeps_refusing_backs_off_alarms_once_and_cleans_up(tmp_path, monkeypatch):
    """F2: every registration after a refusal used to mint a new panel client every 10 min (~144/day)."""
    monkeypatch.setattr(span_v2, "_REREGISTER_COOLDOWN_S", 0.2)
    monkeypatch.setattr(span_v2, "NEVER_UP_S", 600.0)
    panel = FakeSpan(v1=True, v2=True)
    addr = panel.start()
    panel.v2_clients.update({"a2w-bridge-1a2b3c4d": {}, "6bb-bridge-mvg7k4s1": {}, "a2w-probe-abc123": {},
                             "a2w-bridge-v2-deadbeef": {}})        # v1 client, 6bb, a probe, a stale v2 client
    panel.ebus.refuse_all = True
    store = Store(str(tmp_path / "b.db"))
    await store.open()
    sent = []

    async def notify(title, message, priority="default", *, tier, resolved=False, action=None):
        sent.append((tier, title))
    poller = SpanLocalPoller(SpanConfig(host=addr, passphrase="pw", v2_soak=True), store, notify=notify,
                             token_path=str(tmp_path / "span-local-token"))
    try:
        for _ in range(40):                                  # ~4 s of polls (v1 answers every one)
            await poller.poll_once()
            await asyncio.sleep(0.1)
        regs = len(panel.v2_registrations)
        # with a 0.2 s base: registrations at ~0, 0.2, 0.6, 1.4, 3.0 s — not one per poll
        assert 3 <= regs <= 6, regs
        st = poller.status()
        assert st["read"] == "v1" and st["soak"]["v2"]["auth_alarm"] and st["soak"]["v2"]["register_strikes"] == regs
        assert [s for s in sent if s[0] == "record"] == [("record", "SPAN v2 keeps refusing A2W")]   # once
        ev = [e for e in await store.get_events("span", 1) if e["type"] == "span_v2"]
        assert [e["code"] for e in ev] == ["v2_register_backoff"]
        # only this bridge's own earlier v2 clients were deleted; the v1 client, 6bb and the probe stay
        assert "a2w-bridge-v2-deadbeef" in panel.v2_deleted
        assert set(panel.v2_clients) >= {"a2w-bridge-1a2b3c4d", "6bb-bridge-mvg7k4s1", "a2w-probe-abc123"}
        assert [n for n in panel.v2_clients if n.startswith("a2w-bridge-v2-")] == [panel.v2_registrations[-1]["name"]]
        # the broker accepts again: a session comes up, the backoff resets and the all-clear is recorded
        panel.ebus.refuse_all = False
        for _ in range(100):                                 # keep polling: the soak retries when its backoff allows
            await poller.poll_once()
            if not poller.client.v2_auth_alarm():
                break
            await asyncio.sleep(0.2)
        await poller.poll_once()
        assert poller.status()["soak"]["v2"]["register_strikes"] == 0
        ev = [e for e in await store.get_events("span", 1) if e["type"] == "span_v2"]
        assert sorted(e["code"] for e in ev) == ["v2_register_backoff", "v2_register_ok"]
    finally:
        await poller.stop()
        await store.close()
        panel.stop()


def test_after_a_reconnect_the_pre_outage_tree_is_never_served(make):
    """F3: between the new SUBACK and the panel's retained re-send, the tree from before the outage is gone."""
    panel, c = make(v1=False)
    assert next(x for x in c._fetch_locked().values() if x["name"] == "Air-Water 2")["relayState"] == "CLOSED"
    panel.ebus.silent = True                               # the panel publishes nothing new…
    panel.ebus.hold_retained = True                        # …and a new session gets no retained tree yet
    panel.ebus.drop_sessions()
    assert wait_for(lambda: not c.v2._connected, 3)
    assert wait_for(lambda: c.v2._connected and c.v2._subscribed, 10)    # paho reconnected + SUBACK
    with pytest.raises(ConnectionError, match="not received yet on this connection"):
        c._fetch_locked()                                   # NOT the pre-outage CLOSED
    panel.ebus.hold_retained = False
    panel.ebus.silent = False
    panel.ebus.resend_retained()
    assert wait_for(lambda: c.v2.status()["synced"], 5)
    assert next(x for x in c._fetch_locked().values() if x["name"] == "Air-Water 2")["relayState"] == "CLOSED"
