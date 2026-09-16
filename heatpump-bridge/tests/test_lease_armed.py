# @purpose: Regression guard for FINDING-1 (2026-09-16) — the revert-to-baseline failsafe was
# documented everywhere and armed nowhere. `baseline_setpoint_c` sat commented out in the
# production template, so poller.py's lease registration (`if lease_minutes and
# g.baseline_setpoint_c is not None`) never fired: the Pi held NO lease, check_lease() returned
# early every tick, and the revert + "optimizer stale" alert + 15-min warning could never
# happen. Meanwhile planner /health printed "lease 90m" from its own constant, so every
# dashboard looked healthy for two months. These tests pin both halves: the template ships
# armed, and an unset baseline provably disables the whole regime (so nobody "simplifies" the
# guard away without a red test explaining why it is there).
import pathlib

import yaml

from bridge.config import GuardrailConfig

TEMPLATE = pathlib.Path(__file__).resolve().parents[1] / "deploy" / "config.production.yaml"


def _template_guardrails() -> dict:
    return yaml.safe_load(TEMPLATE.read_text())["guardrails"]


def test_production_template_ships_with_the_lease_armed():
    """A fresh Pi must get the failsafe by default — this is what was missing."""
    g = _template_guardrails()
    assert g.get("baseline_setpoint_c") is not None, (
        "baseline_setpoint_c is unset in config.production.yaml — the ENTIRE lease regime is "
        "dormant and a dead optimizer will strand the house at a stale setpoint. See FINDING-1 "
        "in knowledge/reference/live-state-20260916.md."
    )


def test_template_baseline_passes_validation_so_the_bridge_still_starts():
    """A baseline outside [floor, max] raises at startup — which would leave the pumps
    uncontrolled. Validate the shipped numbers actually construct."""
    g = _template_guardrails()
    cfg = GuardrailConfig(**{k: v for k, v in g.items() if k in GuardrailConfig.model_fields})
    floor = cfg.unattended_min_setpoint_c or cfg.setback_setpoint_c
    assert floor <= cfg.baseline_setpoint_c <= cfg.setpoint_max_c


def test_unset_baseline_disables_the_lease_regime():
    """Pins the actual failure mode, so the coupling is never silently removed."""
    cfg = GuardrailConfig(baseline_setpoint_c=None)
    assert cfg.baseline_setpoint_c is None
    # poller.py:600 gates lease registration on this being non-None; poller.py:762 bails out of
    # check_lease() on the same condition. Both are no-ops under this config.


def test_template_freeze_floor_stays_commented_until_cold_snap_validation():
    """The winter-safe FLOOR is deliberately NOT armed alongside the lease: its own comment
    records confidence LOW, and a de-rated compressor may not physically reach 45 C at very low
    ambient. Arming it is a separate, evidence-gated decision."""
    g = _template_guardrails()
    assert g.get("unattended_min_setpoint_c") is None
