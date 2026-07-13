# @purpose: Per-pump polling loop: batched reads -> snapshot cache + SQLite samples +
# fault edge detection (alert once on onset, once on clear — never every poll). Also owns
# the guarded setpoint write path. API handlers only ever touch the in-memory snapshot;
# they never trigger synchronous Modbus traffic.
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque

from . import notify
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
        # remote-optimizer lease (in-memory, so a restart safely discards a stale override
        # rather than trusting a persisted lease against an unsynced clock)
        self._lease: dict | None = None   # {until, source, warned}
        self._reverted = False            # for the recovery alert
        self.identity_ok: bool = True   # MAC-vs-IP verification (see _check_identity)
        self._mac_resolver = get_mac_for_ip  # injectable for tests
        self._discoverer = discover          # injectable for tests
        self._last_rediscover = 0.0
        self.on_gateway_change = None   # optional async callback(pump_id, host, port)
        # _write_lock makes guardrail check-then-act atomic under concurrent requests
        # (rate limit was bypassable by requests arriving during a slow 2400-baud write);
        # _poll_lock stops interleaved polls double-emitting edge events / mixing reads
        # from two gateways when apply_gateway swaps the client mid-poll.
        self._write_lock = asyncio.Lock()
        self._poll_lock = asyncio.Lock()
        self.snapshot: dict = {"id": cfg.id, "name": cfg.name, "online": False,
                               "write_enabled": cfg.write_enabled}
        self._task: asyncio.Task | None = None
        self._last_comm_row = 0.0
        self._last_error_polls = 0
        # Offline alerting is edge-tracked explicitly, NOT inferred from the previous
        # snapshot: a pump that has NEVER been online (fresh boot into a dead gateway —
        # exactly the first-bench-day case) must still alert, and must alert only once.
        self._offline_alerted = False
        # rolling window of recent poll outcomes ("ok" | connect | timeout | io | exception
        # | decode) so the gateway-vs-pump diagnosis is stable on a FLAPPING link — a single
        # most-recent failure is noise when a gateway drops on/off WiFi (see _link_status).
        self._recent_outcomes: deque[str] = deque(maxlen=6)

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
        """One full poll: three batched reads, decode, edge-detect, persist.
        Serialized by _poll_lock; all reads go through one client reference so a
        concurrent apply_gateway can't produce a snapshot mixing two pumps."""
        async with self._poll_lock:
            client = self.client
            try:
                regs: dict[int, int] = {}
                for block in R.all_blocks():   # live: honors the SPLIT_RESERVED_HOLE fallback
                    regs.update(await client.read_block(block))
            except ModbusError as exc:
                client.record_poll(ok=False)
                self._recent_outcomes.append(exc.category)
                await self._handle_poll_failure(exc)
                return
            try:
                await self._poll_decode_and_store(client, regs)
                self._recent_outcomes.append("ok")
            except Exception as exc:  # noqa: BLE001 — a decode/store bug must never leave a
                # stale "online" zombie: count it as a FAILED poll so the offline watchdog,
                # the health endpoint, and the dead-man all see the truth.
                log.exception("[%s] decode/store failed", self.cfg.id)
                client.record_poll(ok=False)
                self._recent_outcomes.append("decode")
                await self._handle_poll_failure(ModbusError(f"decode/store failed: {exc!r}", "decode"))

    async def _poll_decode_and_store(self, client: PumpClient, regs: dict[int, int]) -> None:
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
            "link": "online",
            "link_detail": "",
            "last_poll_ts": time.time(),
            "write_enabled": self.cfg.write_enabled,
            **decoded,
            "status_word": regs.get(R.REG_STATUS, 0),
            "state": self._derive_state(decoded),
            "setpoint_bounds_c": self._setpoint_bounds(decoded["mode_kind"],
                                                       decoded["max_water_temp_c"]),
            "active_faults": list(self.active_faults.values()),
            "identity_ok": self.identity_ok,
            "remote_lease_until": self._lease["until"] if self._lease else None,
            "remote_lease_source": self._lease["source"] if self._lease else None,
            "comm": client.stats.as_dict(),
        }
        # ok_polls here counts PRIOR successes (record_poll runs at the END of this method,
        # so a decode crash above counts the poll as failed). Also close the loop for a pump
        # that alerted offline without ever having been online (fresh boot, dead gateway).
        if not was_online and (client.stats.ok_polls >= 1 or self._offline_alerted):
            await self.store.add_event(self.cfg.id, "comm", code="online",
                                       message=f"{self.cfg.name} back online")
            self._push(title=f"✓ {self.cfg.name} back online",
                       message="Communication restored.", priority="low", tags="white_check_mark")
        self._offline_alerted = False
        await self.store.add_sample(self.cfg.id, decoded | {"status_word": regs.get(R.REG_STATUS, 0)})
        await self._maybe_comm_row()
        client.record_poll(ok=True)
        self.snapshot["comm"] = client.stats.as_dict()  # refresh post-record (0 consecutive)

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

    async def _read_control(self) -> dict[int, int]:
        """Fresh control-register read for the write path — honors the same
        SPLIT_RESERVED_HOLE fallback as the poll loop (one spanning read, or two)."""
        regs: dict[int, int] = {}
        for block in R.control_blocks():
            regs.update(await self.client.read_block(block))
        return regs

    async def apply_gateway(self, host: str, port: int, *, source: str) -> None:
        """Point this pump at a (new) gateway address: swap the Modbus client live,
        reset identity AND edge-detection state (the device behind the address may be
        different — stale baselines would fabricate 'changed at the unit' events and
        misattributed fault edges), audit, and notify the persistence callback."""
        old = f"{self.cfg.host}:{self.cfg.port}"
        self.client.close()
        self.cfg.host, self.cfg.port = host, port
        self.client = PumpClient(host, port, self.cfg.device_id,
                                 self.app_cfg.modbus_timeout_s)
        self.identity_ok = True
        self._prev_flags = None
        self._prev_config = None
        for gone in self.active_faults.values():  # close the ledger for the old device
            await self.store.add_event(
                self.cfg.id, "fault_off", code=gone["code"], severity=gone["severity"],
                message=f"Cleared (gateway reassigned): {gone['message']}",
                detail={"key": gone["key"]})
        self.active_faults.clear()
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
        # Never TCP-touch any configured pump's gateway during the sweep: with
        # max-clients=1 a bare connect can kick the HEALTHY pump's live connection.
        # (This pump's own stale address is excluded too — harmless: the UDP broadcast
        # and ARP still find its MAC at whatever NEW address it moved to.)
        in_use = {(p.host, p.port) for p in self.app_cfg.pumps}
        try:
            candidates = await self._discoverer(extra_ports={self.cfg.port}, probe=False,
                                                skip_probe=in_use)
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
        # Alert on the explicit edge flag, not on the previous snapshot's online state — a
        # pump that has NEVER been online (boot into a dead/miswired gateway: the bench-day
        # case) must alert too, exactly once, with a message that points at the triage table.
        if failures >= threshold and not self._offline_alerted:
            self._offline_alerted = True
            never_online = self.client.stats.ok_polls == 0
            self.snapshot = {**self.snapshot, "online": False, "state": "offline",
                             "comm": self.client.stats.as_dict()}
            message = (f"{self.cfg.name} has never responded ({exc.category}) — see the "
                       f"first-hour triage table in deploy/HARDWARE-DAY.md"
                       if never_online else
                       f"{self.cfg.name} unreachable for {failures} consecutive polls")
            await self.store.add_event(
                self.cfg.id, "comm", code="offline", severity="high",
                message=message, detail={"category": exc.category})
            self._push(title=f"⚠ {self.cfg.name} offline",
                       message=f"No response for {failures} polls ({exc.category}). "
                               f"Check the gateway / WiFi.", priority="high", tags="warning")
        else:
            self.snapshot = {**self.snapshot, "comm": self.client.stats.as_dict()}
            if failures >= threshold:
                self.snapshot["online"] = False
                self.snapshot["state"] = "offline"
        if not self.snapshot.get("online"):
            link, detail = self._link_status()
            self.snapshot["link"] = link
            self.snapshot["link_detail"] = detail
        await self._maybe_comm_row(force=True)

    def _link_status(self) -> tuple[str, str]:
        """Which layer is down, in plain language — the question a commissioning operator asks
        when a card goes OFFLINE. A failed TCP connect means the W610 GATEWAY is unreachable
        (power/WiFi/IP); a timeout/garble/NAK means the gateway answered but the HEAT PUMP
        behind it didn't (RS-485 wiring/pump power/slave address). Decided over a WINDOW of
        recent polls, NOT the single last failure, so a flapping gateway (drops on and off
        WiFi) can't flip-flop the banner or contradict the Setup network scan: ANY recent
        connect failure means the gateway link isn't solid — the thing to fix first — so only
        a clean run of connects with the pump still silent reads as pump_silent."""
        recent = self._recent_outcomes
        gateway_trouble = any(o == "connect" for o in recent)
        pump_trouble = any(o in ("timeout", "io", "exception", "decode") for o in recent)
        if gateway_trouble:
            intermittent = " (connecting only intermittently)" if pump_trouble else ""
            return ("gateway_down",
                    f"Can't reliably reach the W610 gateway at {self.cfg.host}{intermittent} — "
                    f"check its power, Wi-Fi signal, and IP.")
        if pump_trouble:
            return ("pump_silent",
                    "The W610 gateway responds, but the heat pump isn't answering — "
                    "check the RS-485 wiring, pump power, and slave address.")
        return ("unknown", "")

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
            self._push(title=f"⚠ {self.cfg.name}: gateway identity mismatch",
                       message=f"{self.cfg.host} answers with the wrong MAC — writes "
                               f"blocked. Check DHCP reservations.",
                       priority="urgent", tags="rotating_light")
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
                    # power/mode changed with no bridge write — the wall controller
                    # (normal) OR a rogue Modbus write on an un-isolated LAN (re-audit
                    # fix 1). Can't tell them apart, so surface it rather than auto-lock
                    # (which would false-fire on every legitimate local change).
                    if key in ("on", "mode"):
                        self._push(
                            title=f"{self.cfg.name}: {label} changed at the unit",
                            message=f"{label} is now {value} — changed outside the "
                                    f"dashboard (wall controller, or check gateway isolation).",
                            tags="eyes")
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

    def _push(self, title: str, message: str, priority: str = "default", tags: str = "") -> None:
        """Fire-and-forget alert; safe if unconfigured. Fans out to ntfy (all alerts) and,
        for serious ones, Resend email — each no-ops when not configured."""
        asyncio.create_task(notify.ntfy(
            self.app_cfg.notifications, title=title, message=message,
            priority=priority, tags=tags))
        asyncio.create_task(notify.email(
            self.app_cfg.notifications, subject=title, body=message, priority=priority))

    async def _update_faults(self, current: dict[str, FaultDef]) -> None:
        """Edge detection: log fault_on for new bits, fault_off for cleared bits."""
        for key, fdef in current.items():
            if key not in self.active_faults:
                self.active_faults[key] = self._fault_entry(key, fdef, time.time())
                await self.store.add_event(
                    self.cfg.id, "fault_on", code=fdef.code, severity=fdef.severity,
                    message=fdef.message, detail={"key": key})
                log.info("[%s] fault ON %s %s", self.cfg.id, fdef.code, fdef.message)
                # push only actionable faults — P17 anti-freeze (info) must never page
                if fdef.severity in (Severity.CRITICAL, Severity.HIGH):
                    self._push(
                        title=f"⚠ {self.cfg.name}: {fdef.code}",
                        message=fdef.message,
                        priority="urgent" if fdef.severity == Severity.CRITICAL else "high",
                        tags="rotating_light" if fdef.severity == Severity.CRITICAL else "warning")
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
    async def write_setpoint(self, value: float, source: str,
                             unattended: bool = False,
                             lease_minutes: float | None = None) -> dict:
        """Mode-aware guarded write: re-read the mode and unit-max registers FRESH
        (never trust a stale snapshot to pick the target register), clamp to the
        mode's effective bounds, rate limit, write, read-back verify, audit.
        Serialized per pump so concurrent requests can't slip past the rate limit.
        unattended=True (scheduler / machine token) additionally enforces the winter-safe
        floor. lease_minutes (from a remote optimizer) records a lease the optimizer must
        renew — see check_lease()."""
        async with self._write_lock:
            result = await self._write_setpoint_locked(value, source, unattended)
        g = self.app_cfg.guardrails
        if lease_minutes and g.baseline_setpoint_c is not None:
            until = time.time() + min(lease_minutes, g.lease_max_minutes) * 60
            self._lease = {"until": until, "source": source, "warned": False}
            if self._reverted:  # optimizer resumed after we'd reverted to baseline
                self._reverted = False
                self._push(title=f"✓ {self.cfg.name}: optimizer resumed",
                           message=f"{source} is setting the setpoint again.",
                           priority="low", tags="white_check_mark")
        return result

    async def _write_setpoint_locked(self, value: float, source: str,
                                     unattended: bool = False) -> dict:
        old = self.snapshot.get("setpoint_c")

        async def audit_reject(exc: GuardrailError | ModbusError, code: str, sev: str):
            await self.store.add_event(
                self.cfg.id, "setpoint_write", code=code, severity=sev,
                message=str(exc), detail={"old": old, "requested": value, "source": source})

        # cheap pre-checks before touching the bus. Whole degrees only: the register
        # is 1degC resolution — rounding silently would violate "never clamp silently".
        try:
            self._require_identity()
            if float(value) != int(value):
                raise GuardrailError(
                    f"setpoint must be a whole number of °C (got {value}) — the pump "
                    f"register has 1°C resolution", 422)
            self.guard.validate(self.cfg.id, value, online=self.online,
                                write_enabled=self.cfg.write_enabled,
                                min_c=float("-inf"), max_c=float("inf"))
        except GuardrailError as exc:
            await audit_reject(exc, "rejected", "warning")
            raise

        try:
            control = await self._read_control()
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

        # unattended actors (scheduler / machine token) can't drop below the winter-safe
        # floor even within the mode's clamp (re-audit: setpoint-only is still heat-removing)
        eff_min = bounds[0]
        if unattended and kind == "heating":
            g = self.app_cfg.guardrails
            floor = g.unattended_min_setpoint_c
            if floor is None:
                floor = g.setback_setpoint_c
            eff_min = max(eff_min, floor)
        try:
            context = f"{kind} mode" + (f", unit max {unit_max:g}°C" if kind == "heating" else "")
            if unattended and eff_min > bounds[0]:
                context += f", unattended floor {eff_min:g}°C"
            self.guard.validate(self.cfg.id, value, online=self.online,
                                write_enabled=self.cfg.write_enabled,
                                min_c=eff_min, max_c=bounds[1], context=context)
        except GuardrailError as exc:
            await audit_reject(exc, "rejected", "warning")
            raise

        raw = int(round(value / R.TEMP_SCALE))
        # Renew-without-rewrite: if the target register already holds this exact value, skip the
        # physical write, the rate-limit slot (record_write), and the audit event. A remote
        # optimizer renews its lease every ~15 min even when the setpoint is unchanged; those
        # renewals must not churn the pump's EEPROM or spam the event log. Bounds + the winter
        # floor were already validated above, so a same-value renewal that violates them is still
        # rejected — this only short-circuits a genuine write that's already satisfied. The lease
        # timer still refreshes in write_setpoint(), so the optimizer keeps its authority. Compare
        # raw register values (like the read-back verify) so it's immune to float/scale surprises.
        if control.get(target_register) == raw:
            readback = R.to_signed(raw) * R.TEMP_SCALE
            self.snapshot["setpoint_c"] = readback
            return {"setpoint_c": readback, "verified": True, "mode": kind, "unchanged": True}
        try:
            readback_raw = await self.client.write_register_verified(target_register, raw)
        except ModbusError as exc:
            await audit_reject(exc, "failed", "high")
            raise GuardrailError(f"write failed: {exc}", 502) from exc

        self.guard.record_write(self.cfg.id)
        readback = R.to_signed(readback_raw) * R.TEMP_SCALE
        verified = readback_raw == raw  # raw compare: immune to float/scale surprises
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
        return {"setpoint_c": readback, "verified": True, "mode": kind, "unchanged": False}

    async def _guarded_control_write(self, register: int, raw: int, *, event_type: str,
                                     describe: str, source: str,
                                     note: tuple[str, int] | None = None) -> None:
        """Shared machinery for mode/power writes: same discipline as setpoints —
        precondition checks, per-control rate limit, read-back verify, audit — then an
        immediate re-poll so the snapshot reflects the new reality right away.
        `note` = (config_key, value) registered as a local change ONLY after the write
        verifies — a rejected write must not poison external-change detection."""
        async with self._write_lock:
            await self._guarded_control_write_locked(
                register, raw, event_type=event_type, describe=describe,
                source=source, note=note)

    async def _guarded_control_write_locked(self, register: int, raw: int, *,
                                            event_type: str, describe: str, source: str,
                                            note: tuple[str, int] | None) -> None:
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
        if note:
            self.note_local_change(*note)
        await audit("accepted", "info", f"{describe} ({source})")
        await self.poll_once()

    async def check_lease(self, now: float) -> None:
        """Called each scheduler tick. If the optimizer's setpoint lease is lapsing, warn;
        if it has lapsed, revert to the warm baseline via the normal guarded path so the
        house is never stranded at a stale optimizer value. Catches optimizer-death while
        the Pi itself is alive — the gap the dead-man heartbeat can't see."""
        g = self.app_cfg.guardrails
        if not self._lease or g.baseline_setpoint_c is None:
            return
        remaining = self._lease["until"] - now
        if remaining <= 0:
            # revert FIRST; only clear the lease + alert once the baseline write actually
            # lands, so a transient rate-limit/offline retries next tick instead of
            # stranding the house at the stale optimizer value
            source = self._lease["source"]
            try:
                await self.write_setpoint(g.baseline_setpoint_c, source="baseline-revert",
                                          unattended=True)
            except GuardrailError as exc:
                log.warning("[%s] baseline revert pending (will retry): %s", self.cfg.id, exc)
                return
            self._lease = None
            self._reverted = True
            self._push(
                title=f"⚠ {self.cfg.name}: optimizer stale — reverted to baseline",
                message=f"No fresh setpoint from {source} — reverted to the "
                        f"{g.baseline_setpoint_c:g}°C baseline. House is fine; savings paused.",
                priority="high", tags="warning")
        elif remaining <= g.lease_warn_minutes * 60 and not self._lease["warned"]:
            self._lease["warned"] = True
            self._push(
                title=f"{self.cfg.name}: optimizer setpoint expiring",
                message=f"No renewal from {self._lease['source']} — reverting to baseline "
                        f"in ~{int(remaining / 60)} min unless it resumes.",
                priority="default", tags="hourglass")

    async def write_mode(self, kind: str, source: str) -> dict:
        """Switch heating <-> cooling (reg 2001). Only 0/1 ever written — the protocol
        doc marks modes 2-5 unstable. UI puts a confirmation step in front of this."""
        target = {"heating": 1, "cooling": 0}[kind]
        current = self.snapshot.get("mode_kind", "?")
        await self._guarded_control_write(
            R.REG_MODE, target, event_type="mode_write",
            describe=f"mode {current} -> {kind}", source=source,
            note=("mode", target))
        return {"mode": kind, "verified": True}

    async def write_power(self, on: bool, source: str) -> dict:
        """Unit on/off (reg 2000) — same as the wall controller's power button."""
        await self._guarded_control_write(
            R.REG_ON_OFF, 1 if on else 0, event_type="power_write",
            describe=f"unit switched {'on' if on else 'off'}", source=source,
            note=("on", 1 if on else 0))
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
        await self._guarded_control_write(
            addr, raw, event_type="param_write",
            describe=f"{label}: {old} -> {value}", source=source,
            note=(key, int(value)))
        return {"key": key, "value": value, "verified": True}
