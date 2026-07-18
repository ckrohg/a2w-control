# @purpose: JSON API surface (handoff §6.3). Machine auth lives in auth.py: Bearer tokens
# (for consumers like TempIQ) + a UI session cookie for browsers past the tunnel. The
# authenticated principal's `source` is the audit identity — clients cannot spoof it, so
# the request bodies no longer carry a source field. All reads come from the pollers'
# in-memory snapshots.
from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import __version__
from .auth import (Principal, UI_COOKIE, cookie_secure, login_locked, mint_session,
                   register_login_failure, require, resolve_principal_safe, _eq)
from .guardrails import GuardrailError
from .poller import PumpPoller

router = APIRouter(prefix="/api")

# dependency singletons. write = setpoint (machines allowed); control = power/mode/param/
# setup (machines blocked under unattended-write safety — humans only).
read = require("read")
write = require("write")
control = require("control")


class SetpointRequest(BaseModel):
    value: float
    lease_minutes: float | None = Field(default=None, gt=0)  # remote optimizer: renew before it lapses


class ModeRequest(BaseModel):
    value: Literal["heating", "cooling"]  # modes 2-5 are unstable per protocol doc


class PowerRequest(BaseModel):
    value: bool


class ParameterRequest(BaseModel):
    key: str
    value: int


class ScheduleRequest(BaseModel):
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")  # "HH:MM" Pi-local
    action: Literal["on", "off"]


class GatewayRequest(BaseModel):
    host: str
    port: int = 8899


class AddPumpRequest(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    host: str
    port: int = 8899


class WriteEnableRequest(BaseModel):
    enabled: bool


class SessionRequest(BaseModel):
    password: str


def _pollers(request: Request) -> dict[str, PumpPoller]:
    return request.app.state.pollers


def _pump(request: Request, pump_id: str) -> PumpPoller:
    poller = _pollers(request).get(pump_id)
    if not poller:
        raise HTTPException(404, f"unknown pump: {pump_id}")
    return poller


@router.get("/pumps")
async def list_pumps(request: Request, _p: Principal = Depends(read)):
    return [
        {
            "id": p.cfg.id,
            "name": p.cfg.name,
            "online": p.online,
            "state": p.snapshot.get("state", "offline"),
            "last_poll_ts": p.snapshot.get("last_poll_ts"),
            "error_rate": p.client.stats.as_dict()["error_rate"],
            "host": p.cfg.host,
            "port": p.cfg.port,
            "mac": p.cfg.mac,
            "added": p.cfg.added,
            "write_enabled": p.cfg.write_enabled,
            "link": p.snapshot.get("link", "online" if p.online else "unknown"),
            "link_detail": p.snapshot.get("link_detail", ""),
        }
        for p in _pollers(request).values()
    ]


@router.post("/pumps")
async def add_pump(request: Request, body: AddPumpRequest,
                   principal: Principal = Depends(control)):
    """Add a heat pump at runtime (Setup tab): point it at a discovered gateway,
    adopt the MAC, start polling, persist across restarts. Ships write-disabled —
    same Phase 1 rule as config-defined pumps."""
    from .config import PumpConfig, save_added_pump
    from .discovery import get_mac_for_ip
    from .poller import PumpPoller

    state = request.app.state
    mac = await get_mac_for_ip(body.host)  # await BEFORE picking the id: no yield
    existing = set(state.pollers.keys())   # between id choice and registration, so
    n = 1                                  # concurrent adds can't collide on pump{n}
    while f"pump{n}" in existing:
        n += 1
    pump_cfg = PumpConfig(
        id=f"pump{n}", name=body.name, host=body.host, port=body.port,
        mac=mac, added=True, write_enabled=False)
    state.config.pumps.append(pump_cfg)
    poller = PumpPoller(pump_cfg, state.config, state.store, state.guard)
    poller.on_gateway_change = state.persist_gateway
    state.pollers[pump_cfg.id] = poller
    await poller.start()
    save_added_pump(state.config, pump_cfg)
    await state.store.add_event(
        pump_cfg.id, "comm", code="pump_added", severity="info",
        message=f"{body.name} added at {body.host}:{body.port} ({principal.source})")
    return {"id": pump_cfg.id, "name": pump_cfg.name, "mac": pump_cfg.mac}


@router.delete("/pumps/{pump_id}")
async def remove_pump(request: Request, pump_id: str,
                      principal: Principal = Depends(control)):
    """Remove a UI-added pump (config.yaml-defined pumps are removed by editing the
    file — the bridge never rewrites the human's config)."""
    from .config import remove_added_pump

    state = request.app.state
    poller = _pump(request, pump_id)
    if not poller.cfg.added:
        raise HTTPException(
            409, f"{pump_id} is defined in config.yaml — remove it there, then restart")
    await poller.stop()
    del state.pollers[pump_id]
    state.config.pumps = [p for p in state.config.pumps if p.id != pump_id]
    remove_added_pump(state.config, pump_id)
    # pump ids are recycled — orphaned timers would silently attach to a future pump
    await state.store.delete_schedules_for_pump(pump_id)
    await state.store.add_event(
        pump_id, "comm", code="pump_removed", severity="info",
        message=f"{poller.cfg.name} removed via Setup (its timers deleted with it)")
    return {"removed": pump_id}


@router.get("/pumps/{pump_id}/status")
async def pump_status(request: Request, pump_id: str, _p: Principal = Depends(read)):
    return _pump(request, pump_id).snapshot


@router.get("/pumps/{pump_id}/history")
async def pump_history(request: Request, pump_id: str, hours: float = 24,
                       _p: Principal = Depends(read)):
    poller = _pump(request, pump_id)
    hours = min(max(hours, 1), 24 * 90)
    return await poller.store.get_history(pump_id, hours)


@router.get("/pumps/{pump_id}/events")
async def pump_events(request: Request, pump_id: str, days: float = 7,
                      _p: Principal = Depends(read)):
    poller = _pump(request, pump_id)
    days = min(max(days, 1), 365)
    return await poller.store.get_events(pump_id, days)


@router.get("/system")
async def system_now(request: Request, _p: Principal = Depends(read)):
    """Latest Pi health sample (CPU/RAM/temp/disk-on-DB-volume), recorded ~every 60s by the
    scheduler. Null until the first sample lands after startup."""
    return await request.app.state.store.get_system_latest()


@router.get("/system/history")
async def system_history(request: Request, hours: float = 24,
                         _p: Principal = Depends(read)):
    hours = min(max(hours, 1), 24 * 90)
    return await request.app.state.store.get_system_history(hours)


@router.post("/pumps/{pump_id}/setpoint")
async def write_setpoint(request: Request, pump_id: str, body: SetpointRequest,
                         principal: Principal = Depends(write)):
    poller = _pump(request, pump_id)
    try:
        return await poller.write_setpoint(body.value, principal.source,
                                           unattended=principal.is_machine,
                                           lease_minutes=body.lease_minutes)
    except GuardrailError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.post("/pumps/{pump_id}/mode")
async def write_mode(request: Request, pump_id: str, body: ModeRequest,
                     principal: Principal = Depends(control)):
    poller = _pump(request, pump_id)
    try:
        return await poller.write_mode(body.value, principal.source)
    except GuardrailError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.post("/pumps/{pump_id}/power")
async def write_power(request: Request, pump_id: str, body: PowerRequest,
                      principal: Principal = Depends(control)):
    poller = _pump(request, pump_id)
    try:
        return await poller.write_power(body.value, principal.source)
    except GuardrailError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.post("/pumps/{pump_id}/parameter")
async def write_parameter(request: Request, pump_id: str, body: ParameterRequest,
                          principal: Principal = Depends(control)):
    poller = _pump(request, pump_id)
    try:
        return await poller.write_parameter(body.key, body.value, principal.source)
    except GuardrailError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.get("/pumps/{pump_id}/schedules")
async def list_schedules(request: Request, pump_id: str, _p: Principal = Depends(read)):
    poller = _pump(request, pump_id)
    return await poller.store.list_schedules(pump_id)


@router.post("/pumps/{pump_id}/schedules")
async def add_schedule(request: Request, pump_id: str, body: ScheduleRequest,
                       principal: Principal = Depends(control)):
    poller = _pump(request, pump_id)
    await poller.store.add_schedule(pump_id, body.time, body.action)
    await poller.store.add_event(
        pump_id, "schedule_change", code="added", severity="info",
        message=f"timer added: {body.action} at {body.time} ({principal.source})")
    return await poller.store.list_schedules(pump_id)


@router.delete("/pumps/{pump_id}/schedules/{schedule_id}")
async def delete_schedule(request: Request, pump_id: str, schedule_id: int,
                          principal: Principal = Depends(control)):
    poller = _pump(request, pump_id)
    await poller.store.delete_schedule(pump_id, schedule_id)
    await poller.store.add_event(
        pump_id, "schedule_change", code="removed", severity="info",
        message=f"timer {schedule_id} removed ({principal.source})")
    return await poller.store.list_schedules(pump_id)


@router.get("/discover")
async def discover_gateways(request: Request, probe: bool = True,
                            _p: Principal = Depends(control)):
    """Sweep the LAN for W610 gateways (USR broadcast + Modbus-port scan), optionally
    probing each with a real register read. Marks which candidate matches each
    configured pump's MAC."""
    from .discovery import discover, normalize_mac

    pollers = _pollers(request)
    extra_ports = {p.cfg.port for p in pollers.values()}
    in_use = {(p.cfg.host, p.cfg.port) for p in pollers.values() if p.online}
    candidates = await discover(extra_ports=extra_ports, probe=probe, skip_probe=in_use)
    mac_to_pump = {normalize_mac(p.cfg.mac): p.cfg.id
                   for p in pollers.values() if p.cfg.mac}
    for c in candidates:
        c["matches_pump"] = mac_to_pump.get(normalize_mac(c["mac"])) if c.get("mac") else None
        c["in_use_by"] = next((p.cfg.id for p in pollers.values()
                               if p.cfg.host == c["ip"] and p.cfg.port == c.get("port")), None)
    return candidates


@router.post("/pumps/{pump_id}/gateway")
async def set_gateway(request: Request, pump_id: str, body: GatewayRequest,
                      _p: Principal = Depends(control)):
    """Assign a discovered gateway to this pump. If the pump has a configured MAC and
    the target's MAC is resolvable, they must match (409 otherwise) — you cannot
    accidentally point pump 1 at pump 2's gateway."""
    from .discovery import get_mac_for_ip, normalize_mac

    poller = _pump(request, pump_id)
    actual = await get_mac_for_ip(body.host)
    if poller.cfg.mac:
        if actual and normalize_mac(actual) != normalize_mac(poller.cfg.mac):
            raise HTTPException(
                409, f"{body.host} answers with MAC {actual}, but {pump_id} is "
                     f"configured as {poller.cfg.mac} — that's a different physical unit")
    elif actual:
        # trust-on-first-assignment: adopt the MAC so identity checking + MAC-following
        # rediscovery are active from here on, without anyone typing a MAC
        poller.cfg.mac = actual
    await poller.apply_gateway(body.host, body.port, source="assigned via UI")
    await poller.poll_once()
    return {"host": body.host, "port": body.port, "online": poller.online,
            "mac": poller.cfg.mac}


@router.post("/pumps/{pump_id}/write-enable")
async def set_write_enabled(request: Request, pump_id: str, body: WriteEnableRequest,
                            principal: Principal = Depends(control)):
    """Enable/disable the write path for one pump from the UI — the runtime alternative
    to editing config.yaml. Deliberately LOUD: audited, and push-notified on enable.
    Every write still runs the full guardrail stack (clamp, rate limit, identity check,
    read-back verify) regardless of this flag; disabling always wins instantly."""
    from .config import save_write_enabled

    poller = _pump(request, pump_id)
    was = poller.cfg.write_enabled
    poller.cfg.write_enabled = body.enabled
    poller.snapshot["write_enabled"] = body.enabled
    save_write_enabled(request.app.state.config, pump_id, body.enabled)
    if body.enabled != was:
        await poller.store.add_event(
            pump_id, "config", code="write_enabled" if body.enabled else "write_disabled",
            severity="warning" if body.enabled else "info",
            message=f"remote control {'ENABLED' if body.enabled else 'disabled'} "
                    f"for {poller.cfg.name} ({principal.source})")
        if body.enabled:
            poller._push(
                title=f"⚠ {poller.cfg.name}: remote control enabled",
                message=f"Writes are now allowed ({principal.source}). Guardrails "
                        f"(clamp, rate limit, read-back verify) remain active.",
                priority="high", tags="warning")
    return {"id": pump_id, "write_enabled": body.enabled}


@router.post("/w610/configure")
async def configure_w610_endpoint(request: Request, body: GatewayRequest,
                                  _p: Principal = Depends(control)):
    """EXPERIMENTAL: push the required serial settings (2400 8N1, transparent mode)
    to a W610 over the vendor UDP channel — the web-console alternative."""
    from .w610_config import configure_w610

    report = await configure_w610(body.host)
    for p in _pollers(request).values():
        if p.cfg.host == body.host:
            await p.store.add_event(
                p.cfg.id, "comm", code="w610_configure",
                severity="info" if report["ok"] else "warning",
                message=f"W610 auto-configure at {body.host}: "
                        f"{', '.join(report['changed']) or report.get('error', 'already correct')}")
            break
    return report


@router.get("/health")
async def health(request: Request, response: Response):
    """Open (no auth) so uptime checks and the bootstrap can hit it. Returns 503 when the
    bridge is 'blind' — a write-enabled pump exists but NOTHING has polled fresh in 90s —
    so a deploy that comes up but can't reach the gateways fails the updater's health check
    and rolls back (re-audit fix 4b), and uptime monitors catch a stuck bridge. Read-only /
    no-hardware phases (no write_enabled pump) always report healthy."""
    pollers = _pollers(request)
    now = time.time()
    fresh = sum(1 for p in pollers.values() if p.online
                and p.snapshot.get("last_poll_ts") and now - p.snapshot["last_poll_ts"] < 90)
    controlling = any(p.cfg.write_enabled for p in pollers.values())
    blind = controlling and fresh == 0
    if blind:
        response.status_code = 503
    return {
        "service": "heatpump-bridge",
        "version": __version__,
        "ts": now,
        "pumps_online": sum(1 for p in pollers.values() if p.online),
        "pumps_fresh": fresh,
        "pumps_total": len(pollers),
        "healthy": not blind,
        "auth_mode": request.app.state.config.auth.protect,
        # whether push alerts (ntfy) / the dead-man heartbeat are wired — lets an operator
        # confirm the health-alert path can actually deliver without exposing the topic/URL.
        "notify_configured": bool(request.app.state.config.notifications.ntfy_topic),
        "heartbeat_configured": bool(request.app.state.config.notifications.heartbeat_url),
    }


@router.get("/whoami")
async def whoami(request: Request):
    """Open endpoint that reports how the caller is authenticated — lets a machine
    consumer (TempIQ) verify its token, and the browser decide whether to show a login."""
    p = resolve_principal_safe(request)
    auth = request.app.state.config.auth
    return {"authenticated": p.authenticated, "source": p.source, "can_write": p.can_write,
            "protect": auth.protect, "login_available": bool(auth.ui_password)}


@router.post("/session")
async def login(request: Request, body: SessionRequest, response: Response):
    """Exchange the UI password for a signed browser session cookie (used when
    protect != off). Machines use bearer tokens and never call this."""
    auth = request.app.state.config.auth
    if not auth.ui_password:
        raise HTTPException(400, "no UI password is configured on the bridge")
    if login_locked():
        raise HTTPException(429, "too many failed logins — try again in a minute")
    if not _eq(body.password, auth.ui_password):
        register_login_failure()
        raise HTTPException(401, "incorrect password")
    response.set_cookie(
        UI_COOKIE, mint_session(request.app.state.ui_secret), httponly=True,
        samesite="strict", secure=cookie_secure(request), max_age=30 * 86400, path="/")
    return {"ok": True}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(UI_COOKIE, path="/")
    return {"ok": True}
