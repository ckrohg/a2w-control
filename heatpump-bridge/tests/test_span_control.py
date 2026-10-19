# @purpose: Remote breaker control (bridge/span_control.py) against a fake SPAN panel on a real
# socket (sim/fake_span.py): allowlist + per-circuit OFF opt-ins, the 60 s floor, CLOSE in a
# finally (exception AND a vanished caller), CLOSE retries + urgent page + background re-close,
# the global lock, isUserControllable, never two heat pumps off, read-back mismatch, crash
# recovery from the cycle record, the OpenPermit keystone, the human-only API, and the hub relay.
# Time is faked (injected sleep/clock) so a 60 s hold costs nothing.
from __future__ import annotations

import asyncio
import json
import socket

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from websockets.asyncio.server import serve

from bridge import span_control
from bridge.config import (ApiToken, AppConfig, AuthConfig, BreakerCircuit, HubConfig,
                           PumpConfig, SpanConfig)
from bridge.hub_client import HubClient
from bridge.span_control import BreakerController, BreakerRefused
from bridge.span_local import OpenPermit, SpanClient, SpanLocalPoller
from bridge.store import Store
from sim.fake_span import FakeSpan


class FakeTime:
    """Injected clock + sleep: sleeping advances the clock instantly. `block` holds every
    sleep of exactly that length until `release` is set (to observe a cycle mid-hold);
    `raise_once` makes the next sleep of that length raise."""

    def __init__(self):
        self.t = 1_800_000_000.0
        self.sleeps: list[float] = []
        self.block: float | None = None
        self.release = asyncio.Event()
        self.raise_once: float | None = None

    def clock(self) -> float:
        return self.t

    async def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        if self.raise_once is not None and s == self.raise_once:
            self.raise_once = None
            raise RuntimeError("boom mid-hold")
        if self.block is not None and s == self.block:
            await self.release.wait()
        self.t += s
        await asyncio.sleep(0)


@pytest.fixture
def alerts(monkeypatch):
    sent: list[tuple[str, str, str]] = []

    async def ntfy(cfg, *, title, message, priority="default", tags=""):
        sent.append(("push", title, priority))

    async def email(cfg, *, subject, body):
        sent.append(("email", subject, body))

    monkeypatch.setattr(span_control.notify, "ntfy", ntfy)
    monkeypatch.setattr(span_control.notify, "email", email)
    return sent


@pytest.fixture
async def rig(tmp_path, alerts):
    panel = FakeSpan()
    addr = panel.start()
    cfg = SpanConfig(host=addr, passphrase="hunter2-passphrase", close_retry_delay_s=1.0,
                     breakers=[BreakerCircuit(name="Air-Water 1", allow_cycle=True, heat_pump=True),
                               BreakerCircuit(name="Air-Water 2", allow_cycle=True, heat_pump=True),
                               BreakerCircuit(name="Buffer Tank"),
                               BreakerCircuit(name="Kitchen", allow_open=True)])
    store = Store(str(tmp_path / "b.db"))
    await store.open()
    poller = SpanLocalPoller(cfg, store)
    ft = FakeTime()
    ctl = BreakerController(cfg, poller.client, store, cache=poller, state_dir=str(tmp_path),
                            sleep=ft.sleep, clock=ft.clock, mono=ft.clock)
    yield panel, ctl, ft, store, alerts, tmp_path
    await ctl.stop()
    await store.close()
    panel.stop()


async def events(store) -> list[dict]:
    return [e for e in await store.get_events("span", 1) if e["type"] == "span_breaker"]


def cycle_file(tmp_path):
    return tmp_path / span_control.CYCLE_FILE


# --- allowlist + opt-ins -------------------------------------------------------------
async def test_unlisted_circuit_is_refused_audited_and_alerted(rig):
    panel, ctl, ft, store, alerts, _ = rig
    with pytest.raises(BreakerRefused) as e:
        await ctl.execute("Garage", "close", source="ui")
    assert e.value.status_code == 403 and "allowlist" in str(e.value)
    assert panel.writes == []
    ev = await events(store)
    assert ev and ev[0]["code"] == "refused" and "Garage" in ev[0]["message"]
    assert any(k == "push" for k, *_ in alerts) and any(k == "email" for k, *_ in alerts)


async def test_backup_element_is_close_only_and_heat_pumps_cycle_only(rig):
    panel, ctl, ft, store, _, _ = rig
    with pytest.raises(BreakerRefused, match="power cycle is not allowed"):
        await ctl.execute("Buffer Tank", "power_cycle")
    with pytest.raises(BreakerRefused, match="close-only"):
        await ctl.execute("Buffer Tank", "open")
    with pytest.raises(BreakerRefused, match="power cycle only"):
        await ctl.execute("Air-Water 1", "open")
    with pytest.raises(BreakerRefused, match="unknown breaker action"):
        await ctl.execute("Air-Water 1", "toggle")
    assert panel.writes == []
    # close is allowed on every listed circuit
    r = await ctl.execute("Buffer Tank", "close")
    assert r["ok"] and r["relay_state"] == "CLOSED" and r["verified"]


def test_config_floor_and_element_lock():
    with pytest.raises(ValidationError, match="min_off_s"):
        SpanConfig(min_off_s=30)
    with pytest.raises(ValidationError, match="min_off_s"):
        SpanConfig(min_off_s=float("nan"))
    with pytest.raises(ValidationError, match="close-only"):
        SpanConfig(breakers=[BreakerCircuit(name="Buffer Tank", allow_open=True)])
    with pytest.raises(ValidationError, match="close-only"):
        SpanConfig(breakers=[BreakerCircuit(name="Buffer Tank", allow_cycle=True)])
    with pytest.raises(ValidationError, match="never allow_open"):
        SpanConfig(breakers=[BreakerCircuit(name="Air-Water 1", allow_cycle=True, heat_pump=True,
                                            allow_open=True)])
    with pytest.raises(ValidationError, match="close-only"):
        SpanConfig(arm_circuit="Something Else",
                   breakers=[BreakerCircuit(name="Buffer Tank", allow_open=True)])
    with pytest.raises(ValidationError, match="heat_pump must be true"):
        SpanConfig(breakers=[BreakerCircuit(name="Air-Water 2", allow_cycle=True)])
    d = SpanConfig()
    assert d.min_off_s == 60
    by = {b.name: b for b in d.breakers}
    assert by["Air-Water 1"].allow_cycle and not by["Air-Water 1"].allow_open
    assert by["Air-Water 2"].heat_pump and not by["Buffer Tank"].allow_cycle


async def test_off_s_below_floor_is_refused(rig):
    panel, ctl, ft, store, _, _ = rig
    for bad in (30, 59.9, float("nan"), True, "60"):
        with pytest.raises(BreakerRefused):
            await ctl.execute("Air-Water 2", "power_cycle", off_s=bad)
    with pytest.raises(BreakerRefused, match="max_off_s"):
        await ctl.execute("Air-Water 2", "power_cycle", off_s=601)
    assert panel.writes == []


# --- the power cycle ------------------------------------------------------------------
async def test_power_cycle_opens_holds_60s_closes_and_verifies(rig):
    panel, ctl, ft, store, alerts, tmp_path = rig
    r = await ctl.execute("Air-Water 2", "power_cycle", source="ui")
    assert panel.writes == [("Air-Water 2", "OPEN"), ("Air-Water 2", "CLOSED")]
    assert 60 in ft.sleeps                                   # default hold = the 60 s floor
    assert r["ok"] and r["verified"] and r["relay_state"] == "CLOSED"
    assert r["off_s"] >= 60
    assert panel.relay("Air-Water 2") == "CLOSED"
    codes = [e["code"] for e in await events(store)]
    assert "cycle_opened" in codes and "cycle_done" in codes
    assert not cycle_file(tmp_path).exists()
    assert ctl.snapshot()["busy"] is None and ctl.last["action"] == "power_cycle"


async def test_power_cycle_honours_a_longer_hold(rig):
    panel, ctl, ft, *_ = rig
    r = await ctl.execute("Air-Water 1", "power_cycle", off_s=180)
    assert 180 in ft.sleeps and r["off_s"] >= 180 and r["ok"]


async def test_close_runs_in_finally_when_the_cycle_raises(rig, monkeypatch):
    panel, ctl, ft, store, _, _ = rig
    t0 = ft.t

    real = ctl._readback
    calls = {"n": 0}

    async def broken_once(*a, **k):          # the OPEN's read-back blows up; later ones work
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom after the OPEN")
        return await real(*a, **k)
    monkeypatch.setattr(ctl, "_readback", broken_once)
    with pytest.raises(RuntimeError):
        await ctl.execute("Air-Water 2", "power_cycle")
    assert panel.writes == [("Air-Water 2", "OPEN"), ("Air-Water 2", "CLOSED")]
    assert ft.t - t0 >= 60                  # the full hold still ran before the CLOSE
    assert ctl.snapshot()["busy"] is None


async def test_a_broken_sleep_cannot_skip_the_hold(rig):
    panel, ctl, ft, *_ = rig
    ft.raise_once = 60.0                    # the injected sleep blows up at the hold
    r = await ctl.execute("Air-Water 2", "power_cycle")
    assert r["ok"] and panel.relay("Air-Water 2") == "CLOSED"
    assert panel.writes[-1] == ("Air-Water 2", "CLOSED")


async def test_cancelling_the_cycle_task_does_not_shorten_the_hold(rig):
    panel, ctl, ft, *_ = rig
    ft.block = 60.0
    caller = asyncio.create_task(ctl.execute("Air-Water 2", "power_cycle"))
    while panel.relay("Air-Water 2") != "OPEN" or ctl._task is None:
        await asyncio.sleep(0.01)
    inner = ctl._task
    inner.cancel()                          # e.g. loop teardown
    await asyncio.sleep(0.05)
    assert panel.relay("Air-Water 2") == "OPEN"     # still holding
    assert not inner.done()
    ft.release.set()
    with pytest.raises(asyncio.CancelledError):
        await inner                         # re-raised only after...
    assert panel.relay("Air-Water 2") == "CLOSED"   # ...the CLOSE landed
    with pytest.raises(asyncio.CancelledError):
        await caller


async def test_unpersistable_cycle_record_refuses_before_any_write(tmp_path, alerts):
    panel = FakeSpan()
    addr = panel.start()
    store = Store(str(tmp_path / "b.db"))
    await store.open()
    try:
        cfg = SpanConfig(host=addr, passphrase="pw")
        poller = SpanLocalPoller(cfg, store)
        ft = FakeTime()
        ctl = BreakerController(cfg, poller.client, store, cache=poller,
                                state_dir=str(tmp_path / "no-such-dir"), sleep=ft.sleep,
                                clock=ft.clock, mono=ft.clock)
        with pytest.raises(BreakerRefused, match="persist") as e:
            await ctl.execute("Air-Water 2", "power_cycle")
        assert e.value.status_code == 503 and panel.writes == []
    finally:
        await store.close()
        panel.stop()


async def test_stopping_controller_refuses_new_actions(rig):
    panel, ctl, *_ = rig
    await ctl.stop()
    with pytest.raises(BreakerRefused, match="shutting down") as e:
        await ctl.execute("Buffer Tank", "close")
    assert e.value.status_code == 503 and panel.writes == []


async def test_duplicate_panel_names_are_refused(rig):
    panel, ctl, *_ = rig
    panel.circuits["Air-Water 2 (dup)"] = {"id": "c-aw2b", "relayState": "CLOSED",
                                           "isUserControllable": True, "instantPowerW": 0.0}
    # the fake reports names from the dict key; rename the duplicate on the wire
    real = panel.circuits.pop("Air-Water 2 (dup)")
    panel.dupes = {"c-aw2b": ("Air-Water 2", real)}
    with pytest.raises(BreakerRefused, match="refusing to guess"):
        await ctl.execute("Air-Water 2", "power_cycle")
    assert panel.writes == []


async def test_cycle_survives_its_caller_going_away(rig):
    panel, ctl, ft, *_ = rig
    ft.block = 60.0
    caller = asyncio.create_task(ctl.execute("Air-Water 2", "power_cycle"))
    while panel.relay("Air-Water 2") != "OPEN":
        await asyncio.sleep(0.01)
    caller.cancel()                         # browser closed / hub link dropped
    with pytest.raises(asyncio.CancelledError):
        await caller
    assert panel.relay("Air-Water 2") == "OPEN"   # still mid-hold, not abandoned...
    ft.release.set()
    for _ in range(300):
        if panel.relay("Air-Water 2") == "CLOSED" and ctl.snapshot()["busy"] is None:
            break
        await asyncio.sleep(0.01)
    assert panel.relay("Air-Water 2") == "CLOSED"  # ...and finished on its own


async def test_close_retries_then_succeeds(rig):
    panel, ctl, ft, *_ = rig
    panel.fail_closes = 2
    r = await ctl.execute("Air-Water 2", "power_cycle")
    assert r["ok"] and r["close_attempts"] == 3
    assert [w for w in panel.writes if w[1] == "CLOSED"] == [("Air-Water 2", "CLOSED")] * 3


async def test_close_failure_pages_urgent_blocks_offs_and_recloses_in_background(rig):
    panel, ctl, ft, store, alerts, tmp_path = rig
    panel.fail_closes = 10_000
    r = await ctl.execute("Air-Water 2", "power_cycle")
    assert not r["ok"] and r["relay_state"] == "OPEN" and "COULD NOT" in r["detail"]
    urgent = [a for a in alerts if a[0] == "push" and a[2] == "urgent"]
    assert urgent and "Air-Water 2" in urgent[0][1]
    mail = [a for a in alerts if a[0] == "email" and "URGENT" in a[1]]
    assert mail and "SPAN panel" in mail[0][2]           # the manual instruction
    assert "close_failed" in [e["code"] for e in await events(store)]
    assert cycle_file(tmp_path).exists()                  # a restart would resume the close
    assert ctl.snapshot()["pending_close"] == ["Air-Water 2"]
    # nothing that turns power OFF may run until it is verified back on
    with pytest.raises(BreakerRefused, match="verified back ON"):
        await ctl.execute("Air-Water 1", "power_cycle")
    panel.fail_closes = 0                                 # panel recovers
    for _ in range(500):
        if not ctl.snapshot()["pending_close"]:
            break
        await asyncio.sleep(0.01)
    assert panel.relay("Air-Water 2") == "CLOSED"
    assert not cycle_file(tmp_path).exists()
    assert "reclosed" in [e["code"] for e in await events(store)]


# --- guards ---------------------------------------------------------------------------
async def test_global_lock_refuses_a_second_action(rig):
    panel, ctl, ft, store, _, _ = rig
    ft.block = 60.0
    first = asyncio.create_task(ctl.execute("Air-Water 2", "power_cycle"))
    while ctl.snapshot()["busy"] is None:
        await asyncio.sleep(0.01)
    with pytest.raises(BreakerRefused, match="one at a time") as e:
        await ctl.execute("Kitchen", "close")
    assert e.value.status_code == 409
    ft.release.set()
    assert (await first)["ok"]
    assert ("Kitchen", "CLOSED") not in panel.writes


async def test_not_user_controllable_is_refused(rig):
    panel, ctl, *_ = rig
    panel.set("Air-Water 2", isUserControllable=False)
    with pytest.raises(BreakerRefused, match="isUserControllable"):
        await ctl.execute("Air-Water 2", "power_cycle")
    assert panel.writes == []


async def test_never_two_heat_pumps_off(rig):
    panel, ctl, *_ = rig
    panel.set("Air-Water 1", relayState="OPEN")
    with pytest.raises(BreakerRefused, match="never two heat pumps off"):
        await ctl.execute("Air-Water 2", "power_cycle")
    assert panel.writes == []
    # turning the other one back ON is always allowed
    assert (await ctl.execute("Air-Water 1", "close"))["ok"]


async def test_already_off_circuit_is_not_power_cycled(rig):
    panel, ctl, *_ = rig
    panel.set("Kitchen", relayState="OPEN")
    with pytest.raises(BreakerRefused, match="already OPEN"):
        await ctl.execute("Kitchen", "open")


async def test_panel_unreachable_is_a_clean_refusal(rig):
    panel, ctl, *_ = rig
    panel.down = True
    with pytest.raises(BreakerRefused, match="unreachable") as e:
        await ctl.execute("Air-Water 2", "power_cycle")
    assert e.value.status_code == 503 and panel.writes == []


# --- read-back --------------------------------------------------------------------------
async def test_readback_mismatch_is_reported_not_confirmed(rig):
    panel, ctl, ft, store, _, _ = rig
    panel.set("Kitchen", relayState="OPEN")
    panel.ignore_writes = True               # 200 to the write, relay never moves
    r = await ctl.execute("Kitchen", "close")
    assert not r["ok"] and not r["verified"] and r["relay_state"] == "OPEN"
    assert "verify_mismatch" in [e["code"] for e in await events(store)]


async def test_power_cycle_whose_open_never_lands_is_not_confirmed(rig):
    panel, ctl, ft, *_ = rig
    panel.ignore_writes = True
    r = await ctl.execute("Air-Water 2", "power_cycle")
    assert not r["ok"] and "NOT confirmed" in r["detail"]
    assert r["relay_state"] == "CLOSED"       # still on, which the result says plainly


async def test_open_then_close_respects_min_off_time(rig):
    panel, ctl, ft, *_ = rig
    r = await ctl.execute("Kitchen", "open")
    assert r["ok"] and r["relay_state"] == "OPEN"
    with pytest.raises(BreakerRefused, match="minimum off time"):
        await ctl.execute("Kitchen", "close")
    ft.t += 60
    assert (await ctl.execute("Kitchen", "close"))["relay_state"] == "CLOSED"


async def test_min_off_after_a_bare_open_survives_a_restart(rig):
    panel, ctl, ft, store, alerts, tmp_path = rig
    ctl._boot_id = "boot-A"
    assert (await ctl.execute("Kitchen", "open"))["ok"]
    fresh = BreakerController(ctl.cfg, ctl.client, store, cache=ctl.cache, state_dir=str(tmp_path),
                              sleep=ft.sleep, clock=ft.clock, mono=ft.clock)
    fresh._boot_id = "boot-A"
    await fresh.recover()                      # a restart within the same boot
    ft.t += 30
    with pytest.raises(BreakerRefused, match="minimum off time"):
        await fresh.execute("Kitchen", "close")
    ft.t += 30
    assert (await fresh.execute("Kitchen", "close"))["relay_state"] == "CLOSED"
    rebooted = BreakerController(ctl.cfg, ctl.client, store, cache=ctl.cache, state_dir=str(tmp_path),
                                 sleep=ft.sleep, clock=ft.clock, mono=ft.clock)
    await rebooted.recover()                   # the close cleared the record
    assert rebooted._opened_at == {}


async def test_untimed_bare_open_restarts_the_hold_after_a_restart(rig, monkeypatch):
    panel, ctl, ft, store, alerts, tmp_path = rig
    ctl._boot_id = "boot-A"
    writes = {"n": 0}
    real = ctl._write_durable

    def fail_after_first(path, obj):          # the post-OPEN timestamp never reaches the disk
        writes["n"] += 1
        return real(path, obj) if writes["n"] == 1 else False
    monkeypatch.setattr(ctl, "_write_durable", fail_after_first)
    assert (await ctl.execute("Kitchen", "open"))["ok"]
    rec = json.loads((tmp_path / span_control.OPENS_FILE).read_text())
    assert rec["Kitchen"]["opened_mono"] is None          # only the untimed marker made it
    ft.t += 45
    fresh = BreakerController(ctl.cfg, ctl.client, store, cache=ctl.cache, state_dir=str(tmp_path),
                              sleep=ft.sleep, clock=ft.clock, mono=ft.clock)
    fresh._boot_id = "boot-A"
    await fresh.recover()
    ft.t += 30                                             # 75 s after the OPEN, 30 s after restart
    with pytest.raises(BreakerRefused, match="minimum off time"):
        await fresh.execute("Kitchen", "close")


async def test_unreadable_opens_history_fails_closed(rig):
    panel, ctl, ft, store, alerts, tmp_path = rig
    for bad in ("{not json", None):
        path = tmp_path / span_control.OPENS_FILE
        if path.is_dir():
            path.rmdir()
        if bad is None:
            path.unlink(missing_ok=True)
            path.mkdir()                       # reading it raises an OSError
        else:
            path.write_text(bad)
        fresh = BreakerController(ctl.cfg, ctl.client, store, cache=ctl.cache, state_dir=str(tmp_path),
                                  sleep=ft.sleep, clock=ft.clock, mono=ft.clock)
        await fresh.recover()
        panel.set("Kitchen", relayState="OPEN")
        with pytest.raises(BreakerRefused, match="minimum off time"):
            await fresh.execute("Kitchen", "close")
        await fresh.stop()


async def test_transient_cycle_record_read_error_keeps_the_record_and_recovers(rig, monkeypatch):
    panel, ctl, ft, store, alerts, tmp_path = rig
    panel.set("Air-Water 2", relayState="OPEN")
    cycle_file(tmp_path).write_text(json.dumps(
        {"name": "Air-Water 2", "circuit_id": "c-aw2", "opened_at": None, "off_s": 60}))
    real = ctl._read_cycle_file
    fails = {"n": 2}

    def flaky():
        if fails["n"] > 0:
            fails["n"] -= 1
            raise OSError("EIO")
        return real()
    monkeypatch.setattr(ctl, "_read_cycle_file", flaky)
    await ctl.recover()
    assert cycle_file(tmp_path).exists()                     # not deleted
    assert ctl._record_blocked
    for _ in range(500):
        if panel.relay("Air-Water 2") == "CLOSED" and not cycle_file(tmp_path).exists():
            break
        await asyncio.sleep(0.01)
    assert panel.relay("Air-Water 2") == "CLOSED"
    assert not cycle_file(tmp_path).exists()
    assert any(a[2] == "urgent" for a in alerts if a[0] == "push")


async def test_blocked_record_refuses_off_actions(rig, monkeypatch):
    panel, ctl, ft, store, alerts, tmp_path = rig
    cycle_file(tmp_path).write_text("{}")

    def broken():
        raise OSError("EIO")
    monkeypatch.setattr(ctl, "_read_cycle_file", broken)
    monkeypatch.setattr(span_control, "RECORD_RETRY_S", 10_000.0)
    ft.block = 10_000.0
    await ctl.recover()
    with pytest.raises(BreakerRefused, match="can't be read yet"):
        await ctl.execute("Air-Water 1", "power_cycle")
    assert (await ctl.execute("Buffer Tank", "close"))["ok"]   # ON stays possible
    ft.release.set()


async def test_min_off_after_a_reboot_restarts_the_hold(rig):
    panel, ctl, ft, store, alerts, tmp_path = rig
    ctl._boot_id = "boot-A"
    assert (await ctl.execute("Kitchen", "open"))["ok"]
    ft.t += 3600                               # long ago, but a reboot makes it unknowable
    rebooted = BreakerController(ctl.cfg, ctl.client, store, cache=ctl.cache, state_dir=str(tmp_path),
                                 sleep=ft.sleep, clock=ft.clock, mono=ft.clock)
    rebooted._boot_id = "boot-B"
    await rebooted.recover()
    with pytest.raises(BreakerRefused, match="minimum off time"):
        await rebooted.execute("Kitchen", "close")


# --- crash recovery -----------------------------------------------------------------------
async def test_recover_closes_a_circuit_a_restart_left_open(rig):
    panel, ctl, ft, store, alerts, tmp_path = rig
    panel.set("Air-Water 2", relayState="OPEN")
    ctl._boot_id = "boot-A"                   # same boot: the monotonic clock is trusted
    cycle_file(tmp_path).write_text(json.dumps(
        {"name": "Air-Water 2", "circuit_id": "c-aw2", "opened_at": ft.t - 20,
         "opened_mono": ft.t - 20, "boot_id": "boot-A", "off_s": 60}))
    await ctl.recover()
    assert ctl.snapshot()["busy"]["action"] == "recover_close"
    for _ in range(300):
        if ctl.snapshot()["busy"] is None:
            break
        await asyncio.sleep(0.01)
    assert panel.relay("Air-Water 2") == "CLOSED"
    assert 40 in ft.sleeps                    # only the remainder of the 60 s was held
    assert not cycle_file(tmp_path).exists()


async def test_recover_after_a_reboot_holds_the_full_time(rig):
    panel, ctl, ft, store, alerts, tmp_path = rig
    panel.set("Air-Water 2", relayState="OPEN")
    ctl._boot_id = "boot-B"                   # rebooted: wall/mono time since the OPEN unknown
    cycle_file(tmp_path).write_text(json.dumps(
        {"name": "Air-Water 2", "circuit_id": "c-aw2", "opened_at": ft.t - 600,
         "opened_mono": 5.0, "boot_id": "boot-A", "off_s": 60}))
    t0 = ft.t
    await ctl.recover()
    for _ in range(300):
        if ctl.snapshot()["busy"] is None:
            break
        await asyncio.sleep(0.01)
    assert panel.relay("Air-Water 2") == "CLOSED" and ft.t - t0 >= 60


async def test_recover_cancelled_during_its_first_audit_still_closes(rig, monkeypatch):
    panel, ctl, ft, store, alerts, tmp_path = rig
    panel.set("Air-Water 2", relayState="OPEN")
    cycle_file(tmp_path).write_text(json.dumps(
        {"name": "Air-Water 2", "circuit_id": "c-aw2", "opened_at": None, "off_s": 60}))
    gate = asyncio.Event()
    real = store.add_event

    async def slow_add_event(*a, **k):
        if k.get("code") == "cycle_recover":
            await gate.wait()
        return await real(*a, **k)
    monkeypatch.setattr(store, "add_event", slow_add_event)
    t0 = ft.t
    await ctl.recover()
    task = ctl._task
    await asyncio.sleep(0.02)
    task.cancel()                             # cancelled while the audit is still pending
    await asyncio.sleep(0.02)
    gate.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert panel.relay("Air-Water 2") == "CLOSED" and ft.t - t0 >= 60


async def test_cancel_while_the_open_is_in_flight_holds_from_when_it_lands(rig, monkeypatch):
    panel, ctl, ft, *_ = rig
    gate = asyncio.Event()
    stamps: list[tuple[str, float]] = []
    real = ctl.client.set_relay

    async def slow_set_relay(cid, want="CLOSED", **kw):
        if want == "OPEN":
            await gate.wait()                 # the OPEN is slow to land...
            ft.t += 30                        # ...30 s late
        out = await real(cid, want, **kw)
        stamps.append((want, ft.t))
        return out
    monkeypatch.setattr(ctl.client, "set_relay", slow_set_relay)
    caller = asyncio.create_task(ctl.execute("Air-Water 2", "power_cycle"))
    while ctl._task is None:
        await asyncio.sleep(0.01)
    inner = ctl._task
    await asyncio.sleep(0.02)
    inner.cancel()                            # cancelled while the OPEN is still in flight
    await asyncio.sleep(0.02)
    gate.set()
    with pytest.raises(asyncio.CancelledError):
        await inner
    opened = next(t for w, t in stamps if w == "OPEN")
    closed = next(t for w, t in stamps if w == "CLOSED")
    assert closed - opened >= 60              # the hold counted from when the OPEN landed
    assert panel.relay("Air-Water 2") == "CLOSED"
    with pytest.raises(asyncio.CancelledError):
        await caller


async def test_interlock_covers_a_heat_pump_dropped_from_the_allowlist(tmp_path, alerts):
    panel = FakeSpan()
    addr = panel.start()
    store = Store(str(tmp_path / "b.db"))
    await store.open()
    try:
        cfg = SpanConfig(host=addr, passphrase="pw",
                         breakers=[BreakerCircuit(name="Air-Water 2", allow_cycle=True, heat_pump=True)])
        poller = SpanLocalPoller(cfg, store)
        ft = FakeTime()
        ctl = BreakerController(cfg, poller.client, store, cache=poller, state_dir=str(tmp_path),
                                sleep=ft.sleep, clock=ft.clock, mono=ft.clock)
        panel.set("Air-Water 1", relayState="OPEN")
        with pytest.raises(BreakerRefused, match="never two heat pumps off"):
            await ctl.execute("Air-Water 2", "power_cycle")
        panel.circuits["Renamed"] = panel.circuits.pop("Air-Water 1")   # not on the panel at all
        with pytest.raises(BreakerRefused, match="not confirmed ON"):
            await ctl.execute("Air-Water 2", "power_cycle")
        assert panel.writes == []
    finally:
        await store.close()
        panel.stop()


async def test_recover_with_untimed_open_holds_the_full_minimum(rig):
    panel, ctl, ft, store, alerts, tmp_path = rig
    panel.set("Air-Water 2", relayState="OPEN")
    cycle_file(tmp_path).write_text(json.dumps(
        {"name": "Air-Water 2", "circuit_id": "c-aw2", "opened_at": None, "off_s": 60}))
    t0 = ft.t
    await ctl.recover()
    for _ in range(300):
        if ctl.snapshot()["busy"] is None:
            break
        await asyncio.sleep(0.01)
    assert panel.relay("Air-Water 2") == "CLOSED" and ft.t - t0 >= 60


async def test_unreadable_cycle_record_pages(rig):
    panel, ctl, ft, store, alerts, tmp_path = rig
    cycle_file(tmp_path).write_text("{not json")
    await ctl.recover()
    await asyncio.sleep(0.05)                 # alerts are fire-and-forget tasks
    assert any(a[2] == "urgent" for a in alerts if a[0] == "push")
    assert not cycle_file(tmp_path).exists()


# --- the keystone ---------------------------------------------------------------------------
async def test_span_client_refuses_open_without_a_permit():
    panel = FakeSpan()
    addr = panel.start()
    try:
        c = SpanClient(addr, "pw")
        with pytest.raises(ValueError, match="CLOSE-ONLY"):
            await c.set_relay("c-bt", "OPEN")
        with pytest.raises(ValueError, match="unknown relay state"):
            await c.set_relay("c-bt", "TOGGLE")
        p = OpenPermit("c-aw2", "Air-Water 2", "test")
        with pytest.raises(ValueError, match="not circuit"):
            await c.set_relay("c-bt", "OPEN", open_permit=p)
        p2 = OpenPermit("c-aw2", "Air-Water 2", "test")
        assert await c.set_relay("c-aw2", "OPEN", open_permit=p2) == "OPEN"
        with pytest.raises(ValueError, match="already used"):
            await c.set_relay("c-aw2", "OPEN", open_permit=p2)
        assert panel.writes == [("Air-Water 2", "OPEN")]
        assert await c.set_relay("c-aw2") == "CLOSED"   # the default stays CLOSE
    finally:
        panel.stop()


# --- bridge API: human-only ----------------------------------------------------------------
TOKEN = "t" * 24


def test_api_breaker_needs_a_session_even_with_protection_off(tmp_path):
    panel = FakeSpan()
    addr = panel.start()
    try:
        cfg = AppConfig(
            pumps=[PumpConfig(id="pump1", name="P1", host="127.0.0.1", port=59999,
                              poll_interval_s=999)],
            span=SpanConfig(host=addr, passphrase="pw"),
            db_path=str(tmp_path / "b.db"), ui_dir="ui")
        from bridge.main import create_app
        with TestClient(create_app(cfg)) as c:
            body = {"circuit": "Buffer Tank", "action": "close"}
            assert c.post("/api/span/breaker", json=body).status_code == 401   # anonymous
            c.get("/")                                    # the LAN page mints a session (protect=off)
            r = c.post("/api/span/breaker", json=body)
            assert r.status_code == 200 and r.json()["relay_state"] == "CLOSED"
    finally:
        panel.stop()


def test_api_breaker_is_human_only_and_circuits_readable(tmp_path):
    panel = FakeSpan()
    addr = panel.start()
    try:
        cfg = AppConfig(
            pumps=[PumpConfig(id="pump1", name="P1", host="127.0.0.1", port=59999,
                              poll_interval_s=999)],
            auth=AuthConfig(protect="writes", ui_password="correct-horse",
                            tokens=[ApiToken(token=TOKEN, source="tempiq", can_write=True)]),
            span=SpanConfig(host=addr, passphrase="pw"),
            db_path=str(tmp_path / "b.db"), ui_dir="ui")
        from bridge.main import create_app
        with TestClient(create_app(cfg)) as c:
            body = {"circuit": "Buffer Tank", "action": "close"}
            # a write-capable MACHINE token is still refused: breakers are human-only
            r = c.post("/api/span/breaker", json=body, headers={"Authorization": f"Bearer {TOKEN}"})
            assert r.status_code == 403 and "human-only" in r.json()["detail"]
            assert c.post("/api/span/breaker", json=body).status_code == 401   # anonymous
            assert c.post("/api/session", json={"password": "correct-horse"}).status_code == 200
            r = c.post("/api/span/breaker", json=body)
            assert r.status_code == 200 and r.json()["relay_state"] == "CLOSED"
            r = c.post("/api/span/breaker", json={"circuit": "Garage", "action": "close"})
            assert r.status_code == 403
            snap = c.get("/api/span/circuits").json()
            names = [x["name"] for x in snap["circuits"]]
            assert names == ["Air-Water 1", "Air-Water 2", "Buffer Tank"]
            assert snap["min_off_s"] == 60
    finally:
        panel.stop()


# --- hub relay ---------------------------------------------------------------------------------
def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def test_hub_breaker_command_acks_with_readback_and_advertises_capability(rig):
    panel, ctl, ft, *_ = rig
    frames: list[dict] = []
    conn: dict = {}
    ready = asyncio.Event()

    async def handler(ws):
        conn["ws"] = ws
        ready.set()
        async for raw in ws:
            frames.append(json.loads(raw))

    port = free_port()
    server = await serve(handler, "127.0.0.1", port)
    client = HubClient(HubConfig(url=f"ws://127.0.0.1:{port}/pi", token="pi", state_interval_s=0.1), {})
    client.span = ctl
    client.start()
    try:
        await asyncio.wait_for(ready.wait(), 5)

        async def ack_for(cid):
            for _ in range(500):
                for f in frames:
                    if f.get("type") == "ack" and f.get("command_id") == cid:
                        return f
                await asyncio.sleep(0.01)
            raise AssertionError("no ack")

        async def send(cid, **kw):
            await conn["ws"].send(json.dumps({"type": "command", "command_id": cid,
                                              "action": "breaker", **kw}))
            return await ack_for(cid)

        for _ in range(500):
            if any(f.get("type") == "state" for f in frames):
                break
            await asyncio.sleep(0.01)
        state = next(f for f in frames if f.get("type") == "state")
        assert state["capabilities"] == ["breaker"]
        assert [c["name"] for c in state["span"]["circuits"]][:2] == ["Air-Water 1", "Air-Water 2"]

        ack = await send("c1", circuit="Air-Water 2", op="power_cycle", off_s=60)
        assert ack["ok"] is True and ack["result"]["relay_state"] == "CLOSED"
        assert ack["result"]["verified"] is True and ack["result"]["off_s"] >= 60

        ack = await send("c2", circuit="Buffer Tank", op="open")
        assert ack["ok"] is False and ack["result"]["refused"] is True

        ack = await send("c3", circuit="Air-Water 2", op="power_cycle", off_s=10)
        assert ack["ok"] is False and "minimum off time" in ack["detail"]

        client.span = None   # a bridge without SPAN local configured: clean nack
        ack = await send("c4", circuit="Air-Water 2", op="close")
        assert ack["ok"] is False and "not configured" in ack["detail"]
    finally:
        await client.stop()
        server.close()
        await server.wait_closed()
