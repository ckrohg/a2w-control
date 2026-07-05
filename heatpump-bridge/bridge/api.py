# @purpose: JSON API surface (handoff §6.3). No auth here by design — Cloudflare Access
# (email OTP) fronts the tunnel. All reads come from the pollers' in-memory snapshots.
from __future__ import annotations

import time
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import __version__
from .guardrails import GuardrailError
from .poller import PumpPoller

router = APIRouter(prefix="/api")


class SetpointRequest(BaseModel):
    value: float
    source: str = Field(default="ui", max_length=32)  # audit trail; future: "tempiq"


class ModeRequest(BaseModel):
    value: Literal["heating", "cooling"]  # modes 2-5 are unstable per protocol doc
    source: str = Field(default="ui", max_length=32)


class PowerRequest(BaseModel):
    value: bool
    source: str = Field(default="ui", max_length=32)


class ParameterRequest(BaseModel):
    key: str
    value: int
    source: str = Field(default="ui", max_length=32)


class ScheduleRequest(BaseModel):
    time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")  # "HH:MM" Pi-local
    action: Literal["on", "off"]


class GatewayRequest(BaseModel):
    host: str
    port: int = 8899


def _pollers(request: Request) -> dict[str, PumpPoller]:
    return request.app.state.pollers


def _pump(request: Request, pump_id: str) -> PumpPoller:
    poller = _pollers(request).get(pump_id)
    if not poller:
        raise HTTPException(404, f"unknown pump: {pump_id}")
    return poller


@router.get("/pumps")
async def list_pumps(request: Request):
    return [
        {
            "id": p.cfg.id,
            "name": p.cfg.name,
            "online": p.online,
            "state": p.snapshot.get("state", "offline"),
            "last_poll_ts": p.snapshot.get("last_poll_ts"),
            "error_rate": p.client.stats.as_dict()["error_rate"],
        }
        for p in _pollers(request).values()
    ]


@router.get("/pumps/{pump_id}/status")
async def pump_status(request: Request, pump_id: str):
    return _pump(request, pump_id).snapshot


@router.get("/pumps/{pump_id}/history")
async def pump_history(request: Request, pump_id: str, hours: float = 24):
    poller = _pump(request, pump_id)
    hours = min(max(hours, 1), 24 * 90)
    return await poller.store.get_history(pump_id, hours)


@router.get("/pumps/{pump_id}/events")
async def pump_events(request: Request, pump_id: str, days: float = 7):
    poller = _pump(request, pump_id)
    days = min(max(days, 1), 365)
    return await poller.store.get_events(pump_id, days)


@router.post("/pumps/{pump_id}/setpoint")
async def write_setpoint(request: Request, pump_id: str, body: SetpointRequest):
    poller = _pump(request, pump_id)
    try:
        return await poller.write_setpoint(body.value, body.source)
    except GuardrailError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.post("/pumps/{pump_id}/mode")
async def write_mode(request: Request, pump_id: str, body: ModeRequest):
    poller = _pump(request, pump_id)
    try:
        return await poller.write_mode(body.value, body.source)
    except GuardrailError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.post("/pumps/{pump_id}/power")
async def write_power(request: Request, pump_id: str, body: PowerRequest):
    poller = _pump(request, pump_id)
    try:
        return await poller.write_power(body.value, body.source)
    except GuardrailError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.post("/pumps/{pump_id}/parameter")
async def write_parameter(request: Request, pump_id: str, body: ParameterRequest):
    poller = _pump(request, pump_id)
    try:
        return await poller.write_parameter(body.key, body.value, body.source)
    except GuardrailError as exc:
        raise HTTPException(exc.status_code, str(exc)) from exc


@router.get("/pumps/{pump_id}/schedules")
async def list_schedules(request: Request, pump_id: str):
    poller = _pump(request, pump_id)
    return await poller.store.list_schedules(pump_id)


@router.post("/pumps/{pump_id}/schedules")
async def add_schedule(request: Request, pump_id: str, body: ScheduleRequest):
    poller = _pump(request, pump_id)
    await poller.store.add_schedule(pump_id, body.time, body.action)
    await poller.store.add_event(
        pump_id, "schedule_change", code="added", severity="info",
        message=f"timer added: {body.action} at {body.time}")
    return await poller.store.list_schedules(pump_id)


@router.delete("/pumps/{pump_id}/schedules/{schedule_id}")
async def delete_schedule(request: Request, pump_id: str, schedule_id: int):
    poller = _pump(request, pump_id)
    await poller.store.delete_schedule(pump_id, schedule_id)
    await poller.store.add_event(
        pump_id, "schedule_change", code="removed", severity="info",
        message=f"timer {schedule_id} removed")
    return await poller.store.list_schedules(pump_id)


@router.get("/discover")
async def discover_gateways(request: Request, probe: bool = True):
    """Sweep the LAN for W610 gateways (USR broadcast + Modbus-port scan), optionally
    probing each with a real register read. Marks which candidate matches each
    configured pump's MAC."""
    from .discovery import discover, normalize_mac

    pollers = _pollers(request)
    extra_ports = {p.cfg.port for p in pollers.values()}
    candidates = await discover(extra_ports=extra_ports, probe=probe)
    mac_to_pump = {normalize_mac(p.cfg.mac): p.cfg.id
                   for p in pollers.values() if p.cfg.mac}
    for c in candidates:
        c["matches_pump"] = mac_to_pump.get(normalize_mac(c["mac"])) if c.get("mac") else None
        c["in_use_by"] = next((p.cfg.id for p in pollers.values()
                               if p.cfg.host == c["ip"] and p.cfg.port == c.get("port")), None)
    return candidates


@router.post("/pumps/{pump_id}/gateway")
async def set_gateway(request: Request, pump_id: str, body: GatewayRequest):
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


@router.get("/health")
async def health(request: Request):
    pollers = _pollers(request)
    return {
        "service": "heatpump-bridge",
        "version": __version__,
        "ts": time.time(),
        "pumps_online": sum(1 for p in pollers.values() if p.online),
        "pumps_total": len(pollers),
    }
