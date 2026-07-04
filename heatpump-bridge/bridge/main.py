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
from .store import Store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")


def create_app(config: AppConfig | None = None) -> FastAPI:
    cfg = config or load_config()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store = Store(cfg.db_path)
        await store.open()
        guard = SetpointGuard(cfg.guardrails)
        pollers = {p.id: PumpPoller(p, cfg, store, guard) for p in cfg.pumps}
        app.state.pollers = pollers
        for poller in pollers.values():
            await poller.start()
        yield
        for poller in pollers.values():
            await poller.stop()
        await store.close()

    app = FastAPI(title="heatpump-bridge", lifespan=lifespan)
    app.include_router(router)

    ui_dir = Path(cfg.ui_dir)
    if ui_dir.is_dir():
        app.mount("/", StaticFiles(directory=ui_dir, html=True), name="ui")
    return app


app = create_app()
