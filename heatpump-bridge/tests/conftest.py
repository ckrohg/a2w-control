# @purpose: Shared fixtures. `span_transport` (#199) runs a SPAN suite twice: against the v1 REST fake, and against a
# panel with v1 REMOVED that only speaks v2 (MQTT eBus, sim/fake_span_v2.py) — the panel after 2026-12-31. The v1
# run uses the shipped default (transport "v1"); the v2 run uses the config the owner flips to later ("auto"). The
# same assertions on both prove the flip changes no behaviour. Tests about v1's wire format are marked `v1_only`.
from __future__ import annotations

import pytest

from bridge import span_local, span_v2
from sim import fake_span_v2
from sim.fake_span import FakeSpan


def pytest_configure(config):
    config.addinivalue_line("markers", "v1_only: exercises the v1 REST wire format; skipped on the v2 panel")


@pytest.fixture(params=["v1", "v2"])
def span_transport(request, monkeypatch):
    if request.param == "v2":
        if request.node.get_closest_marker("v1_only"):
            pytest.skip("v1 REST wire format")
        monkeypatch.setattr(FakeSpan, "DEFAULT_V1", False)
        monkeypatch.setattr(FakeSpan, "DEFAULT_V2", True)
        real_fetch = span_v2.SpanV2.fetch

        def fetch(self, wait=True):
            # the fake polls FakeSpan's dict every 20 ms; a test that mutates it and reads at once must not race that
            for ebus in list(fake_span_v2.LIVE):
                if self.broker and self.broker.endswith(f":{ebus.port}"):
                    ebus.flush(self)
            return real_fetch(self, wait)
        monkeypatch.setattr(span_v2.SpanV2, "fetch", fetch)
        real_init = span_local.SpanClient.__init__

        def init(self, *a, transport=None, **kw):   # every client in the suite runs the post-flip config
            real_init(self, *a, transport="auto", **kw)
        monkeypatch.setattr(span_local.SpanClient, "__init__", init)
    # a /set the fake panel ignores must not cost every test the production echo wait
    monkeypatch.setattr(span_v2, "ECHO_WAIT_S", 0.5)
    return request.param
