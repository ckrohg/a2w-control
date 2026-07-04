# @purpose: Typed configuration loaded from config.yaml (path via BRIDGE_CONFIG env var).
# Per-pump connection settings + global guardrail bounds. write_enabled defaults to False
# so a freshly configured real pump is read-only until explicitly enabled (Phase 1 rule).
from __future__ import annotations

import os
from pathlib import Path

import yaml
from pydantic import BaseModel, Field


class PumpConfig(BaseModel):
    id: str
    name: str
    host: str
    port: int = 8899              # USR-W610 factory default TCP port
    device_id: int = 1            # Modbus slave address (SW2 DIP, default 1 unconfirmed)
    poll_interval_s: float = 20.0
    write_enabled: bool = False   # Phase 1: reads only until flipped deliberately


class GuardrailConfig(BaseModel):
    setpoint_min_c: float = 30.0
    setpoint_max_c: float = 55.0  # matches reg 2027 factory default; confirm on unit
    min_write_interval_s: float = 60.0
    offline_after_failed_polls: int = 3


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
