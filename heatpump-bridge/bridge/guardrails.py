# @purpose: Write-path guardrails (handoff §6.4, non-negotiable): clamp with explicit
# rejection (never silent), per-pump rate limiting, and offline checks. Pure logic with an
# injectable clock so tests don't sleep.
from __future__ import annotations

import time
from typing import Callable

from .config import GuardrailConfig


class GuardrailError(Exception):
    def __init__(self, message: str, status_code: int):
        super().__init__(message)
        self.status_code = status_code


class SetpointGuard:
    def __init__(self, cfg: GuardrailConfig, clock: Callable[[], float] = time.monotonic):
        self.cfg = cfg
        self._clock = clock
        self._last_write: dict[str, float] = {}

    def validate(self, pump_id: str, value: float, *, online: bool, write_enabled: bool) -> None:
        """Raise GuardrailError unless this write is allowed right now."""
        if not write_enabled:
            raise GuardrailError(
                f"writes are disabled for {pump_id} (write_enabled: false)", 403)
        if not online:
            raise GuardrailError(
                f"{pump_id} is offline — refusing to queue a stale write", 503)
        if not (self.cfg.setpoint_min_c <= value <= self.cfg.setpoint_max_c):
            raise GuardrailError(
                f"setpoint {value}°C outside allowed range "
                f"{self.cfg.setpoint_min_c}–{self.cfg.setpoint_max_c}°C", 422)
        last = self._last_write.get(pump_id)
        if last is not None:
            elapsed = self._clock() - last
            if elapsed < self.cfg.min_write_interval_s:
                wait = round(self.cfg.min_write_interval_s - elapsed)
                raise GuardrailError(
                    f"rate limited — wait {wait}s between setpoint writes", 429)

    def record_write(self, pump_id: str) -> None:
        self._last_write[pump_id] = self._clock()
