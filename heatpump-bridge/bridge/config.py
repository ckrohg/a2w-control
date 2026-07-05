# @purpose: Typed configuration loaded from config.yaml (path via BRIDGE_CONFIG env var).
# Per-pump connection settings + global guardrail bounds. write_enabled defaults to False
# so a freshly configured real pump is read-only until explicitly enabled (Phase 1 rule).
from __future__ import annotations

import json
import os
from pathlib import Path

import yaml
from pydantic import BaseModel, Field, model_validator

from .registers import COOLING_REGISTER_RANGE, HARD_MAX_SETPOINT_C, HARD_MIN_SETPOINT_C


class PumpConfig(BaseModel):
    id: str
    name: str
    host: str
    port: int = 8899              # USR-W610 factory default TCP port
    device_id: int = 1            # Modbus slave address (SW2 DIP, default 1 unconfirmed)
    poll_interval_s: float = 20.0
    write_enabled: bool = False   # Phase 1: reads only until flipped deliberately
    # W610 MAC from its label. When set, the bridge verifies via ARP that the IP
    # really belongs to THIS physical unit — a swapped/reshuffled IP (pump identity
    # flip-flop) raises a critical alert and blocks all writes to it.
    mac: str | None = None
    added: bool = False   # True = created via the UI (persisted in bridge state,
                          # removable via the UI); False = defined in config.yaml


class GuardrailConfig(BaseModel):
    # heating setpoint clamp; effective max at runtime = min(this, live reg 2027).
    # 75degC (167degF) is the manual's rated operating point; hardware max outlet is
    # 85degC and the Arctic installer manual caps the WATER SYSTEM at 80degC (p.15) —
    # keep this at or below 80. NOTE: reg 2027 (wall param 17) ships at 55 — raise it
    # on the unit to go higher.
    setpoint_min_c: float = 30.0
    setpoint_max_c: float = 75.0
    # cooling setpoint clamp (reg 2002); register itself only accepts 10-25
    cooling_setpoint_min_c: float = 12.0
    cooling_setpoint_max_c: float = 25.0
    min_write_interval_s: float = 60.0
    offline_after_failed_polls: int = 3

    @model_validator(mode="after")
    def _sane_bounds(self):
        if not (HARD_MIN_SETPOINT_C <= self.setpoint_min_c < self.setpoint_max_c):
            raise ValueError("heating setpoint bounds must satisfy "
                             f"{HARD_MIN_SETPOINT_C} <= min < max")
        if self.setpoint_max_c > HARD_MAX_SETPOINT_C:
            raise ValueError(f"setpoint_max_c {self.setpoint_max_c} exceeds the hard "
                             f"ceiling {HARD_MAX_SETPOINT_C}degC — refusing to start")
        lo, hi = COOLING_REGISTER_RANGE
        if not (lo <= self.cooling_setpoint_min_c < self.cooling_setpoint_max_c <= hi):
            raise ValueError(f"cooling setpoint bounds must be within {lo}-{hi}degC")
        return self


class AppConfig(BaseModel):
    pumps: list[PumpConfig] = Field(min_length=1)
    guardrails: GuardrailConfig = GuardrailConfig()
    db_path: str = "bridge.db"
    ui_dir: str = "ui"
    modbus_timeout_s: float = 5.0  # generous: 2400 baud multi-register reads are slow


def load_config(path: str | os.PathLike | None = None) -> AppConfig:
    cfg_path = Path(path or os.environ.get("BRIDGE_CONFIG", "config.yaml"))
    with open(cfg_path) as f:
        raw = yaml.safe_load(f)
    cfg = AppConfig.model_validate(raw)
    apply_gateway_overrides(cfg)
    return cfg


# --- bridge-owned state (gateway overrides + UI-added pumps) ------------------------
# When discovery moves a pump to a new address, or a pump is added via the UI, we
# persist it here — NOT by rewriting config.yaml (the human's file, full of comments).
# Overrides only apply while the stored MAC still matches the config, so editing
# config.yaml to a new unit invalidates stale overrides naturally.

def _state_path(cfg: AppConfig) -> Path:
    return Path(cfg.db_path).parent / "gateway-overrides.json"


def _read_state(cfg: AppConfig) -> dict:
    path = _state_path(cfg)
    if not path.exists():
        return {"overrides": {}, "added_pumps": []}
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {"overrides": {}, "added_pumps": []}
    if "overrides" not in data and "added_pumps" not in data:
        data = {"overrides": data}  # legacy flat layout
    data.setdefault("overrides", {})
    data.setdefault("added_pumps", [])
    return data


def _write_state(cfg: AppConfig, data: dict) -> None:
    with open(_state_path(cfg), "w") as f:
        json.dump(data, f, indent=1)


def save_gateway_override(cfg: AppConfig, pump_id: str, host: str, port: int) -> None:
    data = _read_state(cfg)
    pump = next((p for p in cfg.pumps if p.id == pump_id), None)
    data["overrides"][pump_id] = {"host": host, "port": port,
                                  "mac": pump.mac if pump else None}
    if pump and pump.added:  # keep the added-pump record current too
        save_added_pump(cfg, pump, _data=data)
        return
    _write_state(cfg, data)


def save_added_pump(cfg: AppConfig, pump: PumpConfig, _data: dict | None = None) -> None:
    data = _data if _data is not None else _read_state(cfg)
    data["added_pumps"] = [p for p in data["added_pumps"] if p["id"] != pump.id]
    data["added_pumps"].append(pump.model_dump())
    _write_state(cfg, data)


def remove_added_pump(cfg: AppConfig, pump_id: str) -> None:
    data = _read_state(cfg)
    data["added_pumps"] = [p for p in data["added_pumps"] if p["id"] != pump_id]
    data["overrides"].pop(pump_id, None)
    _write_state(cfg, data)


def apply_gateway_overrides(cfg: AppConfig) -> None:
    data = _read_state(cfg)
    for entry in data["added_pumps"]:
        if not any(p.id == entry["id"] for p in cfg.pumps):
            cfg.pumps.append(PumpConfig.model_validate(entry))
    for pump in cfg.pumps:
        entry = data["overrides"].get(pump.id)
        if not entry:
            continue
        if pump.mac and entry.get("mac") and pump.mac.lower() != entry["mac"].lower():
            continue  # config points at a different physical unit now — override stale
        pump.host = entry["host"]
        pump.port = entry.get("port", pump.port)
        if not pump.mac and entry.get("mac"):
            pump.mac = entry["mac"]  # adopted at assignment time; keep it across restarts
