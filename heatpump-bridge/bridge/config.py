# @purpose: Typed configuration loaded from config.yaml (path via BRIDGE_CONFIG env var).
# Per-pump connection settings + global guardrail bounds. write_enabled defaults to False
# so a freshly configured real pump is read-only until explicitly enabled (Phase 1 rule).
from __future__ import annotations

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
    return AppConfig.model_validate(raw)
