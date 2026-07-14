# @purpose: Outbound WebSocket link to the Railway hub. The Pi dials OUT to the hub
# (wss://<host>/pi) and holds the connection open — no inbound port is ever opened on the
# Pi. The hub relays the optimizer's SETPOINT-ONLY commands and mirrors the latest state to
# the Vercel dashboard. Best-effort/additive: auto-reconnect with exponential backoff, and
# if the hub is down local LAN + Funnel control are completely unaffected. Every command is
# routed through the EXISTING guarded write path (poller.write_setpoint) — no register is
# ever written directly, and any non-setpoint action is ignored by design (power/mode/param
# stay human-only on the direct path). A nack (clamp/rate-limit/offline/floor/write_enabled)
# is a NORMAL outcome, not an error.
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import time

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from .config import HubConfig
from .guardrails import GuardrailError
from .poller import PumpPoller

log = logging.getLogger(__name__)

_BACKOFF_MIN_S = 1.0
_BACKOFF_MAX_S = 30.0


class HubClient:
    def __init__(self, cfg: HubConfig, pollers: dict[str, PumpPoller]):
        self.cfg = cfg
        self.pollers = pollers
        self._task: asyncio.Task | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.cfg.url and self.cfg.token)

    def start(self) -> None:
        if self.enabled:
            self._task = asyncio.create_task(self._run(), name="hub-client")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    # --- connection lifecycle -------------------------------------------------
    async def _run(self) -> None:
        """Dial the hub and hold the link; reconnect forever with exponential backoff.
        A connection error must never escape into the bridge — the link is additive."""
        backoff = _BACKOFF_MIN_S
        while True:
            try:
                async with connect(
                    self.cfg.url,
                    additional_headers={"Authorization": f"Bearer {self.cfg.token}"},
                ) as ws:
                    backoff = _BACKOFF_MIN_S  # connected cleanly -> reset the backoff
                    log.info("hub link established: %s", self.cfg.url)
                    await self._session(ws)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — swallow + retry, never raise into bridge
                log.warning("hub link down (retry in %.0fs): %s", backoff, exc)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, _BACKOFF_MAX_S)

    async def _session(self, ws) -> None:
        """One live connection: push state on connect + every state_interval_s, and
        service inbound commands/pings until the socket closes."""
        await self._send_state(ws)
        sender = asyncio.create_task(self._state_loop(ws))
        try:
            async for raw in ws:
                await self._dispatch(ws, raw)
        finally:
            sender.cancel()
            with contextlib.suppress(Exception):
                await sender

    async def _state_loop(self, ws) -> None:
        try:
            while True:
                await asyncio.sleep(self.cfg.state_interval_s)
                await self._send_state(ws)
        except (asyncio.CancelledError, ConnectionClosed):
            pass

    # --- inbound message handling ---------------------------------------------
    async def _dispatch(self, ws, raw) -> None:
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            log.warning("hub: ignoring non-JSON frame")
            return
        mtype = msg.get("type")
        if mtype == "ping":
            await self._safe_send(ws, {"type": "pong"})
        elif mtype == "command":
            await self._handle_command(ws, msg)
        else:
            log.debug("hub: ignoring frame type %r", mtype)

    async def _handle_command(self, ws, msg: dict) -> None:
        """setpoint and write_enable are the ONLY relayed actions. write_enable was added
        2026-07-14 by owner decision (remote arm/disarm from the dashboard): the hub gates
        it behind a SEPARATE arm token, the dashboard gates that behind a password
        re-entry, and here it lands on the same loud ceremony as the local UI toggle
        (audit event + high-priority push on enable; disable always wins instantly).
        Everything else (power/mode/params) remains human-only on the direct path and
        MUST NOT be applied here."""
        command_id = msg.get("command_id")
        action = msg.get("action")
        if action == "write_enable":
            await self._handle_write_enable(ws, msg)
            return
        if action != "setpoint":
            log.warning("hub: ignoring non-setpoint action %r (command %s)",
                        action, command_id)
            return  # do NOT ack — nothing changes for unrelayed actions
        pump_id = msg.get("pump_id")
        poller = self.pollers.get(pump_id)
        if poller is None:
            await self._ack(ws, command_id, False, f"unknown pump {pump_id!r}", None)
            return
        # Validate the payload BEFORE the guarded write. A non-numeric value_c would raise a
        # bare TypeError (un-audited), and a non-numeric lease_minutes can slip past the write
        # only to blow up later in the lease math — either way the write path must never see a
        # value it can't reason about. A bad payload is a clean nack, not a crash.
        value_c = msg.get("value_c")
        if isinstance(value_c, bool) or not isinstance(value_c, (int, float)) \
                or not math.isfinite(value_c):
            await self._ack(ws, command_id, False, f"invalid value_c {value_c!r}", None)
            return
        lease_minutes = msg.get("lease_minutes")
        if lease_minutes is not None and (
                isinstance(lease_minutes, bool)
                or not isinstance(lease_minutes, (int, float))
                or not math.isfinite(lease_minutes)):
            await self._ack(ws, command_id, False,
                            f"invalid lease_minutes {lease_minutes!r}", None)
            return
        source = "hub:" + str(msg.get("source") or "hub")
        try:
            result = await poller.write_setpoint(
                value_c, source=source,
                unattended=True, lease_minutes=lease_minutes)
        except GuardrailError as exc:
            # a nack is a NORMAL outcome (clamp/rate-limit/offline/floor/write_enabled)
            await self._ack(ws, command_id, False, str(exc), None)
            return
        except Exception as exc:  # noqa: BLE001 — a bad payload must not kill the link
            await self._ack(ws, command_id, False, str(exc), None)
            return
        await self._ack(ws, command_id, True, "ok", result.get("setpoint_c"))

    async def _handle_write_enable(self, ws, msg: dict) -> None:
        """The armed-dashboard toggle: same behavior as api.py's /write-enable route —
        set + persist + audit + push — and acked so the dashboard shows the outcome."""
        from .config import save_write_enabled

        command_id = msg.get("command_id")
        pump_id = msg.get("pump_id")
        poller = self.pollers.get(pump_id)
        if poller is None:
            await self._ack(ws, command_id, False, f"unknown pump {pump_id!r}", None)
            return
        enabled = msg.get("enabled")
        if not isinstance(enabled, bool):
            await self._ack(ws, command_id, False, f"invalid enabled {enabled!r}", None)
            return
        source = "hub:" + str(msg.get("source") or "armed-dashboard")
        was = poller.cfg.write_enabled
        poller.cfg.write_enabled = enabled
        poller.snapshot["write_enabled"] = enabled
        save_write_enabled(poller.app_cfg, pump_id, enabled)
        if enabled != was:
            await poller.store.add_event(
                pump_id, "config",
                code="write_enabled" if enabled else "write_disabled",
                severity="warning" if enabled else "info",
                message=f"remote control {'ENABLED' if enabled else 'disabled'} "
                        f"for {poller.cfg.name} ({source})")
            if enabled:
                poller._push(
                    title=f"⚠ {poller.cfg.name}: remote control enabled",
                    message=f"Writes are now allowed ({source}). Guardrails "
                            f"(clamp, rate limit, read-back verify) remain active.",
                    priority="high", tags="warning")
        await self._ack(ws, command_id, True, f"write_enabled={enabled}", None)

    async def _ack(self, ws, command_id, ok: bool, detail: str,
                   setpoint_c: float | None) -> None:
        await self._safe_send(ws, {
            "type": "ack", "command_id": command_id, "ok": ok,
            "detail": detail, "setpoint_c": setpoint_c})

    # --- outbound state -------------------------------------------------------
    def _state_payload(self) -> dict:
        """Latest per-pump state pushed to the hub. Same fields the analytics mirror
        exports (exporter.snapshot) PLUS remote_lease_until so the dashboard can show an
        active optimizer lease."""
        pumps = []
        for p in self.pollers.values():
            s = p.snapshot
            pumps.append({
                "id": p.cfg.id,
                "name": p.cfg.name,
                "online": bool(s.get("online")),
                "state": s.get("state", "offline"),
                "mode_kind": s.get("mode_kind"),
                "setpoint_c": s.get("setpoint_c"),
                "inlet_c": s.get("inlet_c"),
                "outlet_c": s.get("outlet_c"),
                "ambient_c": s.get("ambient_c"),
                "power_w": (s.get("power_sys1") or 0) + (s.get("power_sys2") or 0),
                "active_faults": len(s.get("active_faults", [])),
                "error_rate": p.client.stats.as_dict()["error_rate"],
                "remote_lease_until": s.get("remote_lease_until"),
                "write_enabled": p.cfg.write_enabled,
            })
        return {"type": "state", "ts": time.time(), "pumps": pumps}

    async def _send_state(self, ws) -> None:
        await self._safe_send(ws, self._state_payload())

    async def _safe_send(self, ws, obj: dict) -> None:
        try:
            await ws.send(json.dumps(obj))
        except ConnectionClosed:
            raise  # let the session unwind and reconnect
        except Exception as exc:  # noqa: BLE001
            log.warning("hub: send failed: %s", exc)
