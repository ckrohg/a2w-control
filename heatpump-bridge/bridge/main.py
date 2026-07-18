# @purpose: FastAPI app factory. Lifespan opens the SQLite store and starts one poller
# per configured pump; serves the static UI at /. Run: uvicorn bridge.main:app
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .api import router
from .auth import UI_COOKIE, cookie_secure, load_or_create_ui_secret, mint_session
from .config import AppConfig, load_config
from .exporter import Exporter
from .guardrails import SetpointGuard
from .hub_client import HubClient
from .poller import PumpPoller
from .scheduler import Scheduler
from .span_local import SpanLocalPoller
from .store import Store


class NoCacheStaticFiles(StaticFiles):
    """Serve the UI with Cache-Control: no-cache so browsers always revalidate.
    ETags make that a cheap 304 on the LAN — and it means every auto-update's new
    UI shows up on the next page load instead of after a mystery hard-refresh."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


def create_app(config: AppConfig | None = None) -> FastAPI:
    cfg = config or load_config()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store = Store(cfg.db_path)
        await store.open()
        guard = SetpointGuard(cfg.guardrails)
        pollers = {p.id: PumpPoller(p, cfg, store, guard) for p in cfg.pumps}

        async def persist_gateway(pump_id: str, host: str, port: int):
            from .config import save_gateway_override
            save_gateway_override(cfg, pump_id, host, port)

        for poller in pollers.values():
            poller.on_gateway_change = persist_gateway
        app.state.pollers = pollers
        app.state.config = cfg
        app.state.store = store
        app.state.guard = guard
        app.state.persist_gateway = persist_gateway
        for poller in pollers.values():
            await poller.start()
        scheduler = Scheduler(store, pollers, heartbeat_url=cfg.notifications.heartbeat_url)
        scheduler.start()
        exporter = Exporter(cfg.analytics, pollers, store, db_path=cfg.db_path)
        exporter.start()
        hub_client = HubClient(cfg.hub, pollers)
        hub_client.start()

        async def span_notify(title, message, priority="default"):
            from . import notify
            await notify.ntfy(cfg.notifications, title=title, message=message, priority=priority)
        span_poller = SpanLocalPoller(
            cfg.span, store, notify=span_notify,
            token_path=str(Path(cfg.db_path).resolve().parent / "span-local-token"))
        span_poller.start()
        app.state.span_poller = span_poller

        yield
        await span_poller.stop()
        await hub_client.stop()
        await exporter.stop()
        await scheduler.stop()
        for poller in pollers.values():
            await poller.stop()
        await store.close()

    app = FastAPI(title="heatpump-bridge", lifespan=lifespan)
    # config + UI secret available before startup so the auth deps and cookie middleware
    # work for any request (lifespan re-sets config with the poller-wired copy).
    app.state.config = cfg
    app.state.ui_secret = load_or_create_ui_secret(Path(cfg.db_path).resolve().parent)

    @app.middleware("http")
    async def _ui_session_cookie(request, call_next):
        response = await call_next(request)
        # Auto-mint a browser session ONLY when protection is off (LAN-first convenience).
        # When protect is on, a session must be earned via POST /api/session (password) —
        # otherwise anyone who can load the page would get control for free. The cookie is
        # a signed, expiring token, never the raw server secret.
        if (app.state.config.auth.protect == "off"
                and request.url.path in ("/", "/index.html")
                and UI_COOKIE not in request.cookies):
            response.set_cookie(
                UI_COOKIE, mint_session(app.state.ui_secret), httponly=True,
                samesite="strict", secure=cookie_secure(request),
                max_age=31536000, path="/")
        return response

    app.include_router(router)

    ui_dir = Path(cfg.ui_dir)
    if ui_dir.is_dir():
        app.mount("/", NoCacheStaticFiles(directory=ui_dir, html=True), name="ui")
    return app


app = create_app()
