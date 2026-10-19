# @purpose: Self-heal (#189, bridge/self_heal.py) against the real BreakerController and a fake
# SPAN panel (sim/fake_span.py), with pump snapshots faked and time injected: the E21 grace,
# never while heating / in defrost, SHADOW by default (logs "would cycle", switches nothing),
# the live cycle + 15-min verification (recovered / not recovered), 2 attempts per 6 h then
# escalate, never with the other pump down, SPAN unreachable -> manual page, a suspicious
# pump<->circuit mapping refused, the budget surviving a restart, and /api/health.self_heal.
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from bridge import self_heal as sh_mod
from bridge import span_control
from bridge.config import AppConfig, PumpConfig, SelfHealConfig, SpanConfig
from bridge.self_heal import SelfHealer
from bridge.span_control import BreakerController
from bridge.span_local import SpanLocalPoller
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
        self.snapshot = {"online": True, "last_poll_ts": ft.t, "running": False,
                         "defrosting": False, "state": "idle", "active_faults": []}

    def fresh(self, **kw):
        self.snapshot.update(last_poll_ts=self.ft.t, **kw)

    def fault(self, code="E21", age_min=11.0, severity="warning"):
        self.snapshot["active_faults"] = [{"key": "2111.13", "code": code, "severity": severity,
                                           "since": self.ft.t - age_min * 60, "message": "x"}]
        self.snapshot["state"] = "fault"

    def clear(self):
        self.snapshot["active_faults"] = []
        self.snapshot["state"] = "idle"


@pytest.fixture
def alerts(monkeypatch):
    sent: list[tuple[str, str, str]] = []

    async def ntfy(cfg, *, title, message, priority="default", tags=""):
        sent.append(("push", title, priority))

    async def email(cfg, *, subject, body):
        sent.append(("email", subject, body))

    for mod in (span_control, sh_mod):
        monkeypatch.setattr(mod.notify, "ntfy", ntfy)
        monkeypatch.setattr(mod.notify, "email", email)
    return sent


@pytest.fixture
async def rig(tmp_path, alerts):
    panel = FakeSpan()
    panel.set("Air-Water 2", instantPowerW=15.0)      # the faulted pump's circuit, idle
    addr = panel.start()
    span = SpanConfig(host=addr, passphrase="pw", close_retry_delay_s=1.0)
    store = Store(str(tmp_path / "b.db"))
    await store.open()
    ft = FakeTime()
    poller = SpanLocalPoller(span, store)
    ctl = BreakerController(span, poller.client, store, cache=poller, state_dir=str(tmp_path),
                            sleep=ft.sleep, clock=ft.clock, mono=ft.clock)
    p1, p2 = FakePoller("pump1", "Heat Pump 1", ft), FakePoller("pump2", "Heat Pump 2", ft)

    def make(**cfg):
        return SelfHealer(SelfHealConfig(**cfg), {"pump1": p1, "pump2": p2}, ctl, store,
                          state_dir=str(tmp_path), clock=ft.clock)

    async def prime():   # the controller's cache needs one panel read (the poll loop does this)
        poller.note_circuits(await poller.client.fetch_circuits(), ft.t)

    await prime()
    yield SimpleNamespace(panel=panel, ctl=ctl, ft=ft, p1=p1, p2=p2, make=make, store=store,
                          alerts=alerts, prime=prime, tmp_path=tmp_path)
    await ctl.stop()
    await store.close()
    panel.stop()


async def codes(store, pid="pump2"):
    return [e["code"] for e in await store.get_events(pid, 1) if e["type"] == "self_heal"]


async def settle():
    await asyncio.sleep(0.05)   # let fire-and-forget alert tasks run


async def test_shadow_is_the_default_and_switches_nothing(rig):
    r = rig
    r.p2.fault(age_min=11)
    heal = r.make()
    assert heal.status()["mode"] == "shadow"
    await heal.tick()
    await settle()
    assert r.panel.writes == []
    assert await codes(r.store) == ["would_cycle"]
    assert any("would cycle" in a[1] for a in r.alerts if a[0] == "push")
    assert any(a[0] == "email" for a in r.alerts)
    st = heal.status()["pumps"]["pump2"]
    assert st["attempts_in_window"] == 1 and "SHADOW" in st["status"]
    assert heal.status()["trigger"]["stage_call"].startswith("unavailable")
    # it does not re-log every tick while it watches
    await heal.tick()
    assert await codes(r.store) == ["would_cycle"]


async def test_grace_heating_defrost_and_stale_all_hold_off(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=5)                                   # inside the 10 min grace
    await heal.tick()
    r.p2.fault(age_min=11)
    r.p2.fresh(running=True)                                # heating
    await heal.tick()
    r.p2.fresh(running=False)                               # stopped just now: anti-short-cycle
    await heal.tick()
    r.ft.t += 200
    r.p1.fresh(); r.p2.fresh(defrosting=True)               # defrost
    await heal.tick()
    r.p2.fresh(defrosting=False)
    r.p2.snapshot["last_poll_ts"] = r.ft.t - 300            # stale snapshot
    await heal.tick()
    assert r.panel.writes == []
    assert await codes(r.store) == []


async def test_live_cycle_then_recovery_verified(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await heal.tick()
    assert r.panel.writes == [("Air-Water 2", "OPEN"), ("Air-Water 2", "CLOSED")]
    assert await codes(r.store) == ["cycle_start"]
    assert heal.status()["pumps"]["pump2"]["phase"] == "verifying"
    # the pump comes back: fault gone, idle (no call) — held cleared for 3 min
    r.p2.clear()
    for _ in range(8):
        r.ft.t += 30
        r.p1.fresh(); r.p2.fresh()
        await heal.tick()
    await settle()
    assert "recovered" in await codes(r.store)
    assert heal.status()["pumps"]["pump2"]["last_outcome"]["outcome"] == "recovered"
    assert any("recovered" in a[1] for a in r.alerts if a[0] == "push")


async def test_two_failures_escalate_instead_of_looping(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)

    async def run(minutes):
        for _ in range(int(minutes * 2)):
            r.ft.t += 30
            r.p1.fresh(); r.p2.fresh()
            await heal.tick()

    await heal.tick()                       # attempt 1
    await run(16)                           # verify window passes: not recovered -> attempt 2
    await run(16)                           # not recovered again -> escalate
    await run(30)                           # and it stays escalated: no third cycle
    await settle()
    opens = [w for w in r.panel.writes if w[1] == "OPEN"]
    assert len(opens) == 2
    c = await codes(r.store)
    assert c.count("cycle_start") == 2 and c.count("not_recovered") == 2
    assert c.count("escalated") == 1
    assert any(a[2] == "urgent" for a in r.alerts if a[0] == "push")
    assert "escalated" in heal.status()["pumps"]["pump2"]["status"]


async def test_budget_survives_a_restart(rig):
    r = rig
    r.p2.fault(age_min=12)
    heal = r.make(live=True)
    await heal.tick()
    heal2 = r.make(live=True)               # a bridge restart: same state dir
    assert heal2.status()["pumps"]["pump2"]["attempts_in_window"] == 1


async def test_other_pump_down_pages_once_and_does_not_cycle(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    r.p1.snapshot["online"] = False
    for _ in range(3):
        r.ft.t += 30
        r.p2.fresh()
        await heal.tick()
    await settle()
    assert r.panel.writes == []
    assert (await codes(r.store)).count("both_down") == 1
    assert any("both heat pumps" in a[1] for a in r.alerts if a[0] == "push")
    # the other pump faulted (not just offline) counts too
    r.p1.snapshot["online"] = True
    r.p1.fault(code="E18", severity="high")
    r.p1.fresh()
    heal2 = r.make(live=True)
    await heal2.tick()
    assert r.panel.writes == []


async def test_cold_span_cache_waits_instead_of_paging_both_down(rig):
    r = rig
    r.ctl.cache.latest_circuits = {}                   # just booted: no panel read yet
    r.ctl.cache.latest_circuits_ts = None
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await heal.tick()
    await settle()
    assert r.panel.writes == [] and await codes(r.store) == []
    assert "waiting for a SPAN panel read" in heal.status()["pumps"]["pump2"]["status"]
    await r.prime()
    await heal.tick()
    assert ("Air-Water 2", "OPEN") in r.panel.writes


async def test_span_unreachable_pages_the_manual_step(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    r.panel.down = True
    await heal.tick()
    await settle()
    assert [w for w in r.panel.writes if w[1] == "OPEN"] == []
    assert "cycle_refused" in await codes(r.store)
    mail = [a for a in r.alerts if a[0] == "email" and "manual" in a[1]]
    assert mail and "SPAN panel" in mail[0][2]


async def test_suspicious_mapping_is_refused(rig):
    r = rig
    r.panel.set("Air-Water 2", instantPowerW=2600.0)   # "idle" pump's circuit draws compressor power
    await r.prime()
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await heal.tick()
    await settle()
    assert r.panel.writes == []
    assert "mapping_suspect" in await codes(r.store)


def test_config_guards():
    with pytest.raises(ValueError, match="off_s"):
        SelfHealConfig(off_s=30)
    d = SelfHealConfig()
    assert d.live is False and d.fault_codes == ["E21"] and d.grace_min == 10
    assert d.max_attempts == 2 and d.window_h == 6 and d.verify_min == 15
    assert d.circuits == {"pump1": "Air-Water 1", "pump2": "Air-Water 2"}
    with pytest.raises(ValueError, match="self_heal.circuits"):
        AppConfig(pumps=[PumpConfig(id="pump1", name="P1", host="h")],
                  self_heal=SelfHealConfig(circuits={"pump1": "Buffer Tank"}))


def test_health_reports_self_heal(tmp_path):
    cfg = AppConfig(pumps=[PumpConfig(id="pump1", name="P1", host="127.0.0.1", port=59999,
                                      poll_interval_s=999)],
                    db_path=str(tmp_path / "b.db"), ui_dir="ui")
    from bridge.main import create_app
    with TestClient(create_app(cfg)) as c:
        h = c.get("/api/health").json()
        assert h["self_heal"]["mode"] == "shadow"
        assert h["self_heal"]["breaker_control"] is False
        assert set(h["self_heal"]["pumps"]) == {"pump1", "pump2"}
