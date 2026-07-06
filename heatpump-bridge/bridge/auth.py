# @purpose: API authentication for machine consumers (e.g. TempIQ) and remote control.
# Credentials:
#   - Bearer tokens (auth.tokens) — machines. Each carries a `source` audit label and a
#     read/write scope. The resolved source is the audit identity; clients cannot spoof it.
#   - A UI session cookie — a SIGNED, EXPIRING token (never the raw server secret). Under
#     protect=off it is auto-minted on page load (LAN-first convenience). Under
#     protect=writes/all it is minted ONLY after a successful password login
#     (POST /api/session) — so exposing the URL publicly never hands out control for free.
# Enforcement: auth.protect = off (default) | writes | all. Every write still passes the
# full guardrail stack (clamp, verify, identity, rate limit, write_enabled) — a valid
# credential is necessary, never sufficient, to move a pump.
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, Request

UI_COOKIE = "a2w_ui"
SESSION_TTL_S = 30 * 86400  # 30-day browser session


@dataclass
class Principal:
    source: str          # audit identity; overrides any body-provided source
    can_write: bool
    authenticated: bool   # True if a token/session validated


def load_or_create_ui_secret(data_dir: Path) -> str:
    """Persistent per-install secret used to SIGN UI session tokens (it is never sent to
    a client). Created 0o600 atomically; falls back to an ephemeral per-process secret if
    the data dir is unwritable."""
    path = data_dir / "ui-session.key"
    try:
        if path.exists():
            existing = path.read_text().strip()
            if existing:
                return existing
    except OSError:
        return secrets.token_hex(32)
    secret = secrets.token_hex(32)
    try:
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secret)
        return secret
    except FileExistsError:
        return path.read_text().strip() or secret  # lost a create race; use the winner
    except OSError:
        return secret


# --- signed session tokens ----------------------------------------------------------
def _sign(secret: str, exp: int) -> str:
    return hmac.new(secret.encode(), f"ui:{exp}".encode(), hashlib.sha256).hexdigest()


def mint_session(secret: str, ttl_s: int = SESSION_TTL_S) -> str:
    exp = int(time.time()) + ttl_s
    return f"{exp}.{_sign(secret, exp)}"


def valid_session(secret: str, token: str | None) -> bool:
    if not token or "." not in token:
        return False
    exp_str, _, sig = token.partition(".")
    try:
        exp = int(exp_str)
    except ValueError:
        return False
    if exp < time.time():
        return False
    return hmac.compare_digest(sig, _sign(secret, exp))


def cookie_secure(request: Request) -> bool:
    """Set the Secure flag when the request arrived over HTTPS (directly or via a
    TLS-terminating tunnel that forwards X-Forwarded-Proto). Left off for plain-HTTP LAN
    so the local dashboard still works."""
    if request.url.scheme == "https":
        return True
    return request.headers.get("x-forwarded-proto", "").lower() == "https"


# --- login brute-force throttle (public /api/session) -------------------------------
_fail_times: list[float] = []


def register_login_failure() -> None:
    now = time.time()
    _fail_times.append(now)
    del _fail_times[: max(0, len(_fail_times) - 50)]


def login_locked() -> bool:
    now = time.time()
    recent = [t for t in _fail_times if now - t < 60]
    return len(recent) >= 10  # >10 failures/min across all clients -> cool down


# --- request identification ---------------------------------------------------------
def _bearer(request: Request) -> str | None:
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[7:].strip() or None
    return None


def _eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def resolve_principal(request: Request) -> Principal:
    """Identify the caller. Raises 401 on a presented-but-invalid token. Anonymous callers
    get an unauthenticated 'ui' principal — whether that's allowed is decided by require()."""
    state = request.app.state
    presented = _bearer(request)
    if presented is not None:
        for t in state.config.auth.tokens:
            if _eq(presented, t.token):
                return Principal(source=t.source, can_write=t.can_write, authenticated=True)
        raise HTTPException(401, "invalid API token")
    if valid_session(state.ui_secret, request.cookies.get(UI_COOKIE)):
        return Principal(source="ui", can_write=True, authenticated=True)
    return Principal(source="ui", can_write=True, authenticated=False)


def resolve_principal_safe(request: Request) -> Principal:
    try:
        return resolve_principal(request)
    except HTTPException:
        return Principal(source="anonymous", can_write=False, authenticated=False)


def require(scope: str):
    """FastAPI dependency factory. scope: 'read' | 'write'."""
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
