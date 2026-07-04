# @purpose: JSON API surface (handoff §6.3). No auth here by design — Cloudflare Access
# (email OTP) fronts the tunnel. All reads come from the pollers' in-memory snapshots.
from __future__ import annotations

import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import __version__
from .guardrails import GuardrailError
from .poller import PumpPoller

router = APIRouter(prefix="/api")


class SetpointRequest(BaseModel):
    value: float
    source: str = Field(default="ui", max_length=32)  # audit trail; future: "tempiq"


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
