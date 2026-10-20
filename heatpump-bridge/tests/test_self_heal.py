# @purpose: Self-heal (#189, bridge/self_heal.py) against the real BreakerController and a fake
# SPAN panel (sim/fake_span.py), with pump snapshots faked and time injected: the E21 grace (wall
# AND in-process), never while heating / in defrost / on a failed identity check, SHADOW by default
# (logs "would cycle", switches nothing), the live cycle + 15-min verification (recovered / not
# recovered / replaced by another fault / telemetry gap restarts the hold), 2 attempts per 6 h
# then escalate (also across a restart and a wall-clock step), never with the other pump down,
# SPAN unreachable / never read -> manual page, the last-moment precheck aborting the OPEN, a
# suspicious pump<->circuit mapping refused, unreadable history = budget spent, config problems
# reported (never a boot failure), and /api/health.self_heal.
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from bridge import self_heal as sh_mod
from bridge import span_control
from bridge.config import AppConfig, PumpConfig, SelfHealConfig, SpanConfig
from bridge.faults import Severity
from bridge.self_heal import SelfHealer
from bridge.span_control import BreakerController
from bridge.span_local import SpanLocalPoller
from bridge.store import Store
from sim.fake_span import FakeSpan


class FakeTime:
    def __init__(self):
        self.t = 1_800_000_000.0
        self.wall_offset = 0.0        # simulate a wall-clock step without moving monotonic time

    def clock(self) -> float:
        return self.t + self.wall_offset

    def mono(self) -> float:
        return self.t

    async def sleep(self, s: float) -> None:
        self.t += s
        await asyncio.sleep(0)


class FakePoller:
    def __init__(self, pid, name, ft):
        self.cfg = SimpleNamespace(id=pid, name=name)
        self.ft = ft
        self.snapshot = {"online": True, "last_poll_ts": ft.clock(), "last_poll_mono": ft.mono(),
                         "running": False,
                         "defrosting": False, "state": "idle", "active_faults": [], "identity_ok": True}

    def fresh(self, **kw):
        self.snapshot.update(last_poll_ts=self.ft.clock(), last_poll_mono=self.ft.mono(), **kw)

    def fault(self, code="E21", age_min=11.0, severity="warning"):
        self.snapshot["active_faults"] = [{"key": "2111.13", "code": code, "severity": severity,
                                           "since": self.ft.clock() - age_min * 60, "message": "x"}]
        self.snapshot["state"] = "fault"

    def clear(self):
        self.snapshot["active_faults"] = []
        self.snapshot["state"] = "idle"


@pytest.fixture
def alerts(monkeypatch):
    sent: list[tuple[str, str, str]] = []

    # "push" = the owner's phone (6bb), "email" = their inbox, "log" = ntfy (reaches nobody: the record tier)
    async def ntfy(cfg, *, title, message, priority="default", tags=""):
        sent.append(("log", title, priority, message))

    async def sixbb_push(cfg, *, title, message, priority, tag=""):
        sent.append(("push", title, priority))
        return True

    async def email(cfg, *, subject, body):
        sent.append(("email", subject, body))

    for mod in (span_control, sh_mod):
        monkeypatch.setattr(mod.notify, "ntfy", ntfy)
        monkeypatch.setattr(mod.notify, "email", email)
        monkeypatch.setattr(mod.notify, "sixbb_push", sixbb_push)
    return sent


@pytest.fixture
async def rig(tmp_path, alerts):
    panel = FakeSpan()
    panel.set("Air-Water 2", instantPowerW=-15.0)     # the faulted pump's circuit, idle
    addr = panel.start()
    span = SpanConfig(host=addr, passphrase="pw", close_retry_delay_s=1.0)
    store = Store(str(tmp_path / "b.db"))
    await store.open()
    ft = FakeTime()
    poller = SpanLocalPoller(span, store)
    ctl = BreakerController(span, poller.client, store, cache=poller, state_dir=str(tmp_path),
                            sleep=ft.sleep, clock=ft.clock, mono=ft.mono)
    p1, p2 = FakePoller("pump1", "Heat Pump 1", ft), FakePoller("pump2", "Heat Pump 2", ft)

    def make(**cfg):
        cfg.setdefault("circuits_verified", True)   # live tests assume a commissioned map
        return SelfHealer(SelfHealConfig(**cfg), {"pump1": p1, "pump2": p2}, ctl, store,
                          state_dir=str(tmp_path), clock=ft.clock, mono=ft.mono, boot_id="boot-A")

    async def prime():   # one panel read, as the SPAN poll loop does every ~25 s
        poller.note_circuits(await poller.client.fetch_circuits(), ft.clock(), ft.mono())

    async def step(heal, seconds=30.0):
        ft.t += seconds
        p1.fresh(); p2.fresh()
        await prime()
        await heal.tick()

    async def eligible(heal):
        """Seed the in-process first-seen time, then let the 10-minute grace pass."""
        await heal.tick()
        await step(heal, 601)

    await prime()
    yield SimpleNamespace(panel=panel, ctl=ctl, ft=ft, p1=p1, p2=p2, make=make, store=store,
                          alerts=alerts, prime=prime, step=step, eligible=eligible, tmp_path=tmp_path,
                          poller=poller)
    await ctl.stop()
    await store.close()
    panel.stop()
    # every relay write the self-heal made went out in the panel's real (nested) body
    assert panel.rejected == [], f"schema-rejected writes: {panel.rejected}"


async def codes(store, pid="pump2"):
    return [e["code"] for e in await store.get_events(pid, 1) if e["type"] == "self_heal"]


async def all_codes(store):
    return await codes(store, "pump1") + await codes(store, "pump2")


async def settle():
    await asyncio.sleep(0.05)   # let fire-and-forget alert tasks run


def opens(panel):
    return [w for w in panel.writes if w[1] == "OPEN"]


async def test_shadow_is_the_default_and_switches_nothing(rig):
    r = rig
    r.p2.fault(age_min=11)
    heal = r.make()
    assert heal.status()["mode"] == "shadow"
    await r.eligible(heal)
    await settle()
    assert r.panel.writes == []
    assert await codes(r.store) == ["would_cycle"]
    assert any("would cycle" in a[1] for a in r.alerts if a[0] == "log")
    assert not any(a[0] in ("push", "email") for a in r.alerts), "shadow self-heal never reaches the owner"
    for _ in range(31):                        # the shadow verification window ends
        await r.step(heal)
    await settle()
    assert "shadow_verify" in await codes(r.store)
    assert any("(shadow)" in a[1] and "still active" in a[1] for a in r.alerts if a[0] == "log")
    assert not any(a[0] in ("push", "email") for a in r.alerts), "shadow verification is record-only too"
    st = heal.status()["pumps"]["pump2"]
    assert st["attempts_in_window"] == 2 and "SHADOW" in st["status"]   # the second "would cycle"
    assert (await codes(r.store)).count("would_cycle") == 2
    assert heal.status()["trigger"]["stage_call"].startswith("unavailable")


async def test_grace_needs_both_clocks(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=60)        # the fault's onset is an hour ago (wall)...
    await heal.tick()             # ...but this process only just saw it
    await r.step(heal, 300)
    assert opens(r.panel) == []
    await r.step(heal, 301)       # 10 min observed in-process
    assert len(opens(r.panel)) == 1


async def test_heating_defrost_stale_and_identity_all_hold_off(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=11)
    await heal.tick()
    r.p2.snapshot["running"] = True                         # heating
    await r.step(heal, 601)
    r.p2.snapshot["running"] = False                        # stopped just now: anti-short-cycle
    await r.step(heal, 30)
    r.p2.snapshot["defrosting"] = True                      # defrost
    await r.step(heal, 200)
    r.p2.snapshot["defrosting"] = False
    await r.step(heal, 60)                                  # still inside the 5 min after defrost
    r.ft.t += 400
    await r.prime()
    r.p1.fresh()
    r.p2.snapshot["last_poll_ts"] = r.ft.clock() - 300      # stale
    r.p2.snapshot["last_poll_mono"] = r.ft.mono() - 300
    await heal.tick()
    r.p2.fresh(identity_ok=False)                           # identity check failed
    await heal.tick()
    await settle()
    assert r.panel.writes == []
    assert await codes(r.store) == ["identity_mismatch"]


async def test_live_cycle_then_recovery_verified(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    assert r.panel.writes == [("Air-Water 2", "OPEN"), ("Air-Water 2", "CLOSED")]
    assert await codes(r.store) == ["cycle_start"]
    assert heal.status()["pumps"]["pump2"]["phase"] == "verifying"
    r.p2.clear()                                            # back: no fault, idle (no call)
    for _ in range(8):
        await r.step(heal)
    await settle()
    assert "recovered" in await codes(r.store)
    assert heal.status()["pumps"]["pump2"]["last_outcome"]["outcome"] == "recovered"
    assert any("recovered" in a[1] for a in r.alerts if a[0] == "log")


async def test_recovery_is_verified_while_heating_with_the_panels_negative_watts(rig):
    # The real panel reports consumption as a NEGATIVE instantPowerW (Air-Water 2 heating read
    # -5694 W on 2026-10-19). A recovered pump that is heating must verify, not "not_recovered".
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    r.p2.clear()
    r.p2.snapshot["running"] = True                         # back and heating
    r.p2.snapshot["state"] = "heating"
    r.panel.set("Air-Water 2", instantPowerW=-5694.0)
    for _ in range(8):
        await r.step(heal)
    await settle()
    assert "recovered" in await codes(r.store)
    assert "not_recovered" not in await codes(r.store)


async def test_a_telemetry_gap_restarts_the_clear_hold(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    r.p2.clear()
    await r.step(heal)                                      # one fresh clear observation
    r.ft.t += 200                                           # then 200 s with no fresh data
    r.p2.snapshot["last_poll_ts"] = r.ft.clock() - 150
    r.p2.snapshot["last_poll_mono"] = r.ft.mono() - 150
    await heal.tick()
    await r.step(heal)                                      # fresh again: hold restarts here
    assert "recovered" not in await codes(r.store)
    for _ in range(7):
        await r.step(heal)
    assert "recovered" in await codes(r.store)


async def test_a_switched_off_pump_is_not_recovery(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    r.p2.clear()
    r.p2.snapshot.update(on=False, state="off")              # fresh, fault-free, but OFF
    for _ in range(32):
        await r.step(heal)
    c = await codes(r.store)
    assert "recovered" not in c and "not_recovered" in c
    assert heal.status()["pumps"]["pump2"]["last_outcome"]["detail"] == "switched off"


async def test_whitespace_cannot_map_two_pumps_to_one_circuit(rig):
    r = rig
    heal = r.make(live=True, circuits={"pump1": "Air-Water 1", "pump2": " Air-Water 1 "})
    assert set(heal.config_errors) == {"pump1", "pump2"}
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    assert r.panel.writes == []


async def test_an_unobserved_stretch_restarts_the_clear_hold(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    r.p2.clear()
    await r.step(heal)                                      # hold starts
    r.ft.t += 170                                           # loop busy elsewhere: no verify tick...
    await r.step(heal, 30)                                  # ...data fresh again at the next one
    assert "recovered" not in await codes(r.store)          # 200 s elapsed, but not observed
    for _ in range(7):
        await r.step(heal)
    assert "recovered" in await codes(r.store)


async def test_a_backward_clock_step_cannot_revive_frozen_telemetry(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await heal.tick()
    r.ft.t += 601
    await r.prime()
    r.p1.fresh()
    r.p2.snapshot["last_poll_mono"] = r.ft.mono() - 300     # pump2's poller stalled 5 min ago...
    r.p2.snapshot["last_poll_ts"] = r.ft.clock() - 300
    r.ft.wall_offset = -300                                 # ...and the wall clock steps back 5 min
    await heal.tick()
    assert r.panel.writes == []
    assert "stale" in heal.status()["pumps"]["pump2"]["status"]


async def test_info_protections_are_not_faults(rig):
    """P17 anti-freeze (Severity.INFO, the real enum) on the peer is not 'down', and on the
    cycled pump does not block recovery."""
    r = rig
    p17 = {"key": "2116.0", "code": "P17", "severity": Severity.INFO, "since": r.ft.clock(), "message": "x"}
    r.p1.snapshot["active_faults"] = [dict(p17)]
    heal = r.make(live=True)
    r.p2.fault(age_min=12, severity=Severity.WARNING)
    await r.eligible(heal)
    assert ("Air-Water 2", "OPEN") in r.panel.writes        # the peer's P17 did not block it
    r.p2.snapshot["active_faults"] = [dict(p17)]            # E21 gone; P17 on the cycled pump
    for _ in range(8):
        await r.step(heal)
    c = await codes(r.store)
    assert "recovered" in c and "both_down" not in c


async def test_an_open_relay_resets_the_recovery_hold(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    r.p2.clear()
    for _ in range(5):
        await r.step(heal)                                  # ~2.5 min clear
    r.panel.set("Air-Water 2", relayState="OPEN")           # then the breaker opens
    await r.step(heal)
    await r.step(heal)
    assert "recovered" not in await codes(r.store)
    r.panel.set("Air-Water 2", relayState="CLOSED")
    for _ in range(8):
        await r.step(heal)
    assert "recovered" in await codes(r.store)


async def test_heating_seen_at_dispatch_starts_the_quiet_period(rig, monkeypatch):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    real = r.ctl.client.set_relay
    flips = {"n": 0}

    async def compressor_blip(cid, want="CLOSED", **kw):
        if want == "OPEN" and flips["n"] == 0:
            flips["n"] += 1
            r.p2.snapshot["running"] = True              # seen only by the dispatch guard
        return await real(cid, want, **kw)
    monkeypatch.setattr(r.ctl.client, "set_relay", compressor_blip)
    await r.eligible(heal)
    assert r.panel.writes == []                          # aborted at dispatch
    r.p2.snapshot["running"] = False                     # idle again by the next tick
    await r.step(heal, 30)
    await r.step(heal, 30)
    assert r.panel.writes == []                          # inside the 120 s quiet period
    assert heal._pumps["pump2"]["last_running"] is not None  # latched by the dispatch guard
    await r.step(heal, 250)                              # past the quiet period + abort cooldown
    assert ("Air-Water 2", "OPEN") in r.panel.writes


async def test_a_backward_clock_step_cannot_keep_an_old_panel_read_fresh(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    r.p2.clear()
    r.panel.down = True                                 # no more panel reads from here on
    for i in range(12):
        r.ft.t += 30
        if i == 2:
            r.ft.wall_offset -= 90                      # NTP steps the wall clock back
        r.p1.fresh(); r.p2.fresh()
        await heal.tick()
    assert "recovered" not in await codes(r.store)


async def test_a_replacement_fault_is_not_recovery(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    r.p2.fault(code="E18", severity="high")                 # E21 gone, E18 instead
    for _ in range(32):
        await r.step(heal)
    await settle()
    c = await codes(r.store)
    assert "recovered" not in c and "not_recovered" in c
    assert "replaced by E18" in heal.status()["pumps"]["pump2"]["last_outcome"]["detail"]


async def test_two_failures_escalate_instead_of_looping(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)                                  # attempt 1
    for _ in range(32):                                     # not recovered -> attempt 2
        await r.step(heal)
    for _ in range(32):                                     # not recovered again -> escalate
        await r.step(heal)
    for _ in range(60):                                     # and it stays escalated
        await r.step(heal)
    await settle()
    assert len(opens(r.panel)) == 2
    c = await codes(r.store)
    assert c.count("cycle_start") == 2 and c.count("not_recovered") == 2
    assert c.count("escalated") == 1
    assert any(a[2] == "urgent" for a in r.alerts if a[0] == "log")
    assert "escalated" in heal.status()["pumps"]["pump2"]["status"]


async def test_peer_failing_after_escalation_still_pages_both_down(rig):
    r = rig
    (r.tmp_path / sh_mod.STATE_FILE).write_text("{garbage")   # budget spent -> escalates at once
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    assert "escalated" in await codes(r.store)
    r.p1.snapshot.update(on=False, state="off")               # then the other pump goes down
    await r.step(heal)
    await settle()
    assert "both_down" in await codes(r.store)
    assert r.panel.writes == []


async def test_budget_survives_a_restart_and_a_wall_clock_step(rig):
    r = rig
    r.p2.fault(age_min=12)
    heal = r.make(live=True)
    await r.eligible(heal)
    r.ft.wall_offset = 7 * 3600                             # NTP jumps the wall clock 7 h ahead
    heal2 = r.make(live=True)                               # restart, same boot
    assert heal2.status()["pumps"]["pump2"]["attempts_in_window"] == 1


async def test_unreadable_history_counts_as_a_spent_budget(rig):
    r = rig
    (r.tmp_path / sh_mod.STATE_FILE).write_text("{garbage")
    heal = r.make(live=True)
    assert heal.history_problem
    assert heal.status()["pumps"]["pump2"]["attempts_in_window"] == 2
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    assert opens(r.panel) == []
    assert "history_unreadable" in await codes(r.store, "pump1")   # logged once, on the first pump
    assert "escalated" in await codes(r.store)


async def test_other_pump_down_pages_once_and_does_not_cycle(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await heal.tick()
    r.p1.snapshot["online"] = False
    for _ in range(3):
        r.ft.t += 300
        r.p2.fresh()
        await r.prime()
        await heal.tick()
    await settle()
    assert r.panel.writes == []
    assert (await all_codes(r.store)).count("both_down") == 1
    assert any("both heat pumps" in a[1] for a in r.alerts if a[0] == "log")
    # a faulted (not just offline) other pump counts too
    r.p1.snapshot["online"] = True
    r.p1.fault(code="E18", severity="high")
    heal2 = r.make(live=True)
    await r.eligible(heal2)
    assert r.panel.writes == []


async def test_a_peer_without_telemetry_counts_as_down(rig):
    r = rig
    heal = SelfHealer(SelfHealConfig(live=True, circuits_verified=True), {"pump2": r.p2}, r.ctl, r.store,   # no pump1 poller
                      state_dir=str(r.tmp_path), clock=r.ft.clock, mono=r.ft.mono, boot_id="boot-A")
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    await settle()
    assert r.panel.writes == []
    assert "both_down" in await all_codes(r.store)
    assert "no telemetry" in heal.status()["pumps"]["pump2"]["status"]


async def test_stale_target_and_down_peer_pages_both_down_once(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await heal.tick()
    for _ in range(4):
        r.ft.t += 300
        r.p2.snapshot["last_poll_mono"] = r.ft.mono() - 200   # pump2 went silent (E21 last known)
        r.p1.snapshot["online"] = False                       # and pump1 is offline
        await heal.tick()
    await settle()
    assert r.panel.writes == []
    assert (await codes(r.store)).count("both_down") == 1


async def test_both_down_pages_even_during_verification(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)                                # cycled; verifying
    r.p2.fault(code="E18", severity="high")               # E21 became E18...
    r.p1.snapshot.update(on=False, state="off")           # ...and pump1 is switched off
    for _ in range(40):
        await r.step(heal)
    await settle()
    assert (await all_codes(r.store)).count("both_down") == 1
    assert len([a for a in r.alerts if a[0] == "log" and "both heat pumps" in a[1]]) == 1
    # record: the planner's one "no heat" page is the incident the owner hears about
    assert not [a for a in r.alerts if a[0] in ("push", "email") and "both heat pumps" in a[1]]


async def test_disagreeing_states_page_exactly_once(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    r.p1.fault(code="E18", severity="high")
    r.p1.snapshot["running"] = True            # pump1 faulted but still heating: NOT down
    await heal.tick()
    for _ in range(20):
        await r.step(heal)
    await settle()
    assert (await all_codes(r.store)).count("both_down") == 0
    assert ("Air-Water 2", "OPEN") in r.panel.writes          # so pump2 may be cycled
    # now the peer's panel relay reads OPEN while its telemetry looks fine: down, paged ONCE
    r.panel.set("Air-Water 1", relayState="OPEN")
    r.p1.snapshot.update(running=False, active_faults=[], state="idle")
    heal2 = r.make(live=True)
    r.p2.fault(age_min=12)
    await heal2.tick()
    for _ in range(40):
        await r.step(heal2)
    await settle()
    logged = [a for a in r.alerts if a[0] == "log" and "both heat pumps" in a[1]]
    owner = [a for a in r.alerts if a[0] in ("push", "email") and "both heat pumps" in a[1]]
    assert len(logged) == 1 and owner == []


async def test_a_bridge_restart_does_not_page_both_down(rig):
    r = rig
    heal = r.make(live=True)
    r.p1.snapshot["online"] = False                       # not polled yet after a restart
    r.p2.snapshot["online"] = False
    await heal.tick()
    r.ft.t += 60
    r.p1.fresh(online=True); r.p2.fresh(online=True)      # first polls land within a minute
    await heal.tick()
    await settle()
    assert "both_down" not in await codes(r.store, "pump1")


async def test_a_peer_that_just_stopped_with_a_fault_is_down(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    r.p1.snapshot["running"] = True
    await heal.tick()                                    # pump1 seen running
    r.ft.t += 590
    r.p1.fresh(); r.p2.fresh(); await r.prime(); await heal.tick()
    r.p1.fault(code="E18", severity="high")              # pump1 faults and stops...
    r.p1.snapshot["running"] = False
    await r.step(heal, 20)                               # ...right as pump2 becomes eligible
    await settle()
    assert r.panel.writes == []
    assert "both_down" in await all_codes(r.store)


async def test_last_moment_precheck_aborts_before_any_switching(rig, monkeypatch):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    real_step = heal._step

    async def compressor_starts(pid, code, *a, **k):
        await real_step(pid, code, *a, **k)
        if code == "cycle_start":
            r.p2.snapshot["running"] = True                 # the call arrives mid-announcement
    monkeypatch.setattr(heal, "_step", compressor_starts)
    await r.eligible(heal)
    assert r.panel.writes == []
    assert "cycle_aborted" in await codes(r.store)
    assert heal.status()["pumps"]["pump2"]["attempts_in_window"] == 0   # not an attempt


async def test_guard_at_the_dispatch_boundary_aborts_with_nothing_sent(rig, monkeypatch):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    real = r.ctl.client.set_relay

    async def late_change(cid, want="CLOSED", **kw):
        if want == "OPEN":
            r.p2.snapshot["running"] = True      # changes AFTER the controller's precheck...
        return await real(cid, want, **kw)       # ...and the permit guard sees it in the worker
    monkeypatch.setattr(r.ctl.client, "set_relay", late_change)
    await r.eligible(heal)
    assert r.panel.writes == []                  # no OPEN — and so no CLOSE either
    assert not (r.tmp_path / span_control.CYCLE_FILE).exists()
    assert "cycle_aborted" in await codes(r.store)
    assert heal.status()["pumps"]["pump2"]["attempts_in_window"] == 0


async def test_repeated_aborts_cool_down_dedupe_and_page_manual(rig, monkeypatch):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    real = r.ctl.client.set_relay

    async def always_late(cid, want="CLOSED", **kw):
        if want == "OPEN":
            r.p2.snapshot["defrosting"] = True       # something always changes at dispatch
        return await real(cid, want, **kw)
    monkeypatch.setattr(r.ctl.client, "set_relay", always_late)
    await heal.tick()
    for _ in range(80):                              # 40 min of ticks
        r.p2.snapshot["defrosting"] = False
        await r.step(heal)
    await settle()
    c = await codes(r.store)
    assert r.panel.writes == []
    assert 3 <= c.count("cycle_aborted") <= 8        # ~one per 5 min cooldown, not every tick
    aborted_push = [a for a in r.alerts if a[0] == "log" and "cycle aborted" in a[1]]
    assert len(aborted_push) == 1                    # notified once per episode
    starts = [a for a in r.alerts if a[0] == "log" and "power-cycling" in a[1]]
    assert len(starts) == 1                          # retries are not re-announced
    assert c.count("cycle_refused") == 1             # the manual-step page after 3 aborts


async def test_a_new_fault_episode_does_not_inherit_the_grace(rig, monkeypatch):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    real_step = heal._step

    async def refault(pid, code, *a, **k):
        await real_step(pid, code, *a, **k)
        if code == "cycle_start":
            r.p2.fault(age_min=0.1)              # E21 cleared and came straight back: new onset
    monkeypatch.setattr(heal, "_step", refault)
    await r.eligible(heal)
    assert r.panel.writes == []
    assert "cycle_aborted" in await codes(r.store)


async def test_nested_history_corruption_is_a_spent_budget_not_a_crash(rig):
    r = rig
    def doc(pump2):   # a valid document except for pump2's entry
        return {"v": 2, "pumps": {"pump1": {"attempts": []}, "pump2": pump2}}
    for bad in (doc({"attempts": None}),
                doc({"attempts": [{"wall": "yesterday"}]}),
                doc({"attempts": [{"mono": 5}]}),
                doc({"attempts": [{"wall": 1.0, "mono": "x", "boot": "boot-A"}]}),
                doc([]),
                {"v": 2, "pumps": []}):
        (r.tmp_path / sh_mod.STATE_FILE).write_text(json.dumps(bad))
        heal = r.make(live=True)
        assert heal.history_problem, bad
        assert heal.status()["pumps"]["pump2"]["attempts_in_window"] == 2
    (r.tmp_path / sh_mod.STATE_FILE).write_text(
        '{"v": 2, "pumps": {"pump1": {"attempts": []}, '
        '"pump2": {"attempts": [{"wall": NaN, "mono": 1, "boot": "boot-A"}]}}}')
    assert r.make(live=True).history_problem
    (r.tmp_path / sh_mod.STATE_FILE).write_text(json.dumps(doc({"attempts": []})))
    assert not r.make(live=True).history_problem       # the control: the same shape, valid


async def test_budget_survives_a_reboot_with_a_clock_step(rig):
    r = rig
    r.p2.fault(age_min=12)
    heal = r.make(live=True)
    await r.eligible(heal)
    r.ft.wall_offset = 7 * 3600                  # reboot + NTP correction 7 h ahead
    rebooted = SelfHealer(SelfHealConfig(live=True, circuits_verified=True), {"pump1": r.p1, "pump2": r.p2}, r.ctl, r.store,
                          state_dir=str(r.tmp_path), clock=r.ft.clock, mono=r.ft.mono, boot_id="boot-B")
    assert rebooted.status()["pumps"]["pump2"]["attempts_in_window"] == 1


async def test_a_switched_off_peer_counts_as_down(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    r.p1.snapshot.update(on=False, state="off")
    await r.eligible(heal)
    await settle()
    assert r.panel.writes == []
    assert "both_down" in await all_codes(r.store)


async def test_same_code_recurrence_restarts_the_in_process_grace(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await heal.tick()
    await r.step(heal, 500)
    r.p2.fault(age_min=12)                       # cleared and back between ticks: new onset
    r.ft.wall_offset = 3600                      # plus a forward wall step
    await r.step(heal, 200)                      # old episode would be past 10 min; new one isn't
    assert opens(r.panel) == []
    await r.step(heal, 601)                      # 10 min after the new onset was first seen
    assert len(opens(r.panel)) == 1, heal.status()["pumps"]["pump2"]["status"]


async def test_a_restart_mid_verification_resumes_it(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)                       # cycled; verifying
    data = json.loads((r.tmp_path / sh_mod.STATE_FILE).read_text())
    assert data["pumps"]["pump2"]["verify"]["code"] == "E21"
    heal2 = r.make(live=True)                    # restart
    assert heal2.status()["pumps"]["pump2"]["phase"] == "verifying"
    for _ in range(32):                          # E21 never clears
        await r.step(heal2)
    assert "not_recovered" in await codes(r.store)
    for _ in range(22):                          # the new process's own 10 min grace, then attempt 2
        await r.step(heal2)
    assert len(opens(r.panel)) == 2              # the budget (1 used) survived the restart


async def test_incomplete_history_is_a_spent_budget(rig):
    r = rig
    for bad in ({"v": 2, "pumps": {"pump1": {"attempts": []}}},          # pump2 missing
                {"v": 2, "pumps": {"pump1": {}, "pump2": {}}},          # attempts missing
                {"pumps": {"pump1": {"attempts": []}, "pump2": {"attempts": []}}}):   # no version
        (r.tmp_path / sh_mod.STATE_FILE).write_text(json.dumps(bad))
        heal = r.make(live=True)
        assert heal.history_problem, bad
    (r.tmp_path / sh_mod.STATE_FILE).write_text(json.dumps(
        {"v": 2, "pumps": {"pump1": {"attempts": []}, "pump2": {"attempts": []}}}))
    assert not r.make(live=True).history_problem


async def test_cold_or_stale_span_waits_then_pages_manual(rig):
    r = rig
    r.poller.latest_circuits = {}                           # just booted: no panel read yet
    r.poller.latest_circuits_ts = None
    r.poller.latest_circuits_mono = None
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await heal.tick()
    r.ft.t += 601
    r.p1.fresh(); r.p2.fresh()
    await heal.tick()
    assert "waiting for a fresh SPAN panel read" in heal.status()["pumps"]["pump2"]["status"]
    assert await codes(r.store) == []
    r.ft.t += 601                                           # still nothing from the panel
    r.p1.fresh(); r.p2.fresh()
    await heal.tick()
    await settle()
    assert await codes(r.store) == ["cycle_refused"]        # the manual-step page
    assert r.panel.writes == []
    await r.step(heal)                                      # panel answers: it proceeds
    assert ("Air-Water 2", "OPEN") in r.panel.writes


async def test_span_unreachable_pages_the_manual_step(rig):
    r = rig
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await heal.tick()
    r.ft.t += 601
    r.p1.fresh(); r.p2.fresh()
    await r.prime()
    r.panel.down = True
    await heal.tick()
    await settle()
    assert opens(r.panel) == []
    assert "cycle_refused" in await codes(r.store)
    logged = [a for a in r.alerts if a[0] == "log" and "manual" in a[1]]
    assert logged and "SPAN panel" in logged[0][3]


@pytest.mark.parametrize("watts", [2600.0, -2600.0])   # the real panel reports draw as NEGATIVE
async def test_suspicious_mapping_is_refused(rig, watts):
    r = rig
    r.panel.set("Air-Water 2", instantPowerW=watts)    # "idle" pump's circuit draws compressor power
    heal = r.make(live=True)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    await settle()
    assert r.panel.writes == []
    assert "mapping_suspect" in await codes(r.store)


async def test_live_needs_a_verified_map(rig):
    r = rig
    heal = r.make(live=True, circuits_verified=False)
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    await settle()
    assert r.panel.writes == []
    assert "not verified" in heal.status()["pumps"]["pump2"]["unavailable"]
    assert "unavailable" in await codes(r.store)
    shadow = r.make(live=False, circuits_verified=False)       # shadow still evaluates
    assert shadow.config_errors == {}


async def test_bad_mapping_is_reported_not_a_boot_failure(rig):
    r = rig
    heal = r.make(live=True, circuits={"pump1": "Air-Water 1", "pump2": "Buffer Tank"})
    assert "pump2" in heal.config_errors
    r.p2.fault(age_min=12)
    await r.eligible(heal)
    await settle()
    assert r.panel.writes == []
    assert "unavailable" in heal.status()["pumps"]["pump2"]["status"]
    assert "unavailable" in await codes(r.store)


def test_config_guards_and_compat():
    with pytest.raises(ValueError, match="off_s"):
        SelfHealConfig(off_s=30)
    d = SelfHealConfig()
    assert d.live is False and d.fault_codes == ["E21"] and d.grace_min == 10
    assert d.max_attempts == 2 and d.window_h == 6 and d.verify_min == 15
    assert d.circuits == {"pump1": "Air-Water 1", "pump2": "Air-Water 2"}
    assert d.circuits_verified is False
    # existing configs (no self_heal section) with any valid span settings still load
    AppConfig(pumps=[PumpConfig(id="pump1", name="P1", host="h")], span=SpanConfig(min_off_s=120))
    AppConfig(pumps=[PumpConfig(id="pump1", name="P1", host="h")],
              span=SpanConfig(breakers=[{"name": "Buffer Tank"}]))


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
