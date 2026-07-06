# @purpose: API authentication for machine consumers (e.g. TempIQ) and remote control.
# Two credential types:
#   - Bearer tokens (configured in auth.tokens) — for machines. Each carries a `source`
#     audit label and a read/write scope. The resolved source is what lands in the audit
#     log, so a client can never spoof its identity via the request body.
#   - A UI session cookie — minted for browsers that loaded the page (i.e. passed the
#     tunnel's own human auth). Keeps the dashboard seamless with no login of its own.
# Enforcement is opt-in via auth.protect: off (default) | writes | all. All existing
# write guardrails (clamp, read-back verify, identity, rate limit, write_enabled) still
# apply on top of whatever this layer allows — a valid control token is necessary, never
# sufficient, to move a pump.
from __future__ import annotations

import hmac
import secrets
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, Request

UI_COOKIE = "a2w_ui"


@dataclass
class Principal:
    source: str        # audit identity; overrides any body-provided source
    can_write: bool
    authenticated: bool  # True if a token/cookie validated


def load_or_create_ui_secret(data_dir: Path) -> str:
    """Persistent per-install UI session secret (so browser sessions survive restarts).
    Falls back to an ephemeral per-process secret if the data dir is unwritable."""
    path = data_dir / "ui-session.key"
    try:
        if path.exists():
            existing = path.read_text().strip()
            if existing:
                return existing
        secret = secrets.token_hex(32)
        path.write_text(secret)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return secret
    except OSError:
        return secrets.token_hex(32)


def _bearer(request: Request) -> str | None:
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[7:].strip() or None
    return None


def _eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def resolve_principal(request: Request) -> Principal:
    """Identify the caller. Raises 401 on a presented-but-invalid token (a failed auth
    attempt must not silently downgrade to anonymous). Anonymous callers get an
    unauthenticated 'ui' principal — whether that's allowed is decided by require()."""
    state = request.app.state
    presented = _bearer(request)
    if presented is not None:
        for t in state.config.auth.tokens:
            if _eq(presented, t.token):
                return Principal(source=t.source, can_write=t.can_write, authenticated=True)
        raise HTTPException(401, "invalid API token")
    cookie = request.cookies.get(UI_COOKIE)
    if cookie is not None and _eq(cookie, state.ui_secret):
        return Principal(source="ui", can_write=True, authenticated=True)
    return Principal(source="ui", can_write=True, authenticated=False)


def resolve_principal_safe(request: Request) -> Principal:
    """Non-raising variant for status endpoints (/health, /whoami) that must answer even
    when the caller presents a bad token."""
    try:
        return resolve_principal(request)
    except HTTPException:
        return Principal(source="anonymous", can_write=False, authenticated=False)


def require(scope: str):
    """FastAPI dependency factory. scope: 'read' | 'write'. Enforcement depends on
    auth.protect; a read-only token is always refused a write regardless of mode."""
    def dependency(request: Request) -> Principal:
        principal = resolve_principal(request)
        mode = request.app.state.config.auth.protect
        if scope == "write":
            if mode in ("writes", "all") and not principal.authenticated:
                raise HTTPException(401, "authentication required to control the pumps")
            if not principal.can_write:
                raise HTTPException(403, "this API token is read-only")
        elif scope == "read":
            if mode == "all" and not principal.authenticated:
                raise HTTPException(401, "authentication required")
        return principal
    return dependency
