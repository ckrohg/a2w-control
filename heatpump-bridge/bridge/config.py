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
    # Comm-loss alert shaping (owner asks 2026-08-06, after a morning of 20-min WiFi flaps
    # each paging individually): brief dropouts are LOGGED (events/dashboard) but not
    # pushed. An ntfy PAGE fires for what's actionable:
    #   - continuously offline for offline_alert_min minutes (a real outage), or
    #   - flap_alert_count offline edges within flap_window_min (link degrading — the
    #     2026-08-06 pump-2 comm-board wedge announced itself exactly this way).
    # EMAIL is reserved for the intervention tier (owner: "equipment errors that require
    # intervention or a total prolonged outage"): equipment fault codes, a pump that has
    # NEVER been online (bench-day miswire, immediate), and outages that persist past
    # offline_email_min minutes. ntfy-paged-but-not-emailed events never hit the inbox.
    offline_alert_min: float = 10
    offline_email_min: float = 60
    flap_alert_count: int = 3
    flap_window_min: float = 60


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


MIN_OFF_FLOOR_S = 60.0   # owner decision 2026-10-18: the minimum off time for ANY toggle-off
# The owner allowed switching these OFF only for a power cycle. Whatever the configured allowlist
# says, they stay heat_pump=True (never two off at once) and can never be opted into a bare OPEN.
HEAT_PUMP_CIRCUITS = ("Air-Water 1", "Air-Water 2")
# The backup element (the failsafe) is close-only by NAME, independent of span.arm_circuit.
BACKUP_ELEMENT_CIRCUIT = "Buffer Tank"


class BreakerCircuit(BaseModel):
    """One SPAN circuit A2W may switch (bridge/span_control.py). Listing a circuit allows CLOSE
    (on) only; anything that turns power OFF is a per-circuit opt-in:
      allow_cycle — power_cycle: OPEN, hold >= min_off_s, CLOSE in a finally (the circuit is
                    always turned back on by the same action — owner decision 2026-10-18 for the
                    Air-Water 1/2 self-heal and human-initiated power cycles)
      allow_open  — a bare OPEN that stays off. Heat-pump circuits default to cycle-only so
                    nothing A2W does can leave a heat pump off indefinitely.
    heat_pump marks circuits of which at most ONE may be off at a time (A2W refuses to turn a
    second one off while another reads OPEN)."""
    name: str = Field(min_length=1)
    allow_cycle: bool = False
    allow_open: bool = False
    heat_pump: bool = False


def _default_breakers() -> list[BreakerCircuit]:
    return [BreakerCircuit(name="Air-Water 1", allow_cycle=True, heat_pump=True),
            BreakerCircuit(name="Air-Water 2", allow_cycle=True, heat_pump=True),
            BreakerCircuit(name="Buffer Tank")]   # backup element: close-only, always


class SpanConfig(BaseModel):
    # SPAN local-API poller (LAN-only instant circuit power) — the high-res half of the hybrid
    # backup-element logging; spanwatch's hourly cloud (planner side) is the always-there backbone.
    # Best-effort: a SPAN outage gaps only this series — control and the bridge are unaffected.
    # Enabled only when BOTH host and passphrase are set. The passphrase is the panel's On-premise
    # "home-owner passphrase" (SPAN app -> Settings -> On-premise); it lets the poller AUTO-RE-
    # REGISTER its bearer token headlessly, which is what makes the local link resilient (the manual
    # On-premise session's re-login was the old fragility). Keep it out of the repo — inject via
    # pi-bootstrap env like the hub/analytics tokens.
    host: str | None = None            # mDNS name, e.g. span-nj-2312-003t6.local
    ip_fallback: str | None = None     # last-known LAN IP, tried if the hostname won't resolve
    passphrase: str | None = None      # On-premise home-owner passphrase (enables auto-re-register)
    circuits: list[str] = ["Buffer Tank", "Air-Water 1", "Air-Water 2"]  # circuit NAMES to log
    poll_interval_s: float = 25.0
    down_alert_after_s: float = 4 * 3600.0  # alert once if logging has been down this long
    # Backup-element ARM control (see knowledge/reference/span-backup-arm-spec.md). A2W may CLOSE-ONLY
    # the arm_circuit's relay (make the failsafe AVAILABLE) when the owner has ARMED it — never opens.
    # `arm` is the config DEFAULT for the owner intent; the live intent is the persisted state file
    # bridge-data/span-arm.json (owner-set via /api/span/arm + the portal). Default DISARMED so the
    # bridge never wakes up armed. `arm_live=False` = SHADOW (Phase 1: log would-arm, toggle nothing).
    arm_circuit: str = "Buffer Tank"
    arm: bool = False           # default owner intent = DISARMED
    arm_live: bool = False      # False = shadow (no SPAN relay writes); True = live (Phase 2)
    arm_cooldown_s: float = 300.0  # anti-flap: min gap between arm actions
    # Remote breaker control (bridge/span_control.py) — the allowlist and its timings. The SPAN
    # app's cloud path cannot switch these circuits (2026-10-18); this goes to the panel's LOCAL
    # API from the Pi. min_off_s has a hard floor of 60 s (owner decision 2026-10-18).
    breakers: list[BreakerCircuit] = Field(default_factory=_default_breakers)
    min_off_s: float = MIN_OFF_FLOOR_S     # floor for any toggle-off (power_cycle hold, open->close)
    max_off_s: float = 600.0               # ceiling on a single power_cycle hold
    close_attempts: int = Field(default=4, ge=1, le=20)     # CLOSE tries inside the cycle
    close_retry_delay_s: float = Field(default=5.0, ge=0)   # gap between those tries
    reclose_interval_s: float = Field(default=60.0, gt=0)   # background re-close after they all fail

    @model_validator(mode="after")
    def _breaker_safety(self):
        if not (self.min_off_s >= MIN_OFF_FLOOR_S):  # also rejects NaN
            raise ValueError(f"span.min_off_s must be >= {MIN_OFF_FLOOR_S:g} s (owner decision 2026-10-18)")
        if not (self.min_off_s <= self.max_off_s <= 3600):
            raise ValueError("span.max_off_s must be within [min_off_s, 3600]")
        names = [b.name.strip() for b in self.breakers]
        if len(names) != len(set(names)):
            raise ValueError("span.breakers lists a circuit twice")
        for b in self.breakers:
            if b.name.strip() in HEAT_PUMP_CIRCUITS and not b.heat_pump:
                raise ValueError(f"span.breakers: '{b.name}' is a heat-pump circuit — heat_pump must be true")
            if b.heat_pump and b.allow_open:
                raise ValueError(f"span.breakers: '{b.name}' is a heat-pump circuit — power cycle only, "
                                 "never allow_open (owner decision 2026-10-18)")
            # The backup element is the failsafe: A2W may make it AVAILABLE, never take it away
            # (span-backup-arm-spec.md). No config can opt it into an OFF action.
            if b.name.strip() in (self.arm_circuit.strip(), BACKUP_ELEMENT_CIRCUIT) \
                    and (b.allow_cycle or b.allow_open):
                raise ValueError(f"span.breakers: '{b.name}' is the backup element "
                                 "(arm_circuit) — it stays close-only")
        return self


class SelfHealConfig(BaseModel):
    # #189 (owner decision 2026-10-18): power-cycle a heat pump's SPAN circuit when it sits in an
    # equipment fault a power cycle clears (E21 by default) — bridge/self_heal.py. Fault trigger
    # only: the Pi cannot see the HBX stage call. Default SHADOW: `live: false` (the issue's
    # self_heal_live) logs and pages "would cycle" and switches nothing until the owner flips it.
    enabled: bool = True                 # evaluate at all (shadow unless live)
    live: bool = False                   # True = actually power-cycle via span_control
    fault_codes: list[str] = ["E21"]     # equipment faults a breaker power cycle clears
    grace_min: float = Field(default=10.0, ge=1)        # fault active this long first
    max_attempts: int = Field(default=2, ge=1, le=5)    # per pump per window, then escalate
    window_h: float = Field(default=6.0, gt=0)
    verify_min: float = Field(default=15.0, ge=5, le=120)   # recovery must show within this
    off_s: float = MIN_OFF_FLOOR_S       # power-cycle hold (>= 60 s, and >= span.min_off_s)
    running_power_w: float = Field(default=500.0, gt=0)  # SPAN circuit power that means "running"
    # A pump whose circuit is not an allow_cycle heat-pump breaker, or an off_s outside the span
    # limits, is reported "unavailable" in /api/health.self_heal (and paged once when live) —
    # never a boot failure: the bridge also runs the setpoint path and must always start.
    # pump id -> SPAN circuit. VERIFY on the house: no record maps pump1/pump2 to the panel's
    # circuit names; a swapped map would cycle the healthy pump (self_heal refuses when the
    # "idle" pump's circuit draws running-level power, but that is a backstop, not the check).
    circuits: dict[str, str] = Field(default_factory=lambda: {"pump1": "Air-Water 1",
                                                              "pump2": "Air-Water 2"})
    # LIVE switching needs the owner to confirm the map above on the house (e.g. watch each
    # circuit's watts while one pump runs). Until then live=true is reported unavailable and
    # pages; shadow runs either way.
    circuits_verified: bool = False

    @field_validator("circuits", mode="after")
    @classmethod
    def _strip(cls, v: dict[str, str]) -> dict[str, str]:
        # names are matched stripped everywhere; normalise once so " Air-Water 1" can't pose as a
        # different circuit (two pumps on one circuit is reported by self_heal, not a boot error)
        return {pid: str(name).strip() for pid, name in v.items()}

    @model_validator(mode="after")
    def _floor(self):
        if not (self.off_s >= MIN_OFF_FLOOR_S):
            raise ValueError(f"self_heal.off_s must be >= {MIN_OFF_FLOOR_S:g} s (owner decision 2026-10-18)")
        return self


class AppConfig(BaseModel):
    pumps: list[PumpConfig] = Field(min_length=1)
    guardrails: GuardrailConfig = GuardrailConfig()
    auth: AuthConfig = AuthConfig()
    notifications: NotifyConfig = NotifyConfig()
    analytics: AnalyticsConfig = AnalyticsConfig()
    hub: HubConfig = HubConfig()
    span: SpanConfig = SpanConfig()
    self_heal: SelfHealConfig = SelfHealConfig()
    db_path: str = "bridge.db"
    ui_dir: str = "ui"
    modbus_timeout_s: float = 5.0  # generous: 2400 baud multi-register reads are slow

    @field_validator("guardrails", "auth", "notifications", "analytics", "hub", "span", "self_heal",
                     mode="before")
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
