# @purpose: Typed configuration loaded from config.yaml (path via BRIDGE_CONFIG env var).
# Per-pump connection settings + global guardrail bounds. write_enabled defaults to False
# so a freshly configured real pump is read-only until explicitly enabled (Phase 1 rule).
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator

from .registers import COOLING_REGISTER_RANGE, HARD_MAX_SETPOINT_C, HARD_MIN_SETPOINT_C


class PumpConfig(BaseModel):
    id: str
    name: str
    host: str
    port: int = 8899              # USR-W610 factory default TCP port
    device_id: int = 1            # Modbus slave address (SW2 DIP; default 1 confirmed by Winnie)
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
    # Cold-latch safety (fusion audit risk 2): unattended writers (the on-Pi scheduler
    # and machine API tokens) must not latch a state the manual/HBX fallback can't undo
    # if connectivity then drops in a cold snap. When true:
    #   - machine tokens are setpoint-only (no power/mode/parameter/setup writes)
    #   - scheduler never powers a pump OFF: an "off" timer sets a setback setpoint
    #     instead (unit keeps running, can't freeze); "on" powers on + comfort setpoint.
    # The human UI keeps full control (a person tapping "off" is attended).
    restrict_unattended_writes: bool = True
    setback_setpoint_c: float = 40.0        # scheduler "off" target under restriction
    comfort_setpoint_c: float | None = None  # scheduler "on" target (None = leave setpoint)
    # Winter-safe floor for UNATTENDED setpoint writes (scheduler + machine tokens). Even
    # "setpoint-only" is heat-removing if it can go below a safe LWT — re-audit found the
    # clamp min (30) sits below the setback (40). Set this from the house's design-day
    # heat requirement, NOT a round number. Defaults to the setback.
    unattended_min_setpoint_c: float | None = None
    # Remote-optimizer LEASE (fusion architecture audit): a remote setpoint write is a
    # time-limited lease the optimizer must keep renewing. If it goes silent, the Pi
    # reverts to `baseline_setpoint_c` (a warm winter default) on its own — never stranded
    # at a stale optimizer value. Dormant until baseline_setpoint_c is set (platform phase).
    baseline_setpoint_c: float | None = None   # warm default reverted to when a lease lapses
    lease_max_minutes: float = 180             # clamp on any single lease
    lease_warn_minutes: float = 15             # warn this long before a lease would revert

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
        if not (self.setpoint_min_c <= self.setback_setpoint_c <= self.setpoint_max_c):
            raise ValueError("setback_setpoint_c must be within the heating clamp")
        if self.unattended_min_setpoint_c is not None and not (
                self.setpoint_min_c <= self.unattended_min_setpoint_c <= self.setpoint_max_c):
            raise ValueError("unattended_min_setpoint_c must be within the heating clamp")
        if self.baseline_setpoint_c is not None:
            floor = self.unattended_min_setpoint_c or self.setback_setpoint_c
            if not (floor <= self.baseline_setpoint_c <= self.setpoint_max_c):
                raise ValueError("baseline_setpoint_c must be within [unattended floor, max] "
                                 "— it's the WARM default the house reverts to")
        if self.comfort_setpoint_c is not None and not (
                self.setpoint_min_c <= self.comfort_setpoint_c <= self.setpoint_max_c):
            raise ValueError("comfort_setpoint_c must be within the heating clamp")
        return self


class ApiToken(BaseModel):
    token: str = Field(min_length=16)   # long random secret; e.g. `openssl rand -hex 24`
    source: str = "api"                 # audit identity for writes made with this token
    can_write: bool = False             # read-only by default (safe); True = full control

    @model_validator(mode="after")
    def _label(self):
        if not self.source.strip():
            raise ValueError("token source label must be non-empty")
        return self


class AuthConfig(BaseModel):
    # off   = no auth enforced (LAN/tunnel is the only gate; tokens still honored for
    #         attribution + scope if presented). Backward-compatible default.
    # writes= control endpoints require a valid can_write token or a UI login session.
    # all   = every /api call requires a token or a UI login session.
    protect: Literal["off", "writes", "all"] = "off"
    tokens: list[ApiToken] = []

    @field_validator("protect", mode="before")
    @classmethod
    def _yaml_off_footgun(cls, v):
        # YAML 1.1 parses unquoted `off` as boolean False — accept it as "off" so a
        # hand-written `protect: off` doesn't fail the bridge on boot
        return "off" if v is False else v
    # Browser login password used when protect != off. Without it, a browser can still
    # READ (in writes mode) but cannot obtain a control session — set it before exposing
    # the dashboard for remote control. Machines use tokens and ignore this.
    ui_password: str | None = None

    @model_validator(mode="after")
    def _password_present_for_protection(self):
        if self.protect in ("writes", "all") and self.ui_password is not None:
            if len(self.ui_password) < 8:
                raise ValueError("ui_password must be at least 8 characters")
        return self

    @model_validator(mode="after")
    def _unique_tokens(self):
        secrets_seen = [t.token for t in self.tokens]
        if len(secrets_seen) != len(set(secrets_seen)):
            raise ValueError("duplicate API tokens configured")
        return self


class NotifyConfig(BaseModel):
    # Push alerts via ntfy (free, no account). Create a hard-to-guess topic and either
    # subscribe in the ntfy app or point it at your own server.
    ntfy_topic: str | None = None
    ntfy_server: str = "https://ntfy.sh"
    # External dead-man heartbeat (e.g. healthchecks.io): pinged every poll cycle. If the
    # pings stop (Pi/WiFi/ISP/power dead), THAT service alerts you — silence = alarm, and
    # it doesn't share fate with the Pi (fusion audit risk 3c). Optional now that the Railway
    # hub is itself a dead-man.
    heartbeat_url: str | None = None
    # Email alerts via Resend (resend.com) — a second channel alongside ntfy for the SERIOUS
    # alerts (high/urgent only; recoveries stay push-only). Needs a Resend API key. Without a
    # verified sender domain, Resend delivers only to your own account email, which is exactly
    # right for personal alerts — set resend_to to that address.
    resend_api_key: str | None = None
    resend_to: str | None = None
    resend_from: str = "A2W Alerts <onboarding@resend.dev>"


class AnalyticsConfig(BaseModel):
    # Read-only cloud mirror (fusion: keep control on the Funnel path; this is a separate,
    # out-of-control-loop analytics push). The Pi POSTs a throttled state snapshot to a
    # Vercel app (see analytics-mirror/); the cloud accumulates the time series. Best-effort:
    # if the endpoint is down, snapshots are skipped — this never affects control.
    endpoint_url: str | None = None   # e.g. https://a2w-mirror.vercel.app/api/ingest
    token: str | None = None          # shared secret sent as Bearer to the ingest endpoint
    interval_s: float = 60.0          # cloud doesn't need 20s granularity


class HubConfig(BaseModel):
    # Outbound WebSocket link to the Railway hub (relays the optimizer's setpoint-only
    # commands + latest state to the Vercel dashboard). Best-effort/additive: the Pi dials
    # OUT and holds the connection (no inbound port opened); if the hub is down, local LAN
    # and Funnel control are unaffected. Enabled only when BOTH url and token are set.
    url: str | None = None            # e.g. wss://a2w-hub.up.railway.app/pi
    token: str | None = None          # HUB_PI_TOKEN — sent as Authorization: Bearer <token>
    state_interval_s: float = 15.0    # how often to push a state frame while connected


class AppConfig(BaseModel):
    pumps: list[PumpConfig] = Field(min_length=1)
    guardrails: GuardrailConfig = GuardrailConfig()
    auth: AuthConfig = AuthConfig()
    notifications: NotifyConfig = NotifyConfig()
    analytics: AnalyticsConfig = AnalyticsConfig()
    hub: HubConfig = HubConfig()
    db_path: str = "bridge.db"
    ui_dir: str = "ui"
    modbus_timeout_s: float = 5.0  # generous: 2400 baud multi-register reads are slow

    @field_validator("guardrails", "auth", "notifications", "analytics", "hub", mode="before")
    @classmethod
    def _empty_section_to_default(cls, v):
        # a YAML section present but with everything commented out parses to null;
        # treat it as "use defaults" instead of failing to start
        return {} if v is None else v


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
    # atomic write: this box lives at a site whose defining problem is power outages —
    # a half-written JSON must not silently discard added pumps / gateway overrides
    path = _state_path(cfg)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def save_gateway_override(cfg: AppConfig, pump_id: str, host: str, port: int) -> None:
    data = _read_state(cfg)
    pump = next((p for p in cfg.pumps if p.id == pump_id), None)
    prior = data["overrides"].get(pump_id, {})
    data["overrides"][pump_id] = {"host": host, "port": port,
                                  "mac": pump.mac if pump else None}
    if "write_enabled" in prior:  # a gateway reassignment must not clobber the toggle
        data["overrides"][pump_id]["write_enabled"] = prior["write_enabled"]
    if pump and pump.added:  # keep the added-pump record current too
        save_added_pump(cfg, pump, _data=data)
        return
    _write_state(cfg, data)


def save_write_enabled(cfg: AppConfig, pump_id: str, enabled: bool) -> None:
    """Persist the UI-toggled write flag so it survives restarts. Lives in the same
    bridge-owned state file as gateway overrides — config.yaml stays owner-edited and
    its write_enabled value becomes the default that this override sits on top of."""
    data = _read_state(cfg)
    pump = next((p for p in cfg.pumps if p.id == pump_id), None)
    entry = data["overrides"].setdefault(pump_id, {})
    entry["write_enabled"] = enabled
    if pump and pump.mac and not entry.get("mac"):
        entry["mac"] = pump.mac  # same staleness guard as gateway overrides
    if pump and pump.added:
        pump.write_enabled = enabled
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
        if "host" in entry:  # entry may be write_enabled-only (no gateway override yet)
            pump.host = entry["host"]
            pump.port = entry.get("port", pump.port)
        if "write_enabled" in entry:
            pump.write_enabled = bool(entry["write_enabled"])
        if not pump.mac and entry.get("mac"):
            pump.mac = entry["mac"]  # adopted at assignment time; keep it across restarts
