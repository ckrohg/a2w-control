# @purpose: power_w on every surface is the pump's SPAN circuit, metered at the panel — never registers 2063/2088
# (inverter stages only, unconfirmed unit: 0-35 while the circuit drew 1-6.5 kW). Covers the one definition
# (bridge/pump_power.py) and both publishers: the hub state frame and the analytics-mirror export.
from types import SimpleNamespace

from bridge.config import AnalyticsConfig, HubConfig
from bridge.exporter import Exporter
from bridge.hub_client import HubClient
from bridge.pump_power import MAX_AGE_S, PumpPower, inverter_power_raw, power_fields

CIRCUITS = {"pump1": "Air-Water 1", "pump2": "Air-Water 2"}


def span(powers: dict, *, mono: float | None = 1000.0):
    """A SpanLocalPoller's cache as note_circuits leaves it. A value of ... means the circuit is absent."""
    latest = {name: None if w is ... else {"circuit_id": name, "name": name, "relay_state": "CLOSED",
                                           "controllable": True, "power_w": w}
              for name, w in powers.items()}
    return SimpleNamespace(latest_circuits=latest, latest_circuits_mono=mono)


def pp(poller, *, now: float = 1010.0, circuits=CIRCUITS):
    return PumpPower(poller, circuits, monotonic=lambda: now)


def test_power_is_the_circuits_magnitude_this_panel_reports_consumption_negative():
    p = pp(span({"Air-Water 1": -4633.4, "Air-Water 2": -36.0}))
    assert p.watts("pump1") == 4633.4
    assert p.watts("pump2") == 36.0
    assert pp(span({"Air-Water 1": 5200.0})).watts("pump1") == 5200.0   # a positive reading is the same draw


def test_the_real_case_registers_say_23_while_the_circuit_draws_kilowatts():
    snap = {"power_sys1": 14, "power_sys2": 9}
    f = pp(span({"Air-Water 1": -4633.0})).fields("pump1", snap)
    assert f == {"power_w": 4633.0, "power_source": "span", "inverter_power_raw": 23}
    assert inverter_power_raw({}) == 0 and inverter_power_raw({"power_sys1": None, "power_sys2": 7}) == 7


def test_unknown_is_none_never_zero_and_never_the_register():
    snap = {"power_sys1": 14, "power_sys2": 9}
    cases = {
        "stale read": pp(span({"Air-Water 1": -4000.0}), now=1000.0 + MAX_AGE_S + 1),
        "never read": pp(span({"Air-Water 1": -4000.0}, mono=None)),
        "circuit missing from the read": pp(span({"Air-Water 1": ...})),
        "circuit not in the cache": pp(span({"Air-Water 2": -10.0})),
        "panel gave no power": pp(span({"Air-Water 1": None})),
        "junk power": pp(span({"Air-Water 1": "4000"})),
        "bool power": pp(span({"Air-Water 1": True})),
        "NaN power": pp(span({"Air-Water 1": float("nan")})),
        "pump not mapped": pp(span({"Air-Water 1": -4000.0}), circuits={"pump2": "Air-Water 2"}),
        "no SPAN poller": pp(None),
    }
    for label, p in cases.items():
        assert p.fields("pump1", snap) == {"power_w": None, "power_source": None, "inverter_power_raw": 23}, label
    assert power_fields(None, "pump1", snap) == {"power_w": None, "power_source": None, "inverter_power_raw": 23}


def test_a_zero_reading_is_a_real_zero_and_fresh_at_exactly_the_limit():
    p = pp(span({"Air-Water 1": 0.0}), now=1000.0 + MAX_AGE_S)
    assert p.fields("pump1", {}) == {"power_w": 0.0, "power_source": "span", "inverter_power_raw": 0}


def test_a_broken_cache_never_raises():
    broken = SimpleNamespace(latest_circuits="not a dict", latest_circuits_mono=1000.0)
    assert pp(broken).watts("pump1") is None


def _poller(pid: str, snap: dict):
    stats = SimpleNamespace(as_dict=lambda: {"error_rate": 0.0})
    return SimpleNamespace(cfg=SimpleNamespace(id=pid, name=pid.title(), write_enabled=True),
                           snapshot={"online": True, "state": "heating", **snap},
                           client=SimpleNamespace(stats=stats))


def test_hub_state_frame_carries_metered_watts_not_the_registers():
    pollers = {"pump1": _poller("pump1", {"power_sys1": 14, "power_sys2": 9}),
               "pump2": _poller("pump2", {"power_sys1": 0, "power_sys2": 0})}
    hc = HubClient(HubConfig(), pollers)
    hc.pump_power = pp(span({"Air-Water 1": -4633.0, "Air-Water 2": -36.0}))
    p1, p2 = hc._state_payload()["pumps"]
    assert (p1["power_w"], p1["power_source"], p1["inverter_power_raw"]) == (4633.0, "span", 23)
    assert (p2["power_w"], p2["power_source"], p2["inverter_power_raw"]) == (36.0, "span", 0)
    # without a panel reading the frame says unknown; the old behaviour published 23 as watts
    hc.pump_power = None
    p1 = hc._state_payload()["pumps"][0]
    assert p1["power_w"] is None and p1["power_source"] is None and p1["inverter_power_raw"] == 23


def test_mirror_export_carries_the_same_three_fields(tmp_path):
    pollers = {"pump1": _poller("pump1", {"power_sys1": 14, "power_sys2": 9, "active_faults": []})}
    ex = Exporter(AnalyticsConfig(), pollers, store=None, db_path=str(tmp_path / "bridge.db"))
    ex.pump_power = pp(span({"Air-Water 1": -4633.0}))
    row = ex.snapshot()["pumps"][0]
    assert (row["power_w"], row["power_source"], row["inverter_power_raw"]) == (4633.0, "span", 23)
    ex.pump_power = None
    assert ex.snapshot()["pumps"][0]["power_w"] is None


# --- against the real SPAN poller and the real app ---------------------------------------------------------------

async def test_real_span_poller_cache_feeds_it_on_both_transports(tmp_path, span_transport):
    """The shipped defaults end to end: SpanConfig's default breakers, a real poll of the (fake) panel on v1 and on
    v2, and self_heal's default pump->circuit map. This is the wiring main.py does."""
    from bridge.config import SelfHealConfig, SpanConfig
    from bridge.span_local import SpanLocalPoller
    from bridge.store import Store
    from sim.fake_span import FakeSpan

    panel = FakeSpan()                      # Air-Water 1 draws -2400 W, Air-Water 2 -108 W out of the box
    addr = panel.start()
    store = Store(str(tmp_path / "b.db"))
    await store.open()
    try:
        poller = SpanLocalPoller(SpanConfig(host=addr, passphrase="pw"), store, token_path=str(tmp_path / "tok"))
        power = PumpPower(poller, SelfHealConfig().circuits)
        assert power.watts("pump1") is None             # nothing read yet: unknown, not 0
        await poller.poll_once()
        assert power.watts("pump1") == 2400.0 and power.watts("pump2") == 108.0
        panel.set("Air-Water 1", instantPowerW=-5436.0)
        await poller.poll_once()
        assert power.fields("pump1", {"power_sys1": 15, "power_sys2": 12}) == {
            "power_w": 5436.0, "power_source": "span", "inverter_power_raw": 27}
        poller.client.close()
    finally:
        await store.close()
        panel.stop()


def test_app_wires_one_pump_power_into_every_publisher_and_the_status_route(tmp_path):
    from fastapi.testclient import TestClient

    from bridge.config import AppConfig, AuthConfig, PumpConfig
    from bridge.main import create_app

    cfg = AppConfig(pumps=[PumpConfig(id="pump1", name="P1", host="127.0.0.1", port=59999, poll_interval_s=999)],
                    auth=AuthConfig(protect="off"), db_path=str(tmp_path / "b.db"), ui_dir="ui")
    app = create_app(cfg)
    with TestClient(app) as c:
        assert isinstance(app.state.pump_power, PumpPower)
        assert app.state.pump_power.span_poller is app.state.span_poller
        body = c.get("/api/pumps/pump1/status").json()
        # no SPAN configured in this rig: the route says unknown rather than passing a register off as watts
        assert body["power_w"] is None and body["power_source"] is None and "inverter_power_raw" in body
        # with a panel reading in the poller's cache the same route reports it
        app.state.span_poller.latest_circuits = {"Air-Water 1": {"power_w": -4100.0}}
        app.state.span_poller.latest_circuits_mono = app.state.pump_power._monotonic()
        assert c.get("/api/pumps/pump1/status").json()["power_w"] == 4100.0
