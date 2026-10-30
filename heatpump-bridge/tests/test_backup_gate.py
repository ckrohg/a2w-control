# @purpose: The bridge half of the backup-element gate (owner rule 2026-10-19), against the real BreakerController
# and a fake SPAN panel (sim/fake_span.py), time injected:
#   - span.backup_reopen: OFF by default (the element stays close-only); ON, an OPEN of the Buffer Tank goes through the
#     Air-Water guards (OpenPermit, read-back, audit, page) plus its own — never while the element draws power, never
#     while the owner's arm intent is ARMED; power_cycle stays refused; allow_open stays refused in config;
#   - backup_fallback.py (every pump down for hold_min → close, no cloud): SHADOW by default (audit + page "would close",
#     nothing switched), live closes and never opens, one pump up = nothing, a Modbus-stale pump the panel shows running
#     is not down, already-ON is a no-op, a refusal retries, cooldown, and its status rides the hub state frame.
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from bridge import backup_fallback as bf_mod
from bridge import span_control
from bridge.backup_fallback import BackupFallback
from bridge.config import BackupFallbackConfig, BreakerCircuit, SpanConfig
from bridge.span_control import BreakerController, BreakerRefused
from bridge.span_local import SpanLocalPoller, write_arm_intent
from bridge.store import Store
from sim.fake_span import FakeSpan


class FakeTime:
    def __init__(self):
        self.t = 1_800_000_000.0

    def clock(self) -> float:
        return self.t

    async def sleep(self, s: float) -> None:
        self.t += s
        await asyncio.sleep(0)


class FakePoller:
    def __init__(self, pid, name, ft):
        self.cfg = SimpleNamespace(id=pid, name=name)
        self.ft = ft
        self.snapshot = {"online": True, "last_poll_ts": ft.clock(), "last_poll_mono": ft.clock(),
                         "running": False, "state": "idle", "active_faults": [], "on": True}

    def fresh(self):
        self.snapshot.update(last_poll_ts=self.ft.clock(), last_poll_mono=self.ft.clock())

    def fault(self, code="E21"):
        self.snapshot["active_faults"] = [{"code": code, "severity": "warning", "since": self.ft.clock()}]
        self.snapshot["state"] = "fault"


@pytest.fixture
def alerts(monkeypatch):
    sent: list[tuple[str, str, str]] = []

    # "push" = the owner's phone (6bb), "email" = their inbox, "log" = ntfy (reaches nobody: the record tier)
    async def ntfy(cfg, *, title, message, priority="default", tags=""):
        sent.append(("log", title, priority, message))

    async def sixbb_push(cfg, *, title, message, priority, tag=""):
        sent.append(("push", title, priority))
        return True

    async def email(cfg, *, subject, body, html=None):
        sent.append(("email", subject, body))

    for mod in (span_control, bf_mod):
        monkeypatch.setattr(mod.notify, "ntfy", ntfy)
        monkeypatch.setattr(mod.notify, "email", email)
        monkeypatch.setattr(mod.notify, "sixbb_push", sixbb_push)
    return sent


@pytest.fixture
async def rig(tmp_path, alerts):
    panel = FakeSpan()
    panel.set("Buffer Tank", relayState="OPEN", instantPowerW=0.0)   # the owner's default: element OFF
    panel.set("Air-Water 1", instantPowerW=-8.0)
    panel.set("Air-Water 2", instantPowerW=-8.0)
    addr = panel.start()
    store = Store(str(tmp_path / "b.db"))
    await store.open()
    ft = FakeTime()

    def controller(**span_kw):
        cfg = SpanConfig(host=addr, passphrase="pw", close_retry_delay_s=1.0,
                         breakers=[BreakerCircuit(name="Air-Water 1", allow_cycle=True, heat_pump=True),
                                   BreakerCircuit(name="Air-Water 2", allow_cycle=True, heat_pump=True),
                                   BreakerCircuit(name="Buffer Tank")], **span_kw)
        poller = SpanLocalPoller(cfg, store, arm_state_path=str(tmp_path / "span-arm.json"))
        ctl = BreakerController(cfg, poller.client, store, cache=poller, state_dir=str(tmp_path),
                                sleep=ft.sleep, clock=ft.clock, mono=ft.clock)
        return poller, ctl

    poller, ctl = controller()
    p1, p2 = FakePoller("pump1", "Heat Pump 1", ft), FakePoller("pump2", "Heat Pump 2", ft)

    async def prime(pl=None):
        pl = pl or poller
        pl.note_circuits(await pl.client.fetch_circuits(), ft.clock(), ft.clock())

    def fallback(c=None, **cfg):
        return BackupFallback(BackupFallbackConfig(**cfg), {"pump1": p1, "pump2": p2}, c or ctl, store,
                              clock=ft.clock, mono=ft.clock)

    async def step(fb, seconds=60.0, *, stale=(), span=True):
        ft.t += seconds
        for p in (p1, p2):
            if p.cfg.id not in stale:
                p.fresh()
        if span:
            await prime()
        await fb.tick()

    yield SimpleNamespace(panel=panel, ctl=ctl, poller=poller, ft=ft, store=store, alerts=alerts, p1=p1, p2=p2,
                          prime=prime, fallback=fallback, step=step, controller=controller, tmp_path=tmp_path)
    await ctl.stop()
    await store.close()
    panel.stop()
    assert panel.rejected == [], f"schema-rejected writes: {panel.rejected}"


async def fb_events(store):
    return [e["code"] for e in await store.get_events("span", 1) if e["type"] == "backup_fallback"]


async def settle():
    await asyncio.sleep(0.05)


# --- span.backup_reopen ------------------------------------------------------------------------------------------
async def test_reopen_is_off_by_default(rig):
    rig.panel.set("Buffer Tank", relayState="CLOSED")
    assert SpanConfig().backup_reopen is False
    with pytest.raises(BreakerRefused, match=r"close-only \(re-open is disabled: span.backup_reopen"):
        await rig.ctl.execute("Buffer Tank", "open")
    assert rig.panel.writes == []


async def test_reopen_enabled_uses_the_guarded_open_path(rig):
    poller, ctl = rig.controller(backup_reopen=True)
    rig.panel.set("Buffer Tank", relayState="CLOSED", instantPowerW=0.0)
    r = await ctl.execute("Buffer Tank", "open", source="hub:backup-gate")
    assert r["ok"] and r["verified"] and r["relay_state"] == "OPEN"
    assert rig.panel.writes == [("Buffer Tank", "OPEN")]
    ev = [e for e in await rig.store.get_events("span", 1) if e["type"] == "span_breaker"]
    assert ev[0]["code"] == "opened" and "hub:backup-gate" in ev[0]["message"]
    await settle()
    assert any("Buffer Tank OFF" in a[1] for a in rig.alerts if a[0] == "log")
    assert not any("Buffer Tank OFF" in a[1] for a in rig.alerts if a[0] in ("push", "email")), "an OFF is record-only"
    # the minimum off time applies to the element too, then it can be closed again
    with pytest.raises(BreakerRefused, match="minimum off time"):
        await ctl.execute("Buffer Tank", "close")
    rig.ft.t += 61
    assert (await ctl.execute("Buffer Tank", "close"))["ok"]
    await ctl.stop()


async def test_reopen_refuses_a_live_element_and_an_armed_intent(rig):
    poller, ctl = rig.controller(backup_reopen=True)
    rig.panel.set("Buffer Tank", relayState="CLOSED", instantPowerW=-16_400.0)   # element firing
    with pytest.raises(BreakerRefused, match="drawing 16400 W — never switch a live"):
        await ctl.execute("Buffer Tank", "open")
    rig.panel.set("Buffer Tank", instantPowerW=0.0)
    write_arm_intent(str(rig.tmp_path / "span-arm.json"), True)
    with pytest.raises(BreakerRefused, match="arm intent is ARMED"):
        await ctl.execute("Buffer Tank", "open")
    with pytest.raises(BreakerRefused, match="power cycle is not allowed"):
        await ctl.execute("Buffer Tank", "power_cycle")
    assert rig.panel.writes == []
    await ctl.stop()


def test_reopen_flag_does_not_unlock_allow_open():
    with pytest.raises(ValidationError, match="backup element"):
        SpanConfig(backup_reopen=True, breakers=[BreakerCircuit(name="Buffer Tank", allow_open=True)])


# --- backup_fallback ---------------------------------------------------------------------------------------------
async def test_fallback_shadow_pages_once_and_switches_nothing(rig):
    fb = rig.fallback()
    assert fb.status()["mode"] == "shadow"
    rig.p1.fault(); rig.p2.fault()
    await rig.step(fb, 0)
    for _ in range(29):
        await rig.step(fb)
    assert await fb_events(rig.store) == [], "nothing before 30 min"
    await rig.step(fb)
    await settle()
    assert await fb_events(rig.store) == ["would_close"]
    assert any(a[0] == "log" and "WOULD close" in a[1] for a in rig.alerts), "shadow: logged"
    assert not any(a[0] == "email" for a in rig.alerts), "shadow never emails (alert-policy.md)"
    assert not any(a[0] == "push" for a in rig.alerts), "shadow is never a phone push (#211: high/urgent push via 6bb)"
    assert rig.panel.writes == []
    for _ in range(60):
        await rig.step(fb)
    assert await fb_events(rig.store) == ["would_close"], "one decision per episode"
    st = fb.status()
    assert st["all_down_min"] >= 90 and st["relay"] == "OPEN" and st["down"]["pump1"].startswith("is faulted")


async def test_fallback_needs_every_pump_down(rig):
    fb = rig.fallback(live=True)
    rig.p2.fault()
    for _ in range(120):
        await rig.step(fb)
    assert await fb_events(rig.store) == [] and rig.panel.writes == []
    # a P17-style info protection is not a failure either
    rig.p1.snapshot["active_faults"] = [{"code": "P17", "severity": "info"}]
    for _ in range(60):
        await rig.step(fb)
    assert rig.panel.writes == []


async def test_fallback_stale_pump_running_per_span_is_not_down(rig):
    fb = rig.fallback(live=True)
    rig.p2.fault()
    rig.panel.set("Air-Water 1", instantPowerW=-5600.0)            # pump1's gateway is dead but it heats
    for _ in range(60):
        await rig.step(fb, stale=("pump1",))
    assert rig.panel.writes == []
    assert fb.status()["down"]["pump1"] is None
    # the compressor stops (circuit idle) while Modbus stays dead → down; 30 min later the breaker closes
    rig.panel.set("Air-Water 1", instantPowerW=-8.0)
    for _ in range(31):
        await rig.step(fb, stale=("pump1",))
    assert rig.panel.writes == [("Buffer Tank", "CLOSED")]
    assert "draws 8 W" in fb.status()["down"]["pump1"]


async def test_fallback_live_closes_never_opens_and_respects_cooldown(rig):
    fb = rig.fallback(live=True)
    rig.p1.fault(); rig.p2.fault()
    for _ in range(31):
        await rig.step(fb)
    await settle()
    assert rig.panel.writes == [("Buffer Tank", "CLOSED")] and rig.panel.relay("Buffer Tank") == "CLOSED"
    assert await fb_events(rig.store) == ["closed"]
    assert any("A2W closed the backup element breaker" in a[1] for a in rig.alerts if a[0] == "email"), "attention: email"
    assert not any("A2W closed the backup element breaker" in a[1] for a in rig.alerts if a[0] == "push"), "not a page"
    # recovered, then down again within the 6-h cooldown: no second decision
    rig.p1.snapshot.update(active_faults=[], state="idle")
    await rig.step(fb)
    rig.panel.set("Buffer Tank", relayState="OPEN")                 # the owner switched it off again
    rig.p1.fault()
    for _ in range(90):
        await rig.step(fb)
    assert rig.panel.writes == [("Buffer Tank", "CLOSED")], "cooldown: one close per 6 h"
    assert all(w[1] != "OPEN" for w in rig.panel.writes), "the fallback never opens"


async def test_fallback_already_on_is_a_quiet_no_op(rig):
    rig.panel.set("Buffer Tank", relayState="CLOSED")
    fb = rig.fallback(live=True)
    rig.p1.fault(); rig.p2.fault()
    for _ in range(31):
        await rig.step(fb)
    await settle()
    assert rig.panel.writes == [] and await fb_events(rig.store) == ["already_available"]
    assert not any(a[0] == "push" for a in rig.alerts)


async def test_fallback_refusal_pages_once_and_retries(rig):
    rig.panel.set("Buffer Tank", isUserControllable=False)
    fb = rig.fallback(live=True)
    rig.p1.fault(); rig.p2.fault()
    for _ in range(31):
        await rig.step(fb)
    await settle()
    assert await fb_events(rig.store) == ["refused"]
    urgent = [a for a in rig.alerts if a[0] == "push" and a[2] == "urgent"]
    assert len(urgent) == 1 and "refused" in urgent[0][1]
    rig.panel.set("Buffer Tank", isUserControllable=True)
    for _ in range(5):                                               # retried after 5 min
        await rig.step(fb)
    assert rig.panel.writes == [("Buffer Tank", "CLOSED")]
    assert (await fb_events(rig.store))[:2] == ["closed", "refused"]  # newest first


async def test_fallback_unexpected_error_is_retried_not_latched(rig, monkeypatch):
    fb = rig.fallback(live=True)
    calls = []
    real = rig.ctl.execute

    async def flaky(*a, **kw):
        calls.append(a)
        if len(calls) == 1:
            raise RuntimeError("panel hiccup")
        return await real(*a, **kw)
    monkeypatch.setattr(rig.ctl, "execute", flaky)
    rig.p1.fault(); rig.p2.fault()
    for _ in range(36):
        await rig.step(fb)
    assert len(calls) == 2 and rig.panel.writes == [("Buffer Tank", "CLOSED")]


async def test_fallback_a_deliberate_off_is_never_down(rig):
    fb = rig.fallback(live=True)
    for p in (rig.p1, rig.p2):                       # the owner switches both units off (maintenance / summer / 6bb)
        p.snapshot.update(on=False, state="off")
    for _ in range(90):
        await rig.step(fb)
    assert rig.panel.writes == [] and await fb_events(rig.store) == []
    assert {v["state"] for v in fb.status()["pumps"].values()} == {"off"}
    # both Air-Water breakers switched OFF at the panel, Modbus gone with them: still deliberate, still nothing
    for p in (rig.p1, rig.p2):
        p.snapshot.update(on=True, state="idle")
    rig.panel.set("Air-Water 1", relayState="OPEN", instantPowerW=0.0)
    rig.panel.set("Air-Water 2", relayState="OPEN", instantPowerW=0.0)
    for _ in range(90):
        await rig.step(fb, stale=("pump1", "pump2"))
    assert rig.panel.writes == []


async def test_fallback_pi_network_drop_is_unknown_not_down(rig):
    fb = rig.fallback(live=True)
    rig.p1.fault(); rig.p2.fault()
    for _ in range(20):                               # 20 min of a real both-down...
        await rig.step(fb)
    assert fb.status()["all_down_min"] is not None
    for _ in range(90):                               # ...then the Pi's Wi-Fi drops: Modbus AND the panel go stale
        await rig.step(fb, stale=("pump1", "pump2"), span=False)
    st = fb.status()
    assert st["all_down_min"] is None, "unknown resets the episode"
    assert {v["state"] for v in st["pumps"].values()} == {"unknown"}
    assert rig.panel.writes == [] and await fb_events(rig.store) == []
    # stale Modbus with a fresh panel that reports no draw at all is unknown too
    rig.panel.set("Air-Water 1", instantPowerW=None)
    await rig.step(fb, stale=("pump1",))
    assert fb.status()["pumps"]["pump1"]["state"] == "unknown"


async def test_reopen_refuses_an_unknown_draw_and_rereads_at_dispatch(rig, monkeypatch):
    poller, ctl = rig.controller(backup_reopen=True)
    rig.panel.set("Buffer Tank", relayState="CLOSED", instantPowerW=None)
    with pytest.raises(BreakerRefused, match="draw is unknown"):
        await ctl.execute("Buffer Tank", "open")
    # idle at the decision, but the HBX fires the element before the OPEN goes out: the fresh read refuses it
    rig.panel.set("Buffer Tank", instantPowerW=0.0)
    real = ctl.client._fetch_locked
    reads = []

    def fetch_then_fire():
        reads.append(1)
        if len(reads) == 2:                            # 1st: the decision's read; 2nd: the dispatch guard's
            rig.panel.set("Buffer Tank", instantPowerW=-16_400.0)
        return real()
    monkeypatch.setattr(ctl.client, "_fetch_locked", fetch_then_fire)
    with pytest.raises(BreakerRefused, match="drawing 16400 W"):
        await ctl.execute("Buffer Tank", "open")
    assert rig.panel.writes == [] and len(reads) >= 2
    await ctl.stop()


async def test_fallback_status_rides_the_hub_state_frame(rig):
    from bridge.hub_client import HubClient
    from bridge.config import HubConfig
    fb = rig.fallback()
    hc = HubClient(HubConfig(), {})
    hc.span = rig.ctl
    hc.backup_fallback = fb
    await rig.prime()
    frame = hc._state_payload()
    assert frame["span"]["backup_fallback"]["mode"] == "shadow"
    assert frame["span"]["backup_fallback"]["circuit"] == "Buffer Tank"
    json.dumps(frame)   # serialisable


# --- #241 generator budget: the Pi always assumes it may be on the ~24 kW generator ----------------------------------
def test_house_load_sums_every_circuit_but_the_element():
    from bridge.span_local import house_load_w
    circuits = {"a": {"name": "Air-Water 1", "instantPowerW": -5100.0}, "b": {"name": "Buffer Tank", "instantPowerW": -16400.0},
                "c": {"name": "Kitchen", "instantPowerW": -50.0}, "d": {"name": "EV Charger", "instantPowerW": None}}
    assert house_load_w(circuits) == 5150.0, "abs of every circuit, the element's excluded, an unknown one skipped"
    assert house_load_w({"b": {"name": "Buffer Tank", "instantPowerW": 0.0}}) is None
    assert house_load_w({}) is None


async def test_fallback_budget_fits_a_normal_house(rig):
    fb = rig.fallback()
    rig.p1.fault(); rig.p2.fault()
    for _ in range(31):
        await rig.step(fb)
    assert await fb_events(rig.store) == ["would_close"], "both pumps idle at 8 W + a 50 W kitchen: the element fits"
    assert rig.ctl.snapshot()["house_w"] == 66.0
    b = fb.status()["budget"]
    assert b["fits"] is True and b["projected_w"] == 66 + 16500 + 2400
    events = await rig.store.get_events("span", 1)
    assert events[0]["detail"]["budget"]["fits"] is True


async def test_fallback_generator_budget_holds_the_element_off_until_the_load_drops(rig):
    rig.panel.circuits["EV Charger"] = {"id": "c-ev", "relayState": "CLOSED", "isUserControllable": True,
                                        "instantPowerW": -7200.0}
    fb = rig.fallback(live=True)
    rig.p1.fault(); rig.p2.fault()
    for _ in range(90):
        await rig.step(fb)
    await settle()
    assert rig.panel.writes == [], "7.3 kW of house + 16.5 + 2.4 = 26.2 kW > 24: never closed, even live"
    assert await fb_events(rig.store) == ["generator_budget"], "noted once per episode"
    pages = [a for a in rig.alerts if a[0] == "push"]
    assert len(pages) == 1 and "generator budget" in pages[0][1], "live: both pumps down with the element held off pages"
    assert "26.2 kW exceeds the 24.0 kW generator cap" in fb.status()["last"]["message"]
    # the EV stops: the next tick closes
    rig.panel.set("EV Charger", instantPowerW=-2.0)
    await rig.step(fb)
    assert rig.panel.writes == [("Buffer Tank", "CLOSED")]
    assert (await fb_events(rig.store))[0] == "closed"


async def test_fallback_shadow_budget_refusal_is_record_only(rig):
    rig.panel.circuits["EV Charger"] = {"id": "c-ev", "relayState": "CLOSED", "isUserControllable": True,
                                        "instantPowerW": -7200.0}
    fb = rig.fallback()
    rig.p1.fault(); rig.p2.fault()
    for _ in range(40):
        await rig.step(fb)
    await settle()
    assert await fb_events(rig.store) == ["generator_budget"]
    assert any(a[0] == "log" and "generator budget says no" in a[1] for a in rig.alerts)
    assert not any(a[0] in ("email", "push") for a in rig.alerts), "shadow stays record (alert-policy.md)"
    assert rig.panel.writes == []


async def test_fallback_unknown_house_load_never_closes(rig):
    for name in list(rig.panel.circuits):
        rig.panel.set(name, instantPowerW=None)
    fb = rig.fallback(live=True)
    rig.p1.fault(); rig.p2.fault()
    for _ in range(60):
        await rig.step(fb)
    assert rig.panel.writes == []
    assert fb.status()["budget"] == {"fits": False, "house_w": None, "projected_w": None,
                                     "why": "the live house load is unknown (no fresh panel read)"}


def test_generator_budget_config_bounds():
    c = BackupFallbackConfig()
    assert (c.generator_cap_w, c.generator_margin_w, c.element_w) == (24000.0, 2400.0, 16500.0)
    with pytest.raises(ValidationError):
        BackupFallbackConfig(generator_cap_w=100000)
