# @purpose: End-to-end tests against a real in-process simulated pump: RTU-over-TCP
# round trip, poller snapshot + sample persistence, fault edge detection (on once,
# off once), guarded write with read-back, and offline watchdog.
from __future__ import annotations

import asyncio
import socket

import pytest

from bridge import registers as R
from bridge.config import AppConfig, GuardrailConfig, PumpConfig
from bridge.guardrails import GuardrailError, SetpointGuard
from bridge.poller import PumpPoller
from bridge.store import Store
from sim.fake_pump import FakePump


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
async def rig(tmp_path):
    """A running fake pump + store + poller (loop not started; tests call poll_once)."""
    port = free_port()
    pump = FakePump(1, port)
    await pump.start()
    await pump.tick()

    cfg = AppConfig(
        pumps=[PumpConfig(id="p1", name="Pump 1", host="127.0.0.1", port=port,
                          poll_interval_s=1, write_enabled=True)],
        guardrails=GuardrailConfig(min_write_interval_s=0.1),
        db_path=str(tmp_path / "test.db"),
    )
    store = Store(cfg.db_path)
    await store.open()
    guard = SetpointGuard(cfg.guardrails)
    poller = PumpPoller(cfg.pumps[0], cfg, store, guard)

    yield pump, poller, store

    poller.client.close()
    await pump.server.shutdown()
    await store.close()


async def test_poll_reads_snapshot_and_persists(rig):
    pump, poller, store = rig
    await poller.poll_once()
    snap = poller.snapshot
    assert snap["online"] is True
    assert snap["setpoint_c"] == 45
    assert 20 < snap["inlet_c"] < 60
    assert snap["state"] in ("heating", "idle")
    history = await store.get_history("p1", 1)
    assert len(history) == 1


async def test_fault_edge_detection_on_once_off_once(rig):
    pump, poller, store = rig
    await poller.poll_once()
    assert poller.snapshot["active_faults"] == []

    await pump.inject_fault("P01", on=True)
    await poller.poll_once()
    await poller.poll_once()  # persistent fault: must NOT log a second fault_on
    faults = poller.snapshot["active_faults"]
    assert len(faults) == 1
    assert faults[0]["code"] == "P01"
    assert faults[0]["severity"] == "critical"
    assert poller.snapshot["state"] == "fault"

    await pump.inject_fault("P01", on=False)
    await poller.poll_once()
    assert poller.snapshot["active_faults"] == []

    events = await store.get_events("p1", 1)
    fault_events = [e for e in events if e["type"].startswith("fault")]
    assert [e["type"] for e in fault_events] == ["fault_off", "fault_on"]  # newest first


async def test_p17_is_info_and_does_not_set_fault_state(rig):
    pump, poller, store = rig
    await pump.inject_fault("P17", on=True)
    await poller.poll_once()
    faults = poller.snapshot["active_faults"]
    assert len(faults) == 1
    assert faults[0]["severity"] == "info"
    assert poller.snapshot["state"] != "fault"  # anti-freeze never alarms the chip


async def test_guarded_write_with_readback(rig):
    pump, poller, store = rig
    await poller.poll_once()
    result = await poller.write_setpoint(48, source="test")
    assert result == {"setpoint_c": 48, "verified": True, "mode": "heating", "unchanged": False}
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 48

    # audit trail: accepted write recorded with old/new/source
    events = await store.get_events("p1", 1)
    write = next(e for e in events if e["type"] == "setpoint_write")
    assert write["code"] == "accepted"
    assert write["detail"]["source"] == "test"
    assert write["detail"]["requested"] == 48


async def test_same_value_setpoint_renews_without_rewriting(rig):
    """A lease renewal at the unchanged value must NOT hit the pump register again (EEPROM /
    event-log protection) and must NOT consume a rate-limit slot — but must still refresh the
    optimizer's lease. This is what makes a 15-min renewal loop cheap."""
    pump, poller, store = rig
    g = poller.app_cfg.guardrails
    g.min_write_interval_s = 0        # isolate the no-op behaviour from rate limiting
    g.baseline_setpoint_c = 48        # activates the lease regime
    g.unattended_min_setpoint_c = 45  # floor below 48 so the renewal is allowed
    await poller.poll_once()

    r1 = await poller.write_setpoint(48, source="optimizer", unattended=True, lease_minutes=90)
    assert r1 == {"setpoint_c": 48, "verified": True, "mode": "heating", "unchanged": False}
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 48
    lease_until_1 = poller._lease["until"]
    rate_slot_1 = poller.guard._last_write.get("p1")
    writes_1 = len([e for e in await store.get_events("p1", 1) if e["type"] == "setpoint_write"])

    # renew at the SAME value: no physical write, no new audit event, no rate-limit slot used,
    # but the lease timer still moves forward
    r2 = await poller.write_setpoint(48, source="optimizer", unattended=True, lease_minutes=90)
    assert r2 == {"setpoint_c": 48, "verified": True, "mode": "heating", "unchanged": True}
    writes_2 = len([e for e in await store.get_events("p1", 1) if e["type"] == "setpoint_write"])
    assert writes_2 == writes_1                                   # no new setpoint_write event
    assert poller.guard._last_write.get("p1") == rate_slot_1      # record_write skipped
    assert poller._lease["until"] >= lease_until_1                # lease still refreshed

    # a genuine change still writes through normally
    r3 = await poller.write_setpoint(47, source="optimizer", unattended=True, lease_minutes=90)
    assert r3["unchanged"] is False and await pump.get_reg(R.REG_SETPOINT_HEATING) == 47


async def test_write_rejections_are_audited(rig):
    pump, poller, store = rig
    await poller.poll_once()
    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(85, source="test")  # hardware max, above clamp
    assert exc.value.status_code == 422
    events = await store.get_events("p1", 1)
    rejected = next(e for e in events if e["type"] == "setpoint_write")
    assert rejected["code"] == "rejected"


async def test_offline_watchdog_and_write_refusal(rig):
    pump, poller, store = rig
    await poller.poll_once()
    assert poller.online

    await pump.server.shutdown()  # kill the "W610"
    for _ in range(3):
        await poller.poll_once()
    assert not poller.online
    assert poller.snapshot["state"] == "offline"

    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(45, source="test")  # never queue stale writes
    assert exc.value.status_code == 503

    events = await store.get_events("p1", 1)
    assert any(e["type"] == "comm" and e["code"] == "offline" for e in events)


async def test_offline_banner_splits_gateway_down_from_pump_silent(rig):
    """A card going OFFLINE must say WHICH layer is down: a dead/flapping W610 gateway (TCP
    connect fails) vs a live gateway with a silent pump (timeout/io/nak). Decided over a
    window of recent polls so a flapping gateway can't flip-flop the banner or contradict the
    scan. Regression for the commissioning-clarity ask + the flapping mislabel (2026-07-12/13)."""
    pump, poller, store = rig
    await poller.poll_once()
    assert poller.online
    assert poller.snapshot["link"] == "online"

    # Gateway unreachable: kill the "W610" so TCP connects fail -> "connect" outcomes.
    await pump.server.shutdown()
    for _ in range(3):
        await poller.poll_once()
    assert not poller.online
    assert poller.snapshot["link"] == "gateway_down"
    assert "gateway" in poller.snapshot["link_detail"].lower()

    # Live gateway, silent/garbled/NAKing pump -> pump_silent (a clean window of read fails).
    for cat in ("timeout", "io", "exception"):
        poller._recent_outcomes.clear()
        poller._recent_outcomes.extend([cat, cat, cat])
        assert poller._link_status()[0] == "pump_silent"

    # FLAPPING (the bug the two screens exposed): a gateway that drops on/off — connect
    # failures MIXED with pump timeouts — must read as gateway_down, not "pump not
    # responding", and say so, because the unstable link is what to fix first.
    poller._recent_outcomes.clear()
    poller._recent_outcomes.extend(["connect", "timeout", "connect", "timeout"])
    link, detail = poller._link_status()
    assert link == "gateway_down"
    assert "intermittent" in detail.lower()

    # Empty window -> unknown; never mislabels with no evidence.
    poller._recent_outcomes.clear()
    assert poller._link_status()[0] == "unknown"


async def test_write_enable_toggle_persists_and_composes_with_gateway_overrides(tmp_path):
    """The UI write-enable toggle persists in the bridge-owned state file and survives
    restarts; a later gateway reassignment must NOT clobber it, and a write_enabled-only
    override must not touch host/port. Same MAC-staleness rule as gateway overrides."""
    from bridge.config import (AppConfig, apply_gateway_overrides, save_gateway_override,
                               save_write_enabled)

    def make_cfg():
        return AppConfig(
            pumps=[PumpConfig(id="p1", name="P1", host="10.0.0.5",
                              mac="d8:b0:4c:12:34:56", write_enabled=False)],
            db_path=str(tmp_path / "bridge.db"))

    cfg = make_cfg()
    save_write_enabled(cfg, "p1", True)

    fresh = make_cfg()
    apply_gateway_overrides(fresh)
    assert fresh.pumps[0].write_enabled is True      # toggle survived the "restart"
    assert fresh.pumps[0].host == "10.0.0.5"         # write-only override left host alone

    save_gateway_override(cfg, "p1", "10.0.0.99", 8899)   # DHCP move / reassignment
    fresh = make_cfg()
    apply_gateway_overrides(fresh)
    assert fresh.pumps[0].host == "10.0.0.99"
    assert fresh.pumps[0].write_enabled is True      # reassignment kept the toggle

    save_write_enabled(cfg, "p1", False)             # back to read-only
    fresh = make_cfg()
    apply_gateway_overrides(fresh)
    assert fresh.pumps[0].write_enabled is False

    # different physical unit at this id -> whole override (incl. toggle) is stale
    save_write_enabled(cfg, "p1", True)
    replaced = AppConfig(
        pumps=[PumpConfig(id="p1", name="P1", host="10.0.0.5",
                          mac="aa:aa:aa:aa:aa:aa", write_enabled=False)],
        db_path=str(tmp_path / "bridge.db"))
    apply_gateway_overrides(replaced)
    assert replaced.pumps[0].write_enabled is False


async def test_write_enable_endpoint_flips_the_guard_at_runtime(rig):
    """POST /pumps/{id}/write-enable must take effect immediately on the live poller:
    disabled -> guarded writes refuse with 403; re-enabled -> they run again."""
    pump, poller, store = rig
    await poller.poll_once()
    await poller.write_setpoint(45, source="test")   # baseline: writes work

    poller.cfg.write_enabled = False                 # what the endpoint does at runtime
    poller.snapshot["write_enabled"] = False
    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(46, source="test")
    assert exc.value.status_code == 403

    poller.cfg.write_enabled = True
    result = await poller.write_setpoint(46, source="test")
    assert result["verified"] is True


async def test_boot_sentinel_frames_are_skipped_not_stored(rig):
    """Real MAHRW030ZA boards answer the first couple of polls after power-on with
    garbage: inlet/outlet/ambient all 0, then all -39 (sensor-init sentinel), before
    real values appear (observed live, HP1 commissioning 2026-07-13). Those frames are
    valid Modbus and must count as comm-OK, but store nothing and flip nothing."""
    pump, poller, store = rig

    # boot phase 1: all-zero temps
    for reg in (R.REG_INLET_TEMP, R.REG_OUTLET_TEMP, R.REG_AMBIENT_TEMP):
        await pump.set_reg(reg, 0)
    await poller.poll_once()
    assert not poller.online                      # no snapshot from a boot frame
    assert poller.client.stats.ok_polls == 1      # but comms counted as fine
    assert poller.client.stats.consecutive_failures == 0

    # boot phase 2: -39 sensor sentinels (two's complement on the wire)
    for reg in (R.REG_INLET_TEMP, R.REG_OUTLET_TEMP, R.REG_AMBIENT_TEMP):
        await pump.set_reg(reg, (-39) & 0xFFFF)
    await poller.poll_once()
    assert not poller.online
    assert await store.get_history("p1", 1) == []  # nothing persisted from boot frames

    # real values arrive -> normal poll, pump online, sample stored
    await pump.set_reg(R.REG_INLET_TEMP, 43)
    await pump.set_reg(R.REG_OUTLET_TEMP, 46)
    await pump.set_reg(R.REG_AMBIENT_TEMP, 36)
    await poller.poll_once()
    assert poller.online
    assert poller.snapshot["inlet_c"] == 43
    assert len(await store.get_history("p1", 1)) == 1

    # sanity: ordinary running data that happens to share ONE sentinel value is NOT
    # a boot frame (all three must be equal)
    await pump.set_reg(R.REG_AMBIENT_TEMP, 0)      # 0°C outdoors, water temps real
    await poller.poll_once()
    assert poller.online
    assert poller.snapshot["ambient_c"] == 0


async def test_unit_max_reg2027_caps_the_clamp(rig):
    pump, poller, store = rig
    await pump.set_reg(R.REG_MAX_WATER_TEMP, 50)  # unit's own limit below config's 55
    await poller.poll_once()
    assert poller.snapshot["setpoint_bounds_c"] == [30, 50]
    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(52, source="test")  # fine for config, above unit max
    assert exc.value.status_code == 422
    assert "unit max 50" in str(exc.value)


async def test_cooling_mode_targets_reg_2002_with_cooling_bounds(rig):
    pump, poller, store = rig
    await pump.set_reg(R.REG_MODE, 0)  # someone set cooling at the wall controller
    await pump.tick()
    await poller.poll_once()
    snap = poller.snapshot
    assert snap["mode_kind"] == "cooling"
    assert snap["setpoint_c"] == 16          # active setpoint is now reg 2002
    assert snap["setpoint_bounds_c"] == [12, 25]

    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(45, source="test")  # heating value, cooling mode
    assert exc.value.status_code == 422

    result = await poller.write_setpoint(18, source="test")
    assert result["mode"] == "cooling"
    assert await pump.get_reg(R.REG_SETPOINT_COOLING) == 18
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 45  # untouched


async def test_write_rereads_mode_fresh_not_from_snapshot(rig):
    pump, poller, store = rig
    await poller.poll_once()                 # snapshot says heating
    await pump.set_reg(R.REG_MODE, 0)        # mode flips AFTER the poll
    result = await poller.write_setpoint(18, source="test")
    assert result["mode"] == "cooling"       # fresh read routed to reg 2002
    assert await pump.get_reg(R.REG_SETPOINT_COOLING) == 18


async def test_hot_water_mode_refuses_remote_setpoint(rig):
    pump, poller, store = rig
    await pump.set_reg(R.REG_MODE, 5)
    await poller.poll_once()
    assert poller.snapshot["setpoint_bounds_c"] is None
    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(45, source="test")
    assert exc.value.status_code == 409


async def test_mode_switch_guarded_write(rig):
    pump, poller, store = rig
    await poller.poll_once()
    assert poller.snapshot["mode_kind"] == "heating"

    result = await poller.write_mode("cooling", source="test")
    assert result == {"mode": "cooling", "verified": True}
    assert await pump.get_reg(R.REG_MODE) == 0
    # the immediate re-poll refreshed the snapshot: mode, active setpoint, bounds
    assert poller.snapshot["mode_kind"] == "cooling"
    assert poller.snapshot["setpoint_bounds_c"] == [12, 25]

    events = await store.get_events("p1", 1)
    mode_event = next(e for e in events if e["type"] == "mode_write")
    assert mode_event["code"] == "accepted"
    assert mode_event["detail"]["source"] == "test"


async def test_power_toggle_guarded_write(rig):
    pump, poller, store = rig
    await poller.poll_once()
    result = await poller.write_power(False, source="test")
    assert result == {"on": False, "verified": True}
    assert await pump.get_reg(R.REG_ON_OFF) == 0
    assert poller.snapshot["on"] is False
    assert poller.snapshot["state"] == "off"

    events = await store.get_events("p1", 1)
    assert any(e["type"] == "power_write" and e["code"] == "accepted" for e in events)


async def test_control_writes_have_independent_rate_limits(rig):
    pump, poller, store = rig
    await poller.poll_once()
    # a mode write must not consume the setpoint limiter, and vice versa
    await poller.write_mode("cooling", source="test")
    await poller.write_setpoint(18, source="test")   # allowed immediately after
    await poller.write_power(False, source="test")   # and power has its own lane


async def test_control_writes_refused_when_disabled(rig):
    pump, poller, store = rig
    await poller.poll_once()
    poller.cfg.write_enabled = False
    for call in (poller.write_mode("cooling", source="test"),
                 poller.write_power(False, source="test")):
        with pytest.raises(GuardrailError) as exc:
            await call
        assert exc.value.status_code == 403
    poller.cfg.write_enabled = True


async def test_parameter_write_guarded(rig):
    pump, poller, store = rig
    await poller.poll_once()
    # happy path: lower the unit's own max water temp; setpoint bounds follow
    result = await poller.write_parameter("max_water_temp_c", 60, source="test")
    assert result == {"key": "max_water_temp_c", "value": 60, "verified": True}
    assert await pump.get_reg(R.REG_MAX_WATER_TEMP) == 60
    assert poller.snapshot["setpoint_bounds_c"] == [30, 60]

    # negative values encode as two's complement and verify correctly
    await asyncio.sleep(0.15)  # param writes share one rate-limit lane
    result = await poller.write_parameter("defrost_enter_coil_c", -5, source="test")
    assert result["verified"] is True
    assert R.to_signed(await pump.get_reg(2015)) == -5

    events = await store.get_events("p1", 1)
    writes = [e for e in events if e["type"] == "param_write" and e["code"] == "accepted"]
    assert len(writes) == 2


async def test_parameter_write_rejects_out_of_doc_range(rig):
    pump, poller, store = rig
    await poller.poll_once()
    with pytest.raises(GuardrailError) as exc:
        await poller.write_parameter("defrost_enter_coil_c", 5, source="test")  # doc: -15..-1
    assert exc.value.status_code == 422
    with pytest.raises(GuardrailError) as exc:
        await poller.write_parameter("not_a_param", 1, source="test")
    assert exc.value.status_code == 404


async def test_concurrent_setpoint_writes_cannot_bypass_rate_limit(rig):
    pump, poller, store = rig
    await poller.poll_once()
    results = await asyncio.gather(
        poller.write_setpoint(46, source="test"),
        poller.write_setpoint(47, source="test"),
        return_exceptions=True)
    ok = [r for r in results if isinstance(r, dict)]
    limited = [r for r in results if isinstance(r, GuardrailError)]
    assert len(ok) == 1 and len(limited) == 1     # the write lock serializes them
    assert limited[0].status_code == 429


async def test_non_integer_setpoint_rejected_not_rounded(rig):
    pump, poller, store = rig
    await poller.poll_once()
    before = await pump.get_reg(R.REG_SETPOINT_HEATING)
    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(44.5, source="test")
    assert exc.value.status_code == 422
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == before  # nothing written


async def test_rejected_control_write_does_not_fake_external_change(rig):
    pump, poller, store = rig
    await poller.poll_once()
    poller.cfg.write_enabled = False
    with pytest.raises(GuardrailError):
        await poller.write_power(False, source="test")
    poller.cfg.write_enabled = True
    await poller.poll_once()
    await poller.poll_once()
    fabricated = [e for e in await store.get_events("p1", 1)
                  if e["type"] == "state" and e["code"] == "changed_on"]
    assert fabricated == []   # the 403 rejection must not poison change detection


async def test_scheduler_catchup_after_downtime_collapses_to_latest(rig):
    from datetime import datetime
    from bridge.scheduler import Scheduler

    pump, poller, store = rig
    poller.app_cfg.guardrails.restrict_unattended_writes = False  # raw on/off for this test
    await poller.poll_once()
    assert poller.snapshot["on"] is True
    await store.add_schedule("p1", "06:00", "on")
    await store.add_schedule("p1", "09:00", "off")
    sched = Scheduler(store, {"p1": poller})

    # bridge was down all morning; first tick at 14:23 — net intended state is OFF,
    # and only ONE write fires (not an on-then-off burst through the rate limiter)
    await sched.check_once(datetime(2026, 7, 4, 14, 23))
    assert await pump.get_reg(R.REG_ON_OFF) == 0
    fired = [e for e in await store.get_events("p1", 1)
             if e["type"] == "power_write" and e["code"] == "accepted"]
    assert len(fired) == 1

    await sched.check_once(datetime(2026, 7, 4, 14, 24))  # both marked: no refire
    fired = [e for e in await store.get_events("p1", 1)
             if e["type"] == "power_write" and e["code"] == "accepted"]
    assert len(fired) == 1


async def test_analytics_exporter_pushes_snapshot(rig):
    # read-only mirror: the Pi POSTs a compact snapshot to a cloud endpoint. Verify the
    # payload shape + that it's best-effort (a dead endpoint never raises into the bridge).
    import json as _json
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from threading import Thread
    from bridge.config import AnalyticsConfig
    from bridge.exporter import Exporter

    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.append((self.headers.get("Authorization"), _json.loads(body)))
            self.send_response(200); self.end_headers()
        def log_message(self, *a): pass

    srv = HTTPServer(("127.0.0.1", 0), Handler)
    Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]

    pump, poller, store = rig
    await poller.poll_once()
    cfg = AnalyticsConfig(endpoint_url=f"http://127.0.0.1:{port}/api/ingest",
                          token="secret123", interval_s=999)
    exporter = Exporter(cfg, {"p1": poller})
    await exporter.push_once()

    assert len(received) == 1
    auth, payload = received[0]
    assert auth == "Bearer secret123"
    assert "ts" in payload and len(payload["pumps"]) == 1
    p = payload["pumps"][0]
    assert p["id"] == "p1" and "setpoint_c" in p and "outlet_c" in p and "power_w" in p
    # first push after boot carries the FULL snapshot (Advanced view + register baseline)
    assert "full" in p and "parameters" in p["full"] and "details" in p["full"]
    assert any(param["key"] == "max_water_temp" or param.get("label")
               for param in p["full"]["parameters"])

    # an immediate second push is inside FULL_SNAPSHOT_EVERY_S — compact only
    await exporter.push_once()
    assert len(received) == 2 and "full" not in received[1][1]["pumps"][0]

    srv.shutdown()
    # dead endpoint: must not raise
    cfg2 = AnalyticsConfig(endpoint_url="http://127.0.0.1:59997/x", token="t")
    await Exporter(cfg2, {"p1": poller}).push_once()   # no exception = pass


async def test_store_concurrent_reads_and_writes_dont_corrupt(rig):
    # regression: a single sqlite3 connection is not thread-safe for concurrent use — an
    # API read racing the poller's writes raised "bad parameter or other API misuse" 500s
    # on every dashboard refresh. All connection access must serialize on _conn_lock.
    pump, poller, store = rig
    await store.add_schedule("p1", "06:00", "on")

    async def writer():
        for _ in range(40):
            await store.add_event("p1", "state", code="x", message="churn")
            await store.add_sample("p1", {"inlet_c": 1, "outlet_c": 2, "ambient_c": 3,
                                          "setpoint_c": 40, "power_sys1": 0, "power_sys2": 0,
                                          "heating": 0, "status_word": 0})

    async def reader():
        for _ in range(40):
            await store.list_schedules("p1")
            await store.get_events("p1", 1)
            await store.get_history("p1", 24)

    await asyncio.gather(writer(), reader(), reader())  # no InterfaceError = pass
    assert len(await store.list_schedules("p1")) == 1


async def test_optimizer_lease_reverts_to_baseline_when_stale(rig):
    # fusion architecture audit: a remote setpoint is a renewable LEASE; if the optimizer
    # goes silent, the Pi reverts to a warm baseline on its own — never stranded.
    import time as time_mod
    pump, poller, store = rig
    g = poller.app_cfg.guardrails
    g.restrict_unattended_writes = True
    g.setback_setpoint_c = 40
    g.baseline_setpoint_c = 48       # warm default reverted to
    g.lease_warn_minutes = 15
    await poller.poll_once()

    # optimizer sets a low price-optimized setpoint with a 90-min lease
    await poller.write_setpoint(42, source="optimizer", unattended=True, lease_minutes=90)
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 42
    assert poller._lease is not None

    now = time_mod.time()
    await poller.check_lease(now)                    # fresh — nothing happens
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 42

    await poller.check_lease(now + 80 * 60)          # inside warn window (<15 min left)
    assert poller._lease["warned"] is True
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 42   # still held

    await asyncio.sleep(0.15)                         # let the per-pump rate-limit window pass
    await poller.check_lease(now + 91 * 60)          # lapsed -> revert to baseline
    assert poller._lease is None
    assert poller._reverted is True
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 48   # warm baseline, not stranded at 42

    # optimizer resumes -> new lease, recovery flag cleared
    await asyncio.sleep(0.15)
    await poller.write_setpoint(43, source="optimizer", unattended=True, lease_minutes=90)
    assert poller._reverted is False and poller._lease is not None


async def test_unattended_writes_respect_winter_floor(rig):
    # re-audit fix 2: "setpoint-only" is still heat-removing — an unattended actor must not
    # go below the winter-safe floor even within the clamp. Human writes still can.
    pump, poller, store = rig
    poller.app_cfg.guardrails.restrict_unattended_writes = True
    poller.app_cfg.guardrails.setback_setpoint_c = 40  # floor defaults to the setback
    await poller.poll_once()

    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(35, source="tempiq", unattended=True)  # below floor
    assert exc.value.status_code == 422 and "floor" in str(exc.value)

    # a human (attended) may go down to the clamp min (30)
    result = await poller.write_setpoint(35, source="ui", unattended=False)
    assert result["verified"] is True
    # and an unattended write at/above the floor is fine
    await asyncio.sleep(0.15)  # rate-limit lane
    ok = await poller.write_setpoint(42, source="tempiq", unattended=True)
    assert ok["verified"] is True


async def test_scheduler_off_becomes_setback_not_shutdown(rig):
    # fusion audit risk 2: the scheduler must never leave a pump powered off (a cold-latch
    # the HBX can't undo). Under restriction (default), "off" sets a setback setpoint.
    from datetime import datetime
    from bridge.scheduler import Scheduler

    pump, poller, store = rig
    poller.app_cfg.guardrails.restrict_unattended_writes = True
    poller.app_cfg.guardrails.setback_setpoint_c = 38
    await poller.poll_once()

    await store.add_schedule("p1", "23:00", "off")
    sched = Scheduler(store, {"p1": poller})
    await sched.check_once(datetime(2026, 7, 4, 23, 0, 5))

    assert await pump.get_reg(R.REG_ON_OFF) == 1                 # still ON (never shut off)
    assert await pump.get_reg(R.REG_SETPOINT_HEATING) == 38      # lowered to setback


async def test_scheduler_fires_once_per_day(rig):
    from datetime import datetime
    from bridge.scheduler import Scheduler

    pump, poller, store = rig
    poller.app_cfg.guardrails.restrict_unattended_writes = False  # raw on/off for this test
    await poller.poll_once()
    assert poller.snapshot["on"] is True

    await store.add_schedule("p1", "06:00", "off")
    sched = Scheduler(store, {"p1": poller})
    now = datetime(2026, 7, 4, 6, 0, 10)

    await sched.check_once(now)
    assert poller.snapshot["on"] is False           # fired through the guarded path
    await sched.check_once(now)                     # same minute: must not re-fire
    events = await store.get_events("p1", 1)
    fired = [e for e in events if e["type"] == "power_write" and e["code"] == "accepted"]
    assert len(fired) == 1
    assert fired[0]["detail"]["source"] == "schedule"

    await sched.check_once(datetime(2026, 7, 4, 7, 0))   # different minute: no match
    assert len([e for e in await store.get_events("p1", 1)
                if e["type"] == "power_write" and e["code"] == "accepted"]) == 1

    await store.delete_schedule("p1", (await store.list_schedules("p1"))[0]["id"])
    assert await store.list_schedules("p1") == []


async def test_runtime_edges_become_events(rig):
    pump, poller, store = rig
    await poller.poll_once()   # seeds the baseline — no events yet
    assert [e for e in await store.get_events("p1", 1) if e["type"] == "state"] == []

    # HBX drops the call: remote linkage contact (bit 6) opens
    sw = await pump.get_reg(R.REG_SWITCH_STATUS)
    await pump.set_reg(R.REG_SWITCH_STATUS, sw & ~(1 << 6))
    # and the backup electric heater kicks on
    st = await pump.get_reg(R.REG_STATUS)
    await pump.set_reg(R.REG_STATUS, st | (1 << 11))
    await poller.poll_once()
    await poller.poll_once()   # unchanged state: no duplicate events

    events = [e for e in await store.get_events("p1", 1) if e["type"] == "state"]
    codes = {e["code"] for e in events}
    assert codes == {"remote_contact_off", "elec_heat_on"}
    assert len(events) == 2
    remote = next(e for e in events if e["code"] == "remote_contact_off")
    assert "call ended" in remote["message"]

    # contact closes again -> one more event
    await pump.set_reg(R.REG_SWITCH_STATUS, sw | (1 << 6))
    await poller.poll_once()
    events = [e for e in await store.get_events("p1", 1) if e["type"] == "state"]
    assert len(events) == 3
    assert events[0]["code"] == "remote_contact_on"  # newest first


async def test_external_changes_become_events_but_own_writes_dont(rig):
    pump, poller, store = rig
    await poller.poll_once()   # seed baseline

    # installer changes a parameter at the wall controller
    await pump.set_reg(2010, 8)          # heating restart differential 5 -> 8
    await pump.set_reg(R.REG_SETPOINT_HEATING, 50)  # and bumps the setpoint
    await poller.poll_once()
    await poller.poll_once()   # steady state: no duplicates

    changes = [e for e in await store.get_events("p1", 1)
               if e["type"] == "state" and e["code"].startswith("changed_")]
    assert {e["code"] for e in changes} == {"changed_heating_start_diff",
                                            "changed_setpoint_heating_c"}
    assert len(changes) == 2
    assert "changed at the unit" in changes[0]["message"]

    # our own write must NOT produce a changed_* event
    await poller.write_setpoint(52, source="test")
    await poller.poll_once()
    changes = [e for e in await store.get_events("p1", 1)
               if e["type"] == "state" and e["code"] == "changed_setpoint_heating_c"]
    assert len(changes) == 1  # still just the external one


async def test_w610_identity_check_blocks_writes_on_mac_mismatch(rig):
    from bridge.poller import normalize_mac

    assert normalize_mac("D8:B0:4C:1:2:3") == normalize_mac("d8:b0:4c:01:02:03")

    pump, poller, store = rig
    poller.cfg.mac = "D8:B0:4C:12:34:56"
    arp = {"mac": "d8:b0:4c:12:34:56"}

    async def fake_resolver(host):
        return arp["mac"]
    poller._mac_resolver = fake_resolver

    await poller.poll_once()
    assert poller.identity_ok is True
    assert poller.snapshot["identity_ok"] is True

    arp["mac"] = "aa:bb:cc:dd:ee:ff"     # DHCP reshuffle: another device answers
    await poller.poll_once()
    await poller.poll_once()             # no duplicate events
    assert poller.identity_ok is False
    with pytest.raises(GuardrailError) as exc:
        await poller.write_setpoint(45, source="test")
    assert exc.value.status_code == 409
    with pytest.raises(GuardrailError) as exc:
        await poller.write_power(False, source="test")
    assert exc.value.status_code == 409

    events = [e for e in await store.get_events("p1", 1)
              if e["code"] == "identity_mismatch"]
    assert len(events) == 1
    assert events[0]["severity"] == "critical"

    arp["mac"] = "D8:B0:4C:12:34:56"     # reservation fixed
    await poller.poll_once()
    assert poller.identity_ok is True
    await poller.write_setpoint(45, source="test")  # writes work again

    # unresolvable ARP (None) must never flip the verdict
    async def unresolvable(host):
        return None
    poller._mac_resolver = unresolvable
    await poller.poll_once()
    assert poller.identity_ok is True


async def test_apply_gateway_hot_swaps_the_connection(rig, tmp_path):
    pump, poller, store = rig
    await poller.poll_once()

    # a second fake pump = the "real" gateway after a DHCP reshuffle
    pump2 = FakePump(2, free_port())
    await pump2.start()
    await pump2.tick()
    await pump2.set_reg(R.REG_SETPOINT_HEATING, 52)  # distinguishable from pump 1's 45

    persisted = {}
    async def on_change(pump_id, host, port):
        persisted[pump_id] = (host, port)
    poller.on_gateway_change = on_change

    await poller.apply_gateway("127.0.0.1", pump2.port, source="test")
    await poller.poll_once()
    assert poller.snapshot["setpoint_c"] == 52          # now reading the other unit
    assert persisted == {"p1": ("127.0.0.1", pump2.port)}
    events = await store.get_events("p1", 1)
    assert any(e["code"] == "gateway_change" for e in events)
    await pump2.server.shutdown()


async def test_auto_rediscovery_follows_the_mac(rig):
    pump, poller, store = rig
    poller.cfg.mac = "d8:b0:4c:12:34:56"
    await poller.poll_once()

    pump2 = FakePump(2, free_port())
    await pump2.start()
    await pump2.tick()

    async def fake_discover(extra_ports=None, probe=True, skip_probe=None):
        # rediscovery must exclude every configured gateway from the TCP sweep — with
        # max-clients=1 a bare connect can kick the healthy pump's live connection
        assert skip_probe and (poller.cfg.host, poller.cfg.port) in skip_probe
        return [{"ip": "127.0.0.1", "port": pump2.port, "mac": "D8:B0:4C:12:34:56",
                 "source": "test"}]
    poller._discoverer = fake_discover

    await pump.server.shutdown()               # original gateway vanishes
    # The poller's client holds an established connection and shutdown() only closes the
    # listener — on a slow runner (CI) the old socket can serve one extra poll before it
    # drops. Poll until the offline threshold trips and rediscovery lands (bounded, not
    # a fixed count), then assert the switch actually happened.
    for _ in range(8):
        await poller.poll_once()
        if poller.cfg.port == pump2.port:
            break
    await poller.poll_once()                   # next poll uses the new address
    assert poller.cfg.port == pump2.port
    assert poller.online
    events = await store.get_events("p1", 1)
    change = next(e for e in events if e["code"] == "gateway_change")
    assert "auto-rediscovery" in change["message"]
    await pump2.server.shutdown()


async def test_discover_canonicalizes_mac_on_arp_not_broadcast(monkeypatch):
    """Real W610s report their BASE MAC on the USR broadcast/label but use base+1 on the
    WiFi station interface — what ARP sees, and what the poller adopts (set_gateway) and
    verifies every poll (_check_identity). discover() must return the ARP MAC as the
    canonical `mac`, or rediscovery + identity (which key off it) never match the adopted
    MAC. Regression for the 2026-07-12 bench finding."""
    import bridge.discovery as disc

    async def fake_udp():
        return {"192.168.1.61": "d4:ad:20:e3:67:e4",   # broadcast: base MAC
                "192.168.1.62": "d4:ad:20:e3:67:f0"}   # broadcast-only, ARP unresolvable

    async def fake_scan(hosts, ports, **kw):
        return [("192.168.1.61", 8899)]

    async def fake_arp(host):
        return "d4:ad:20:e3:67:e5" if host == "192.168.1.61" else None  # station = base+1

    async def fake_probe(host, port, **kw):
        return {"inlet_c": 38, "outlet_c": 43, "ambient_c": 11}

    monkeypatch.setattr(disc, "usr_udp_discover", fake_udp)
    monkeypatch.setattr(disc, "tcp_scan", fake_scan)
    monkeypatch.setattr(disc, "get_mac_for_ip", fake_arp)
    monkeypatch.setattr(disc, "probe_heatpump", fake_probe)
    monkeypatch.setattr(disc, "local_subnet_hosts", lambda: ["192.168.1.61", "192.168.1.62"])

    by_ip = {c["ip"]: c for c in await disc.discover()}

    # ARP resolved: canonical MAC is the station MAC (matches what set_gateway adopts),
    # and the broadcast/base MAC is kept for visibility.
    assert by_ip["192.168.1.61"]["mac"] == "d4:ad:20:e3:67:e5"
    assert by_ip["192.168.1.61"]["broadcast_mac"] == "d4:ad:20:e3:67:e4"
    # ARP unresolvable: fall back to the broadcast MAC (nothing better available).
    assert by_ip["192.168.1.62"]["mac"] == "d4:ad:20:e3:67:f0"
    assert "broadcast_mac" not in by_ip["192.168.1.62"]


async def test_gateway_overrides_persist_and_respect_mac(tmp_path):
    from bridge.config import AppConfig, apply_gateway_overrides, save_gateway_override

    def make_cfg(mac):
        return AppConfig(
            pumps=[PumpConfig(id="p1", name="P1", host="10.0.0.5", mac=mac)],
            db_path=str(tmp_path / "bridge.db"))

    cfg = make_cfg("d8:b0:4c:12:34:56")
    save_gateway_override(cfg, "p1", "10.0.0.99", 8899)

    fresh = make_cfg("d8:b0:4c:12:34:56")
    apply_gateway_overrides(fresh)
    assert fresh.pumps[0].host == "10.0.0.99"   # override applied, same physical unit

    replaced = make_cfg("aa:aa:aa:aa:aa:aa")    # config now names a different unit
    apply_gateway_overrides(replaced)
    assert replaced.pumps[0].host == "10.0.0.5"  # stale override ignored

    # MAC adopted at assignment time survives restarts even if config has none
    no_mac = make_cfg(None)
    apply_gateway_overrides(no_mac)
    assert no_mac.pumps[0].host == "10.0.0.99"
    assert no_mac.pumps[0].mac == "d8:b0:4c:12:34:56"


async def test_add_and_remove_pump_at_runtime(rig):
    from types import SimpleNamespace
    from bridge import api as api_mod
    from bridge.config import apply_gateway_overrides

    from bridge.auth import Principal

    pump, poller, store = rig
    pump3 = FakePump(3, free_port())
    await pump3.start()
    await pump3.tick()

    async def persist(pid, h, p):
        pass
    ns = SimpleNamespace(pollers={"p1": poller}, config=poller.app_cfg, store=store,
                         guard=poller.guard, persist_gateway=persist)
    request = SimpleNamespace(app=SimpleNamespace(state=ns))
    principal = Principal(source="test", can_write=True, authenticated=True)

    result = await api_mod.add_pump(request, api_mod.AddPumpRequest(
        name="Heat Pump 3", host="127.0.0.1", port=pump3.port), principal=principal)
    new_id = result["id"]
    assert new_id in ns.pollers
    new_poller = ns.pollers[new_id]
    assert new_poller.cfg.write_enabled is False   # Phase 1 rule applies to added pumps
    await new_poller.poll_once()
    assert new_poller.online

    # persisted: a fresh config load includes the added pump
    fresh = AppConfig(pumps=[PumpConfig(id="p1", name="P1", host="127.0.0.1")],
                      db_path=poller.app_cfg.db_path)
    apply_gateway_overrides(fresh)
    assert any(p.id == new_id and p.added for p in fresh.pumps)

    # config-defined pumps cannot be removed via the API
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        await api_mod.remove_pump(request, "p1", principal=principal)

    # a timer on the doomed pump must die with it — ids are recycled, and an
    # orphaned schedule would silently attach to a future pump
    await store.add_schedule(new_id, "22:00", "off")
    await api_mod.remove_pump(request, new_id, principal=principal)
    assert new_id not in ns.pollers
    assert await store.list_schedules(new_id) == []
    fresh2 = AppConfig(pumps=[PumpConfig(id="p1", name="P1", host="127.0.0.1")],
                       db_path=poller.app_cfg.db_path)
    apply_gateway_overrides(fresh2)
    assert not any(p.id == new_id for p in fresh2.pumps)
    await pump3.server.shutdown()


async def test_nightly_maintenance_backup_and_retention(rig, tmp_path):
    import time as time_mod
    from datetime import datetime
    from pathlib import Path
    from bridge.scheduler import Scheduler

    pump, poller, store = rig
    await poller.poll_once()  # at least one sample row exists

    # plant an ancient sample that retention must remove
    await store._exec(
        "INSERT INTO samples (pump_id, ts, inlet_c, outlet_c, ambient_c, setpoint_c,"
        " power_sys1, power_sys2, heating, status_word) VALUES (?,?,0,0,0,0,0,0,0,0)",
        ("p1", time_mod.time() - 400 * 86400))

    sched = Scheduler(store, {"p1": poller})
    await sched.run_maintenance(datetime(2026, 7, 5, 3, 30))

    backups = Path(store.path).parent / "backups"
    assert (backups / "bridge-20260705.db").exists()
    old = await store._query(
        "SELECT COUNT(*) AS n FROM samples WHERE ts < ?",
        (time_mod.time() - 365 * 86400,))
    assert old[0]["n"] == 0          # ancient sample pruned
    recent = await store._query("SELECT COUNT(*) AS n FROM samples", ())
    assert recent[0]["n"] >= 1       # today's data intact

    # rotation: fabricate old backups beyond the keep window
    for i in range(10):
        (backups / f"bridge-2025010{i}.db").touch()
    await sched.run_maintenance(datetime(2026, 7, 6, 3, 30))
    assert len(list(backups.glob("bridge-*.db"))) == 7


async def test_open_faults_survive_restart(rig):
    pump, poller, store = rig
    await pump.inject_fault("E18", on=True)
    await poller.poll_once()
    since = poller.snapshot["active_faults"][0]["since"]

    # simulate bridge restart: fresh poller, same store
    guard = SetpointGuard(poller.app_cfg.guardrails)
    poller2 = PumpPoller(poller.cfg, poller.app_cfg, store, guard)
    await poller2.start()
    try:
        await asyncio.sleep(0)  # let start() finish; active_faults loaded before task runs
        assert list(poller2.active_faults.values())[0]["since"] == pytest.approx(since)
        await poller2.poll_once()
        events = await store.get_events("p1", 1)
        fault_ons = [e for e in events if e["type"] == "fault_on"]
        assert len(fault_ons) == 1  # NOT re-logged after restart
    finally:
        await poller2.stop()
