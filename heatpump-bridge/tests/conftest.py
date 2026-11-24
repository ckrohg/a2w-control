# @purpose: Shared fixtures. `span_transport` (#199) runs a SPAN suite three times:
#   - "v1":   the v1 REST fake on the explicit, deprecated fallback (transport "v1", kept for a few weeks in case a
#             firmware surprise needs it);
#   - "auto": a panel with v1 REMOVED that only speaks v2 (MQTT eBus, sim/fake_span_v2.py) — the panel after
#             2026-12-31 — on transport "auto", the Pi's config from the 2026-11-24 cutover until span.transport: v2 is set;
#   - "v2":   the same v2-only panel on the shipped default (transport unset → "v2"). At teardown every FakeSpan the
#             test built must have had no v1 request: the v1-removed fake answers v1 with 404 and the bridge's v1 id
#             lookup swallows that, so without this check a v1 leak under v2 would pass.
# The same assertions on all three prove the cutover changes no behaviour at the choke points (OpenPermit close-only,
# the backup-element arm path). Tests about v1's wire format are marked `v1_only` and run on "v1" only.
from __future__ import annotations

import pytest

from bridge import span_local, span_v2
from sim import fake_span_v2
from sim.fake_span import FakeSpan


def pytest_configure(config):
    config.addinivalue_line("markers", "v1_only: exercises the v1 REST wire format; skipped on the v2 panel")


@pytest.fixture(params=["v1", "auto", "v2"])
def span_transport(request, monkeypatch):
    if request.param in ("auto", "v2"):          # both run against the v2-only (v1 removed) panel
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
    # a /set the fake panel ignores must not cost every test the production echo wait
    monkeypatch.setattr(span_v2, "ECHO_WAIT_S", 0.5)
    panels: list[FakeSpan] = []
    real_panel_init = FakeSpan.__init__

    def panel_init(self, *a, **kw):
        real_panel_init(self, *a, **kw)
        panels.append(self)
    monkeypatch.setattr(FakeSpan, "__init__", panel_init)
    if request.param != "v2":  # "v2" leaves transport unset: every client runs the shipped default (DEFAULT_TRANSPORT)
        forced = request.param  # "v1": the explicit, deprecated fallback; "auto": the Pi's cutover config
        real_init = span_local.SpanClient.__init__

        def init(self, *a, transport=None, **kw):
            real_init(self, *a, transport=forced, **kw)
        monkeypatch.setattr(span_local.SpanClient, "__init__", init)
    yield request.param
    if request.param == "v2":
        for panel in panels:
            assert panel.v1_requests == [], f"v1 request under transport v2: {panel.v1_requests}"
