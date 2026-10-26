# @purpose: #212 — a heat-pump breaker a PERSON switched off (6bb app, SPAN app, the panel; the panel reports USER for
# all of them) is a deliberate stop, not a fault. Against the real BreakerController + SpanLocalPoller cache and the
# fake SPAN panel, with the shape measured on 2026-10-19 13:40 ET: Air-Water 2 OPEN reads 0 W and pump2's Modbus times
# out (the pump simply goes "offline"). Covers: one email after the confirmation, then quiet; back ON is record-only;
# a short 6bb power cycle never emails; A2W's own power cycle is never a deliberate stop (in progress, or within the
# attribution window after it); a stale panel read changes nothing; a restart never re-announces; self-heal stands
# down for the stopped pump, never cycles the one pump left, and does not note "both down"; the backup fallback words
# it; the hub frame and /api/health carry it; a held verdict expires without a recent panel read, and a pump that
# answers Modbus is never "stopped" (both fail loud).
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from bridge import deliberate_stop as ds_mod
from bridge import self_heal as sh_mod
from bridge import span_control
from bridge.config import BackupFallbackConfig, HubConfig, SelfHealConfig, SpanConfig
from bridge.backup_fallback import BackupFallback
from bridge.deliberate_stop import ATTRIBUTION_S, CONFIRM_S, VERDICT_MAX_AGE_S, DeliberateStops
from bridge.hub_client import HubClient
from bridge.self_heal import SelfHealer
from bridge.span_control import BreakerController
from bridge.span_local import SpanLocalPoller
from bridge.store import Store
from sim.fake_span import FakeSpan

CIRCUITS = {"pump1": "Air-Water 1", "pump2": "Air-Water 2"}


class FakeTime:
    def __init__(self):
        self.t = 1_800_000_000.0

    def clock(self) -> float:
        return self.t

    def mono(self) -> float:
        return self.t

    async def sleep(self, s: float) -> None:
        self.t += s
        await asyncio.sleep(0)


class FakePoller:
    def __init__(self, pid, name, ft):
        self.cfg = SimpleNamespace(id=pid, name=name)
        self.ft = ft
        self.powered = True       # its breaker: a pump without power answers no poll
        self.snapshot = {"online": True, "last_poll_ts": ft.clock(), "last_poll_mono": ft.mono(), "running": False,
                         "defrosting": False, "state": "idle", "active_faults": [], "identity_ok": True}

    def fresh(self, **kw):
        if self.powered:
            self.snapshot.update(last_poll_ts=self.ft.clock(), last_poll_mono=self.ft.mono(), online=True, **kw)

    def silent(self):
        """what a switched-off pump looks like on the Pi: polls time out, the last snapshot ages (2026-10-19)."""
        self.snapshot.update(online=False, state="offline")

    def fault(self, code="E21", age_min=11.0):
        self.snapshot["active_faults"] = [{"key": "2111.13", "code": code, "severity": "warning",
                                           "since": self.ft.clock() - age_min * 60, "message": "x"}]
        self.snapshot["state"] = "fault"


@pytest.fixture
def alerts(monkeypatch):
    sent: list[tuple] = []

    async def ntfy(cfg, *, title, message, priority="default", tags=""):
        sent.append(("log", title, message))

    async def sixbb_push(cfg, *, title, message, priority, tag=""):
        sent.append(("push", title, tag))
        return True

    async def email(cfg, *, subject, body, html=None):
        sent.append(("email", subject, body))

    for mod in (span_control, sh_mod, ds_mod):
        monkeypatch.setattr(mod.notify, "ntfy", ntfy)
        monkeypatch.setattr(mod.notify, "email", email)
        monkeypatch.setattr(mod.notify, "sixbb_push", sixbb_push)
    return sent


@pytest.fixture
async def rig(tmp_path, alerts):
    panel = FakeSpan()
    # 2026-10-19 13:38 ET, both idle: Air-Water 2 drew -5..-9 W (the panel reports consumption negative)
    panel.set("Air-Water 1", instantPowerW=-6.0)
    panel.set("Air-Water 2", instantPowerW=-7.6)
    addr = panel.start()
    span = SpanConfig(host=addr, passphrase="pw", close_retry_delay_s=1.0)
    store = Store(str(tmp_path / "b.db"))
    await store.open()
    ft = FakeTime()
    poller = SpanLocalPoller(span, store)
    ctl = BreakerController(span, poller.client, store, cache=poller, state_dir=str(tmp_path),
                            sleep=ft.sleep, clock=ft.clock, mono=ft.mono)
    p1, p2 = FakePoller("pump1", "Heat Pump 1", ft), FakePoller("pump2", "Heat Pump 2", ft)
    pollers = {"pump1": p1, "pump2": p2}

    def make_stops():
        return DeliberateStops(ctl, CIRCUITS, pollers, store, state_dir=str(tmp_path), clock=ft.clock, mono=ft.mono)

    async def prime():   # one panel read, as the SPAN poll loop does every ~25 s
        poller.note_circuits(await poller.client.fetch_circuits(), ft.clock(), ft.mono())

    def person_switches(circuit, state):
        """6bb / the SPAN app / the panel: the relay changes with no A2W action (OPEN reads 0 W, and the pump on it goes
        silent — its Modbus times out, measured 2026-10-19)."""
        panel.set(circuit, relayState=state, **({"instantPowerW": 0.0} if state == "OPEN" else {}))
        pump = pollers[{v: k for k, v in CIRCUITS.items()}[circuit]]
        pump.powered = state != "OPEN"
        if not pump.powered:
            pump.silent()

    async def advance(stops, seconds, *, heal=None, live_pumps=("pump1", "pump2")):
        """seconds of wall time in 30-s ticks: fresh polls for live pumps, a panel read, then the ticks."""
        end = ft.t + seconds
        while ft.t < end:
            ft.t += 30
            for pid in live_pumps:
                pollers[pid].fresh()
            await prime()
            await stops.tick()
            if heal is not None:
                await heal.tick()
        await settle()

    await prime()
    yield SimpleNamespace(panel=panel, ctl=ctl, ft=ft, p1=p1, p2=p2, pollers=pollers, store=store, alerts=alerts,
                          prime=prime, make_stops=make_stops, person_switches=person_switches, advance=advance,
                          tmp_path=tmp_path, span=span)
    await ctl.stop()
    await store.close()
    panel.stop()


async def settle():
    for _ in range(5):
        await asyncio.sleep(0)


async def stop_events(store):
    return [e["code"] for e in reversed(await store.get_events("span", 1)) if e["type"] == "deliberate_stop"]


def owner(alerts):
    return [a for a in alerts if a[0] in ("push", "email")]


# --- the stop itself ----------------------------------------------------------------------------------------------

async def test_a_person_switching_a_pump_off_emails_once_then_stays_quiet(rig):
    stops = rig.make_stops()
    await rig.advance(stops, 60)
    assert stops.stopped("pump2") is None
    rig.person_switches("Air-Water 2", "OPEN")
    rig.p2.silent()
    await rig.advance(stops, 30, live_pumps=("pump1",))
    s = stops.stopped("pump2")
    assert s and s["circuit"] == "Air-Water 2" and not s["announced"]     # deliberate at once (the guards need it)
    assert owner(rig.alerts) == []                                         # but no email before the confirmation
    await rig.advance(stops, CONFIRM_S, live_pumps=("pump1",))
    mails = owner(rig.alerts)
    assert [m[0] for m in mails] == ["email"]                             # attention: an email, never a phone push
    assert "Air-Water 2 was switched off outside A2W at" in mails[0][1]
    assert stops.stopped("pump2")["announced"] is True
    await rig.advance(stops, 6 * 3600, live_pumps=("pump1",))             # hours later: still quiet
    assert len(owner(rig.alerts)) == 1
    assert stops.stopped("pump1") is None
    rig.person_switches("Air-Water 2", "CLOSED")
    await rig.advance(stops, 30)
    assert stops.stopped("pump2") is None
    assert len(owner(rig.alerts)) == 1                                     # back ON: record-only (attention all-clear)
    assert any(a[0] == "log" and "Air-Water 2 is back on" in a[1] for a in rig.alerts)
    assert await stop_events(rig.store) == ["began", "announced", "ended"]


async def test_a_6bb_power_cycle_is_an_event_not_an_email(rig):
    stops = rig.make_stops()
    rig.person_switches("Air-Water 1", "OPEN")
    await rig.advance(stops, 90)                 # 6bb's minimum off is 60 s
    rig.person_switches("Air-Water 1", "CLOSED")
    await rig.advance(stops, CONFIRM_S * 2)
    assert owner(rig.alerts) == []
    assert await stop_events(rig.store) == ["began", "ended"]


async def test_a2w_own_power_cycle_is_never_a_deliberate_stop(rig, monkeypatch):
    stops = rig.make_stops()
    seen_during_hold: list = []
    real_sleep = rig.ctl._sleep

    async def watching_sleep(s):             # observe the verdict while the circuit is OPEN mid-cycle
        await rig.prime()
        seen_during_hold.append((rig.ctl.snapshot()["circuits"][1]["relay_state"], stops.stopped("pump2")))
        await real_sleep(s)
    monkeypatch.setattr(rig.ctl, "_sleep", watching_sleep)
    res = await rig.ctl.execute("Air-Water 2", "power_cycle", off_s=60, source="self-heal")
    assert res["ok"]
    assert ("OPEN", None) in seen_during_hold                    # OPEN during A2W's hold, never deliberate
    assert all(v is None for _, v in seen_during_hold)
    await rig.advance(stops, 120)
    assert stops.stopped("pump2") is None and await stop_events(rig.store) == []


async def test_an_open_inside_the_attribution_window_is_a2ws_until_it_expires(rig):
    """The panel lagging A2W's own write, or a person switching right after A2W did: inside ATTRIBUTION_S the OPEN is
    attributed to A2W (fail-safe: it is handled as a fault, like before #212); after it, as the person's choice."""
    stops = rig.make_stops()
    assert (await rig.ctl.execute("Air-Water 2", "power_cycle", off_s=60, source="self-heal"))["ok"]
    rig.person_switches("Air-Water 2", "OPEN")
    await rig.advance(stops, ATTRIBUTION_S - 120)
    assert stops.stopped("pump2") is None
    assert "A2W switched it" in rig.ctl.own_switching("Air-Water 2", ATTRIBUTION_S)
    await rig.advance(stops, 180)
    assert stops.stopped("pump2") is not None


async def test_a_failed_reclose_stays_a2ws(rig):
    """A2W could not switch it back ON and keeps retrying in the background: that OPEN is A2W's, however long."""
    stops = rig.make_stops()
    rig.person_switches("Air-Water 2", "OPEN")
    rig.ctl._pending_close["Air-Water 2"] = asyncio.get_running_loop().create_future()   # the re-close loop
    await rig.advance(stops, ATTRIBUTION_S * 2)
    assert stops.stopped("pump2") is None
    assert rig.ctl.own_switching("Air-Water 2", ATTRIBUTION_S) == "A2W is retrying its switch-back-ON"
    rig.ctl._pending_close.pop("Air-Water 2").cancel()
    await rig.advance(stops, 30)
    assert stops.stopped("pump2") is not None      # once A2W lets go, an OPEN nobody claims is a person's


async def test_a_stale_panel_read_neither_starts_nor_ends_a_stop(rig):
    stops = rig.make_stops()
    cache = rig.ctl.cache

    async def stale_read():     # the last panel read the Pi got, 10 min before the Wi-Fi dropped it
        await rig.prime()
        cache.latest_circuits_mono = cache.latest_circuits_ts = rig.ft.t - 600

    rig.person_switches("Air-Water 2", "OPEN")
    await rig.advance(stops, 60)
    assert stops.stopped("pump2")
    rig.person_switches("Air-Water 2", "CLOSED")
    rig.person_switches("Air-Water 1", "OPEN")
    await stale_read()                               # it shows AW2 back on and AW1 off — but it is 10 min old
    await stops.tick()
    assert stops.stopped("pump2")                    # the last verdict holds
    assert stops.stopped("pump1") is None            # and an old read starts nothing
    await rig.prime()                                # a fresh read decides both
    assert stops.stopped("pump2") is None and stops.stopped("pump1") is not None


async def test_a_held_verdict_expires_without_a_recent_panel_read(rig):
    """The SPAN local stream dies (record-only) while a stop is held; someone switches the pump back ON and it then
    fails to start or loses comms. A stop nobody can confirm must not keep silencing that pump: after
    VERDICT_MAX_AGE_S without a fresh read it is no longer in force (fail loud)."""
    stops = rig.make_stops()
    rig.person_switches("Air-Water 2", "OPEN")
    await rig.advance(stops, CONFIRM_S + 60, live_pumps=("pump1",))
    assert stops.stopped("pump2")["announced"]
    rig.person_switches("Air-Water 2", "CLOSED")
    rig.p2.powered = False                         # switched back on, but the pump never answers again
    rig.ft.t += VERDICT_MAX_AGE_S - 30              # no panel read since: still held, still in force
    await stops.tick()
    assert stops.stopped("pump2") is not None
    rig.ft.t += 60                                  # past the limit: held, but no longer in force
    await stops.tick()
    assert stops.stopped("pump2") is None
    assert stops.status()["pumps"]["pump2"]["in_force"] is False
    # the guards see it as an ordinary down pump again
    heal = SelfHealer(SelfHealConfig(live=True, circuits_verified=True), rig.pollers, rig.ctl, rig.store,
                      state_dir=str(rig.tmp_path), clock=rig.ft.clock, mono=rig.ft.mono, boot_id="boot-A", stops=stops)
    assert heal._pump_down("pump2", span=None) == "is offline"
    # a fresh read showing it OPEN again puts it back in force
    rig.person_switches("Air-Water 2", "OPEN")
    await rig.prime()
    assert stops.stopped("pump2") is not None


async def test_a_pump_that_answers_modbus_is_never_stopped(rig):
    """A switched-off pump cannot answer Modbus. If it does — the panel read held from before is wrong or old — the
    breaker is on, whatever the last read said."""
    stops = rig.make_stops()
    rig.person_switches("Air-Water 2", "OPEN")
    await rig.advance(stops, 60, live_pumps=("pump1",))
    assert stops.stopped("pump2")
    cache = rig.ctl.cache
    cache.latest_circuits_mono = cache.latest_circuits_ts = rig.ft.t - 600   # the panel stream goes stale...
    rig.p2.powered = True
    rig.p2.fresh()                                   # ...and pump2 answers a poll: it has power
    assert stops.stopped("pump2") is None
    assert stops.status()["pumps"]["pump2"]["in_force"] is False
    rig.p2.snapshot["last_poll_mono"] = rig.ft.t - 200   # silent again (stale snapshot): the held stop is back in force
    assert stops.stopped("pump2") is not None
    # and the announcement waits for a verdict in force
    s2 = rig.make_stops()
    rig.p2.fresh()
    s2._stops["pump2"]["seen"] -= CONFIRM_S * 2
    s2._stops["pump2"]["announced"] = False
    await s2.tick()
    assert s2._stops["pump2"]["announced"] is False


async def test_a_restart_never_re_announces(rig):
    stops = rig.make_stops()
    rig.person_switches("Air-Water 2", "OPEN")
    await rig.advance(stops, CONFIRM_S + 60)
    assert len(owner(rig.alerts)) == 1
    again = rig.make_stops()                         # bridge restart (same state dir)
    assert again.stopped("pump2")["announced"] is True
    await rig.advance(again, CONFIRM_S * 3)
    assert len(owner(rig.alerts)) == 1
    # and an unreadable state file starts clean rather than crashing
    (rig.tmp_path / ds_mod.STATE_FILE).write_text("{nope")
    assert rig.make_stops().status()["pumps"]["pump1"] is None


# --- self-heal ------------------------------------------------------------------------------------------------------

def make_heal(rig, stops, **cfg):
    cfg.setdefault("circuits_verified", True)
    return SelfHealer(SelfHealConfig(live=True, **cfg), rig.pollers, rig.ctl, rig.store, state_dir=str(rig.tmp_path),
                      clock=rig.ft.clock, mono=rig.ft.mono, boot_id="boot-A", stops=stops)


async def heal_codes(store):
    out = []
    for pid in ("pump1", "pump2"):
        out += [e["code"] for e in await store.get_events(pid, 1) if e["type"] == "self_heal"]
    return out


async def test_self_heal_never_acts_on_a_deliberately_stopped_pump(rig):
    """E21 on HP2, then a person switches Air-Water 2 off (perhaps to power-cycle it by hand): self-heal stands down."""
    stops = rig.make_stops()
    heal = make_heal(rig, stops)
    rig.p2.fault(age_min=2)
    await rig.advance(stops, 60, heal=heal)
    rig.person_switches("Air-Water 2", "OPEN")
    rig.p2.silent()                                  # the E21 stays in its last snapshot
    await rig.advance(stops, 3 * 3600, heal=heal, live_pumps=("pump1",))
    assert [w for w in rig.panel.writes if w[1] == "OPEN"] == []
    assert heal.status()["pumps"]["pump2"]["status"].startswith("standing down: was switched off outside A2W")
    assert "both_down" not in await heal_codes(rig.store)
    assert [a for a in owner(rig.alerts) if "self-heal" in a[1].lower() or "both heat pumps" in a[1]] == []


async def test_the_only_pump_left_is_never_cycled_and_both_down_is_not_noted(rig):
    """HP1 E21 while a person has HP2 switched off: no cycle (the peer counts as down), a record 'peer_stopped' note
    instead of 'both heat pumps down', and the all-down watcher stays quiet."""
    stops = rig.make_stops()
    heal = make_heal(rig, stops)
    rig.person_switches("Air-Water 2", "OPEN")
    rig.p2.silent()
    rig.p1.fault(age_min=12)
    await rig.advance(stops, 30, heal=heal, live_pumps=("pump1",))
    await rig.advance(stops, 3600, heal=heal, live_pumps=("pump1",))
    assert rig.panel.writes == []
    codes = await heal_codes(rig.store)
    assert codes.count("peer_stopped") == 1 and "both_down" not in codes
    assert "not cycling the only pump left" in heal.status()["pumps"]["pump1"]["status"]
    assert owner(rig.alerts) == [a for a in owner(rig.alerts) if "switched off outside A2W" in a[1]]
    # the guard itself still counts the stopped pump as down
    assert "was switched off outside A2W" in heal._pump_down("pump2", span=heal._span())


async def test_without_the_stop_watch_an_open_peer_is_still_both_down(rig):
    """The pre-#212 behaviour is kept when the watch is absent (no SPAN control): a peer OPEN at the panel is down."""
    heal = make_heal(rig, None)
    rig.person_switches("Air-Water 2", "OPEN")
    rig.p1.fault(age_min=12)
    stops = rig.make_stops()                                  # only used to drive time; not given to self-heal
    await rig.advance(stops, 30, heal=heal)
    await rig.advance(stops, 900, heal=heal)
    assert "both_down" in await heal_codes(rig.store) and rig.panel.writes == []


# --- backup fallback, hub frame ------------------------------------------------------------------------------------

async def test_backup_fallback_words_the_stop_and_keeps_it_off_not_down(rig):
    stops = rig.make_stops()
    fb = BackupFallback(BackupFallbackConfig(), rig.pollers, rig.ctl, rig.store, circuits=CIRCUITS,
                        clock=rig.ft.clock, mono=rig.ft.mono, stops=stops)
    rig.person_switches("Air-Water 2", "OPEN")
    rig.p2.silent()
    rig.p1.fault(age_min=40)                                   # the other pump is really down
    for _ in range(80):
        await rig.advance(stops, 30, live_pumps=("pump1",))
        await fb.tick()
    st = fb.status()["pumps"]
    assert st["pump2"]["state"] == "off" and "switched off outside A2W" in st["pump2"]["why"]
    assert st["pump1"]["state"] == "down"
    assert fb.status()["all_down_min"] is None                # off is never down: no fallback episode


async def test_the_hub_frame_and_health_carry_the_stop(rig):
    stops = rig.make_stops()
    hc = HubClient(HubConfig(), {})
    hc.pollers = {}
    rig.person_switches("Air-Water 2", "OPEN")
    await rig.prime()
    poll = SimpleNamespace(cfg=SimpleNamespace(id="pump2", name="Heat Pump 2", write_enabled=True),
                           snapshot={"online": False, "state": "offline"},
                           client=SimpleNamespace(stats=SimpleNamespace(as_dict=lambda: {"error_rate": 1.0})))
    hc.pollers = {"pump2": poll}
    hc.stops = stops
    frame = hc._state_payload()
    d = frame["pumps"][0]["deliberate_stop"]
    assert d["circuit"] == "Air-Water 2" and d["since"] == rig.ft.clock() and d["announced"] is False
    json.dumps(frame)
    hc.stops = None
    assert hc._state_payload()["pumps"][0]["deliberate_stop"] is None
    st = stops.status()
    assert st["pumps"]["pump2"]["circuit"] == "Air-Water 2" and st["pumps"]["pump1"] is None
