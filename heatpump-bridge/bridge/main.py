# @purpose: FastAPI app factory. Lifespan opens the SQLite store and starts one poller
# per configured pump; serves the static UI at /. Run: uvicorn bridge.main:app
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .api import router
from .config import AppConfig, load_config
from .guardrails import SetpointGuard
from .poller import PumpPoller
from .scheduler import Scheduler
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
        scheduler = Scheduler(store, pollers)
        scheduler.start()
        yield
        await scheduler.stop()
        for poller in pollers.values():
            await poller.stop()
        await store.close()

    app = FastAPI(title="heatpump-bridge", lifespan=lifespan)
    app.include_router(router)

    ui_dir = Path(cfg.ui_dir)
    if ui_dir.is_dir():
        app.mount("/", NoCacheStaticFiles(directory=ui_dir, html=True), name="ui")
    return app


app = create_app()
