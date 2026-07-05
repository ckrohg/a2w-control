# @purpose: Per-pump polling loop: batched reads -> snapshot cache + SQLite samples +
# fault edge detection (alert once on onset, once on clear — never every poll). Also owns
# the guarded setpoint write path. API handlers only ever touch the in-memory snapshot;
# they never trigger synchronous Modbus traffic.
from __future__ import annotations

import asyncio
import contextlib
import logging
import time

from . import registers as R
from .config import AppConfig, PumpConfig
from .faults import FAULTS, FaultDef, decode_faults, worst_severity, Severity
from .guardrails import GuardrailError, SetpointGuard
from .modbus_client import ModbusError, PumpClient
from .store import Store

log = logging.getLogger(__name__)

COMM_SNAPSHOT_INTERVAL_S = 900  # heartbeat row; errors also force a row

# Runtime edges worth a discrete event (group, key, code, on-message, off-message).
# The remote/linkage contact is how the HBX calls for heat — bit mapping to CN33 is a
# Phase 1 verification item, hence the hedged wording.
STATE_WATCHES = (
    ("switches", "emergency_switch", "remote_contact",
     "Remote linkage contact closed — external call active (HBX?)",
     "Remote linkage contact opened — external call ended"),
    ("switches", "ac_online", "ac_linkage",
     "AC linkage switch closed", "AC linkage switch opened"),
    ("switches", "water_flow_switch", "flow",
     "Water flow switch closed — flow OK", "Water flow switch open — no flow"),
    ("status", "compressor1", "comp1",
     "Stage 1 compressor started", "Stage 1 compressor stopped"),
    ("status", "compressor2", "comp2",
     "Stage 2 compressor started", "Stage 2 compressor stopped"),
    ("status", "electric_heating", "elec_heat",
     "Backup electric heater ON", "Backup electric heater off"),
    ("", "defrosting", "defrost",
     "Defrost cycle started", "Defrost cycle ended"),
)


from .discovery import discover, get_mac_for_ip, normalize_mac  # noqa: F401 (re-export)

REDISCOVER_MIN_INTERVAL_S = 300  # at most one MAC-following network sweep per 5 min


class PumpPoller:
    def __init__(self, cfg: PumpConfig, app_cfg: AppConfig, store: Store, guard: SetpointGuard):
        self.cfg = cfg
        self.app_cfg = app_cfg
        self.store = store
        self.guard = guard
        self.client = PumpClient(cfg.host, cfg.port, cfg.device_id, app_cfg.modbus_timeout_s)
        self.active_faults: dict[str, dict] = {}  # key -> {code,message,severity,since}
        self._prev_flags: dict[str, bool] | None = None  # runtime edge detection state
        self._prev_config: dict[str, int] | None = None  # external-change detection state
        self.identity_ok: bool = True   # MAC-vs-IP verification (see _check_identity)
        self._mac_resolver = get_mac_for_ip  # injectable for tests
        self._discoverer = discover          # injectable for tests
        self._last_rediscover = 0.0
        self.on_gateway_change = None   # optional async callback(pump_id, host, port)
        self.snapshot: dict = {"id": cfg.id, "name": cfg.name, "online": False,
                               "write_enabled": cfg.write_enabled}
        self._task: asyncio.Task | None = None
        self._last_comm_row = 0.0
        self._last_error_polls = 0

    @property
    def online(self) -> bool:
        return bool(self.snapshot.get("online"))

    async def start(self) -> None:
        open_faults = await self.store.get_open_faults(self.cfg.id)
        for key, since in open_faults.items():
            reg, _, bit = key.partition(".")
            fdef = FAULTS.get((int(reg), int(bit)))
            if fdef:
                self.active_faults[key] = self._fault_entry(key, fdef, since)
        self._task = asyncio.create_task(self._run(), name=f"poller-{self.cfg.id}")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        self.client.close()

    async def _run(self) -> None:
        while True:
            started = time.monotonic()
            try:
                await self.poll_once()
            except Exception:
                log.exception("[%s] unexpected poller error", self.cfg.id)
            elapsed = time.monotonic() - started
            await asyncio.sleep(max(1.0, self.cfg.poll_interval_s - elapsed))

    async def poll_once(self) -> None:
        """One full poll: three batched reads, decode, edge-detect, persist."""
        try:
            regs: dict[int, int] = {}
            for block in R.ALL_BLOCKS:
                regs.update(await self.client.read_block(block))
        except ModbusError as exc:
            self.client.record_poll(ok=False)
            await self._handle_poll_failure(exc)
            return

        self.client.record_poll(ok=True)
        await self._check_identity()
        decoded = R.decode_snapshot(regs)
        was_online = self.snapshot.get("online", False)
        await self._update_faults(decode_faults(regs))
        await self._emit_state_events(decoded)
        await self._emit_config_change_events(decoded)

        self.snapshot = {
            "id": self.cfg.id,
            "name": self.cfg.name,
            "online": True,
            "last_poll_ts": time.time(),
            "write_enabled": self.cfg.write_enabled,
            **decoded,
            "status_word": regs.get(R.REG_STATUS, 0),
            "state": self._derive_state(decoded),
            "setpoint_bounds_c": self._setpoint_bounds(decoded["mode_kind"],
                                                       decoded["max_water_temp_c"]),
            "active_faults": list(self.active_faults.values()),
            "identity_ok": self.identity_ok,
            "comm": self.client.stats.as_dict(),
        }
        if not was_online and self.client.stats.ok_polls > 1:
            await self.store.add_event(self.cfg.id, "comm", code="online",
                                       message=f"{self.cfg.name} back online")
        await self.store.add_sample(self.cfg.id, decoded | {"status_word": regs.get(R.REG_STATUS, 0)})
        await self._maybe_comm_row()

    def _derive_state(self, decoded: dict) -> str:
        non_info = {k: v for k, v in self.active_faults.items() if v["severity"] != Severity.INFO}
        if non_info:
            return "fault"
        if not decoded["on"]:
            return "off"
        if decoded.get("defrosting"):
            return "defrost"
        if decoded["running"]:
            return "cooling" if decoded["mode_kind"] == "cooling" else "heating"
        return "idle"

    def _setpoint_bounds(self, mode_kind: str, unit_max_c: float | None) -> list[float] | None:
        """Effective clamp for the active mode. Heating folds in the unit's own
        reg 2027 limit; unsupported modes return None (writes refused)."""
        g = self.app_cfg.guardrails
        if mode_kind == "heating":
            max_c = min(g.setpoint_max_c, R.HARD_MAX_SETPOINT_C)
            if unit_max_c is not None and 20 <= unit_max_c <= 90:
                max_c = min(max_c, unit_max_c)
            return [g.setpoint_min_c, max_c]
        if mode_kind == "cooling":
            return [g.cooling_setpoint_min_c, g.cooling_setpoint_max_c]
        return None

    async def apply_gateway(self, host: str, port: int, *, source: str) -> None:
        """Point this pump at a (new) gateway address: swap the Modbus client live,
        reset identity state, audit, and notify the persistence callback."""
        old = f"{self.cfg.host}:{self.cfg.port}"
        self.client.close()
        self.cfg.host, self.cfg.port = host, port
        self.client = PumpClient(host, port, self.cfg.device_id,
                                 self.app_cfg.modbus_timeout_s)
        self.identity_ok = True
        await self.store.add_event(
            self.cfg.id, "comm", code="gateway_change", severity="info",
            message=f"gateway address updated {old} -> {host}:{port} ({source})")
        if self.on_gateway_change:
            await self.on_gateway_change(self.cfg.id, host, port)

    async def _try_rediscover(self) -> None:
        """Offline and we know the physical unit's MAC — sweep the LAN and follow it.
        Makes DHCP reshuffles self-healing instead of an outage."""
        if not self.cfg.mac:
            return
        now = time.monotonic()
        if now - self._last_rediscover < REDISCOVER_MIN_INTERVAL_S:
            return
        self._last_rediscover = now
        want = normalize_mac(self.cfg.mac)
        try:
            candidates = await self._discoverer(extra_ports={self.cfg.port}, probe=False)
        except Exception:
            log.exception("[%s] rediscovery sweep failed", self.cfg.id)
            return
        match = next((c for c in candidates
                      if c.get("mac") and normalize_mac(c["mac"]) == want), None)
        if match and (match["ip"] != self.cfg.host or match.get("port", self.cfg.port) != self.cfg.port):
            log.info("[%s] found configured MAC at new address %s", self.cfg.id, match["ip"])
            await self.apply_gateway(match["ip"], match.get("port", self.cfg.port),
                                     source="auto-rediscovery followed the MAC")

    async def _handle_poll_failure(self, exc: ModbusError) -> None:
        threshold = self.app_cfg.guardrails.offline_after_failed_polls
        failures = self.client.stats.consecutive_failures
        log.warning("[%s] poll failed (%s, %d consecutive): %s",
                    self.cfg.id, exc.category, failures, exc)
        if failures >= threshold:
            await self._try_rediscover()
        if failures == threshold and self.snapshot.get("online"):
            self.snapshot = {**self.snapshot, "online": False, "state": "offline",
                             "comm": self.client.stats.as_dict()}
            await self.store.add_event(
                self.cfg.id, "comm", code="offline", severity="high",
                message=f"{self.cfg.name} unreachable for {failures} consecutive polls",
                detail={"category": exc.category})
        else:
            self.snapshot = {**self.snapshot, "comm": self.client.stats.as_dict()}
            if failures >= threshold:
                self.snapshot["online"] = False
                self.snapshot["state"] = "offline"
        await self._maybe_comm_row(force=True)

    async def _check_identity(self) -> None:
        """Verify the IP still belongs to the configured physical W610 (by MAC).
        Guards against DHCP reshuffles / swapped units silently flip-flopping which
        heat pump we're reading — and worse, writing."""
        if not self.cfg.mac:
            return
        actual = await self._mac_resolver(self.cfg.host)
        if actual is None:
            return  # can't verify right now — keep last verdict, never false-alarm
        ok = normalize_mac(actual) == normalize_mac(self.cfg.mac)
        if ok == self.identity_ok:
            return
        self.identity_ok = ok
        if not ok:
            await self.store.add_event(
                self.cfg.id, "comm", code="identity_mismatch", severity="critical",
                message=f"W610 identity check FAILED: {self.cfg.host} answers with MAC "
                        f"{actual}, expected {self.cfg.mac} — this may be the OTHER "
                        f"pump's gateway. All writes blocked. Check DHCP reservations.")
            log.error("[%s] identity mismatch at %s: %s != %s",
                      self.cfg.id, self.cfg.host, actual, self.cfg.mac)
        else:
            await self.store.add_event(
                self.cfg.id, "comm", code="identity_ok", severity="info",
                message="W610 identity verified again — writes re-enabled")

    def _require_identity(self) -> None:
        if not self.identity_ok:
            raise GuardrailError(
                "identity check failed — the device at this IP is not the configured "
                "W610 (MAC mismatch); refusing to write to what may be the wrong pump", 409)

    @staticmethod
    def _config_values(decoded: dict) -> dict[str, tuple[str, int | float]]:
        """The unit's settings as {key: (label, value)} — anything here that changes
        without the bridge writing it was changed at the wall controller (or by
        another master) and deserves an audit event."""
        mode_label = R.MODE_NAMES.get(decoded.get("mode"), str(decoded.get("mode")))
        out = {
            "on": ("Unit power", int(decoded.get("on", 0))),
            "mode": (f"Mode ({mode_label})", decoded.get("mode", 1)),
            "setpoint_heating_c": ("Heating setpoint °C", decoded.get("setpoint_heating_c")),
            "setpoint_cooling_c": ("Cooling setpoint °C", decoded.get("setpoint_cooling_c")),
            "setpoint_hot_water_c": ("Hot water setpoint °C", decoded.get("setpoint_hot_water_c")),
        }
        for p in decoded.get("parameters", []):
            out[p["key"]] = (p["label"], p["value"])
        return out

    def note_local_change(self, key: str, value: int | float) -> None:
        """Called by our own write paths so the next poll doesn't misreport a change
        we made ourselves as an external one."""
        if self._prev_config is not None:
            self._prev_config[key] = value

    async def _emit_config_change_events(self, decoded: dict) -> None:
        current = self._config_values(decoded)
        if self._prev_config is not None:
            for key, (label, value) in current.items():
                prev = self._prev_config.get(key)
                if prev is not None and prev != value:
                    await self.store.add_event(
                        self.cfg.id, "state", code=f"changed_{key}", severity="info",
                        message=f"{label} changed {prev} → {value} "
                                f"(changed at the unit, not via the bridge)")
                    log.info("[%s] external change: %s %s -> %s",
                             self.cfg.id, key, prev, value)
        self._prev_config = {k: v for k, (_, v) in current.items()}

    async def _emit_state_events(self, decoded: dict) -> None:
        """Log runtime transitions (heat calls, compressor start/stop, electric heat,
        defrost, flow) as discrete events. First successful poll only seeds the baseline —
        no event spam at startup."""
        flags = {}
        for group, key, code, _, _ in STATE_WATCHES:
            source = decoded.get(group, {}) if group else decoded
            flags[code] = bool(source.get(key))
        if self._prev_flags is not None:
            for group, key, code, on_msg, off_msg in STATE_WATCHES:
                if flags[code] != self._prev_flags[code]:
                    await self.store.add_event(
                        self.cfg.id, "state",
                        code=f"{code}_{'on' if flags[code] else 'off'}",
                        severity="info",
                        message=on_msg if flags[code] else off_msg)
        self._prev_flags = flags

    @staticmethod
    def _fault_entry(key: str, fdef: FaultDef, since: float) -> dict:
        return {"key": key, "code": fdef.code, "message": fdef.message,
                "severity": fdef.severity, "since": since}

    async def _update_faults(self, current: dict[str, FaultDef]) -> None:
        """Edge detection: log fault_on for new bits, fault_off for cleared bits."""
        for key, fdef in current.items():
            if key not in self.active_faults:
                self.active_faults[key] = self._fault_entry(key, fdef, time.time())
                await self.store.add_event(
                    self.cfg.id, "fault_on", code=fdef.code, severity=fdef.severity,
                    message=fdef.message, detail={"key": key})
                log.info("[%s] fault ON %s %s", self.cfg.id, fdef.code, fdef.message)
        for key in list(self.active_faults):
            if key not in current:
                gone = self.active_faults.pop(key)
                await self.store.add_event(
                    self.cfg.id, "fault_off", code=gone["code"], severity=gone["severity"],
                    message=f"Cleared: {gone['message']}",
                    detail={"key": key, "active_s": round(time.time() - gone["since"])})
                log.info("[%s] fault OFF %s", self.cfg.id, gone["code"])

    async def _maybe_comm_row(self, force: bool = False) -> None:
        now = time.monotonic()
        errored = self.client.stats.error_polls != self._last_error_polls
        if force or errored or now - self._last_comm_row > COMM_SNAPSHOT_INTERVAL_S:
            await self.store.add_comm_snapshot(self.cfg.id, self.client.stats.as_dict())
            self._last_comm_row = now
            self._last_error_polls = self.client.stats.error_polls

    # --- guarded write path ---------------------------------------------------
    async def write_setpoint(self, value: float, source: str) -> dict:
        """Mode-aware guarded write: re-read the mode and unit-max registers FRESH
        (never trust a stale snapshot to pick the target register), clamp to the
        mode's effective bounds, rate limit, write, read-back verify, audit."""
        old = self.snapshot.get("setpoint_c")

        async def audit_reject(exc: GuardrailError | ModbusError, code: str, sev: str):
            await self.store.add_event(
                self.cfg.id, "setpoint_write", code=code, severity=sev,
                message=str(exc), detail={"old": old, "requested": value, "source": source})

        # cheap pre-checks before touching the bus
        try:
            self._require_identity()
            self.guard.validate(self.cfg.id, value, online=self.online,
                                write_enabled=self.cfg.write_enabled,
                                min_c=float("-inf"), max_c=float("inf"))
        except GuardrailError as exc:
            await audit_reject(exc, "rejected", "warning")
            raise

        try:
            control = await self.client.read_block(R.BLOCK_CONTROL)
        except ModbusError as exc:
            await audit_reject(exc, "failed", "high")
            raise GuardrailError(f"cannot confirm pump mode before writing: {exc}", 502) from exc

        mode = control.get(R.REG_MODE, 1)
        kind = R.MODE_KIND.get(mode, "unknown")
        unit_max = R.to_signed(control.get(R.REG_MAX_WATER_TEMP, 0)) * R.TEMP_SCALE
        bounds = self._setpoint_bounds(kind, unit_max)
        if bounds is None:
            exc = GuardrailError(
                f"unit is in {R.MODE_NAMES.get(mode, mode)} mode — remote setpoint is only "
                f"supported for heating and cooling; use the wall controller", 409)
            await audit_reject(exc, "rejected", "warning")
            raise exc
        target_register = R.SETPOINT_REGISTER_FOR_KIND[kind]

        try:
            context = f"{kind} mode" + (f", unit max {unit_max:g}°C" if kind == "heating" else "")
            self.guard.validate(self.cfg.id, value, online=self.online,
                                write_enabled=self.cfg.write_enabled,
                                min_c=bounds[0], max_c=bounds[1], context=context)
        except GuardrailError as exc:
            await audit_reject(exc, "rejected", "warning")
            raise

        raw = int(round(value / R.TEMP_SCALE))
        try:
            readback_raw = await self.client.write_register_verified(target_register, raw)
        except ModbusError as exc:
            await audit_reject(exc, "failed", "high")
            raise GuardrailError(f"write failed: {exc}", 502) from exc

        self.guard.record_write(self.cfg.id)
        readback = R.to_signed(readback_raw) * R.TEMP_SCALE
        verified = readback == value
        await self.store.add_event(
            self.cfg.id, "setpoint_write",
            code="accepted" if verified else "verify_mismatch",
            severity="info" if verified else "high",
            message=(f"{kind} setpoint {old} -> {value}°C ({source})" if verified else
                     f"read-back mismatch: wrote {value}, unit reports {readback}"),
            detail={"old": old, "requested": value, "readback": readback,
                    "source": source, "mode": kind, "register": target_register})
        if not verified:
            raise GuardrailError(
                f"read-back mismatch: wrote {value}°C but unit reports {readback}°C", 502)
        self.snapshot["setpoint_c"] = readback
        self.note_local_change(f"setpoint_{kind}_c", readback)
        return {"setpoint_c": readback, "verified": True, "mode": kind}

    async def _guarded_control_write(self, register: int, raw: int, *, event_type: str,
                                     describe: str, source: str) -> None:
        """Shared machinery for mode/power writes: same discipline as setpoints —
        precondition checks, per-control rate limit, read-back verify, audit — then an
        immediate re-poll so the snapshot reflects the new reality right away."""
        rate_key = f"{self.cfg.id}:{event_type}"  # own limiter; doesn't block setpoints

        async def audit(code: str, sev: str, message: str):
            await self.store.add_event(
                self.cfg.id, event_type, code=code, severity=sev, message=message,
                detail={"register": register, "requested": raw, "source": source})

        try:
            self._require_identity()
            self.guard.validate(rate_key, raw, online=self.online,
                                write_enabled=self.cfg.write_enabled,
                                min_c=float("-inf"), max_c=float("inf"))
        except GuardrailError as exc:
            await audit("rejected", "warning", str(exc))
            raise
        try:
            readback = await self.client.write_register_verified(register, raw)
        except ModbusError as exc:
            await audit("failed", "high", f"write failed: {exc}")
            raise GuardrailError(f"write failed: {exc}", 502) from exc
        self.guard.record_write(rate_key)
        if readback != raw:
            await audit("verify_mismatch", "high",
                        f"read-back mismatch on reg {register}: wrote {raw}, got {readback}")
            raise GuardrailError(
                f"read-back mismatch: unit did not accept the change", 502)
        await audit("accepted", "info", f"{describe} ({source})")
        await self.poll_once()

    async def write_mode(self, kind: str, source: str) -> dict:
        """Switch heating <-> cooling (reg 2001). Only 0/1 ever written — the protocol
        doc marks modes 2-5 unstable. UI puts a confirmation step in front of this."""
        target = {"heating": 1, "cooling": 0}[kind]
        current = self.snapshot.get("mode_kind", "?")
        self.note_local_change("mode", target)
        await self._guarded_control_write(
            R.REG_MODE, target, event_type="mode_write",
            describe=f"mode {current} -> {kind}", source=source)
        return {"mode": kind, "verified": True}

    async def write_power(self, on: bool, source: str) -> dict:
        """Unit on/off (reg 2000) — same as the wall controller's power button."""
        self.note_local_change("on", 1 if on else 0)
        await self._guarded_control_write(
            R.REG_ON_OFF, 1 if on else 0, event_type="power_write",
            describe=f"unit switched {'on' if on else 'off'}", source=source)
        return {"on": on, "verified": True}

    async def write_parameter(self, key: str, value: int, source: str) -> dict:
        """Installer parameter write (2005/2010-2039), clamped to the protocol doc's own
        range for that parameter. The manual (§2.8) warns against casual changes — the
        UI puts an explicit warning + confirmation in front of this."""
        if key not in R.PARAM_BY_KEY:
            raise GuardrailError(f"unknown parameter: {key}", 404)
        addr, label, lo, hi = R.PARAM_BY_KEY[key]
        if not float(value).is_integer() or not (lo <= value <= hi):
            raise GuardrailError(
                f"{label}: value {value} outside documented range {lo}–{hi}", 422)
        raw = int(value) & 0xFFFF  # negatives to two's complement
        old = next((p["value"] for p in self.snapshot.get("parameters", [])
                    if p["key"] == key), None)
        self.note_local_change(key, int(value))
        await self._guarded_control_write(
            addr, raw, event_type="param_write",
            describe=f"{label}: {old} -> {value}", source=source)
        return {"key": key, "value": value, "verified": True}
