# @purpose: READ-ONLY probe of the SPAN panel's v2 local interface (#199), run on the Pi:
#   uv run --with paho-mqtt --with pyyaml python deploy/span-v2-probe.py [--seconds 30] [--capture out.json]
# Registers a v2 client (passphrase from ~/bridge-data/config.yaml, never printed), fetches the panel CA, subscribes
# to ebus/5/# over TLS and reports: the register response's keys, the device types, the panel + one circuit's
# $description and property topics, message cadence, and v1 /circuits vs v2 side by side (ids, relay, power) for
# the circuits A2W uses. It PUBLISHES NOTHING (no /set) — it cannot switch a breaker. --capture writes the shapes
# sim/fake_span_v2.py is built from (values of secrets redacted).
from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.request
from collections import Counter
from pathlib import Path

import paho.mqtt.client as mqtt
import yaml

NAMES = ["Air-Water 1", "Air-Water 2", "Buffer Tank"]


def http(base, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json"} if body is not None else {}
    if token:
        h["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=data, method="POST" if body is not None else "GET", headers=h)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--capture")
    ap.add_argument("--state", default=str(Path.home() / "span-v2-probe"))
    a = ap.parse_args()
    cfg = yaml.safe_load(open(Path.home() / "bridge-data/config.yaml"))["span"]
    host, ip, pw = cfg.get("host"), cfg.get("ip_fallback"), cfg["passphrase"]
    base = f"http://{ip or host}"
    state = Path(a.state)
    state.mkdir(mode=0o700, exist_ok=True)
    out = {"config_host": host, "config_ip": ip}

    creds_p = state / "creds.json"
    if creds_p.exists():
        reg = json.loads(creds_p.read_text())
        out["register"] = "reused " + str(creds_p)
    else:
        st, raw = http(base, "/api/v2/auth/register", {"name": f"a2w-probe-{os.urandom(3).hex()}",
                                                        "description": "A2W #199 read-only probe",
                                                        "hopPassphrase": pw})
        reg = json.loads(raw or b"{}")
        out["register_status"] = st
        if st != 200:
            print(json.dumps(out | {"register_detail": reg}, indent=1))
            return 1
        fd = os.open(creds_p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(reg, f)
    out["register_keys"] = sorted(reg)
    out["register_public"] = {k: reg.get(k) for k in ("serialNumber", "hostname", "ebusBrokerHost",
                                                      "ebusBrokerMqttsPort", "ebusBrokerUsername", "tokenType")}
    out["broker_password_equals_passphrase"] = reg.get("ebusBrokerPassword") == pw
    st, ca = http(base, "/api/v2/certificate/ca")
    out["ca_status"] = st
    ca = ca.decode()

    devs, counts, first_seen = {}, Counter(), {}
    t0 = time.monotonic()

    def on_message(c, u, m):
        p = m.topic.split("/")
        if len(p) < 4:
            return
        d = devs.setdefault(p[2], {})
        d["/".join(p[3:])] = m.payload.decode("utf-8", "replace")
        counts[m.topic] += 1
        first_seen.setdefault(m.topic, round(time.monotonic() - t0, 2))

    results = {}
    for label, target in (("ip", ip), ("host", host)):
        if not target:
            continue
        ctx = ssl.create_default_context(cadata=ca)
        strict = bool(ctx.verify_flags & getattr(ssl, "VERIFY_X509_STRICT", 0))
        ctx.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"a2w-probe-{os.urandom(3).hex()}")
        c.username_pw_set(reg["ebusBrokerUsername"], reg["ebusBrokerPassword"])
        c.tls_set_context(ctx)
        rc = {}
        c.on_connect = lambda cl, u, f, r, p=None: (rc.update(rc=str(r)), cl.subscribe("ebus/5/#", qos=0))
        c.on_message = on_message if label == "ip" else (lambda *x: None)
        try:
            c.connect(target, int(reg.get("ebusBrokerMqttsPort") or 8883), keepalive=30)
            c.loop_start()
            time.sleep(a.seconds if label == "ip" else 3)
            c.disconnect()
            c.loop_stop()
            results[label] = {"connack": rc.get("rc"), "strict_was_set": strict}
        except Exception as e:  # noqa: BLE001
            results[label] = {"error": repr(e), "strict_was_set": strict}
    out["mqtt"] = results
    out["python"] = sys.version.split()[0]

    types = Counter((json.loads(d.get("$description") or "{}") or {}).get("type") for d in devs.values())
    out["device_types"] = dict(types)
    panel_id = next((k for k, d in devs.items()
                     if "distribution-enclosure" in (d.get("$description") or "")), None)
    by_name = {d.get("info/name"): k for k, d in devs.items() if d.get("info/name")}
    out["panel_id"] = panel_id
    out["panel"] = devs.get(panel_id)
    out["circuits"] = {n: {"id": by_name.get(n), **(devs.get(by_name.get(n)) or {})} for n in NAMES}
    window = a.seconds
    out["cadence_msgs_per_min"] = {
        "total": round(sum(counts.values()) / window * 60, 1),
        **{t.split("/", 3)[3] + "@" + next((n for n, k in by_name.items() if k == t.split("/")[2]), t.split("/")[2]):
           round(n / window * 60, 1) for t, n in counts.items()
           if t.split("/")[2] in [by_name.get(x) for x in NAMES] + [panel_id] and n > 1}}
    out["retained_burst_s"] = max([v for v in first_seen.values() if v < 5] or [0])

    tok_p = Path.home() / "bridge-data/span-local-token"
    if tok_p.exists():
        st, raw = http(base, "/api/v1/circuits", token=tok_p.read_text().strip())
        v1 = json.loads(raw or b"{}").get("circuits", {}) if st == 200 else {}
        out["v1_status"] = st
        out["v1_vs_v2"] = {}
        for n in NAMES:
            c1 = next((c for c in v1.values() if (c.get("name") or "").strip() == n), {})
            d2 = devs.get(by_name.get(n)) or {}
            out["v1_vs_v2"][n] = {"v1_id": c1.get("id"), "v2_id": by_name.get(n),
                                  "v1_relay": c1.get("relayState"), "v2_relay": d2.get("switch/relay"),
                                  "v1_power": c1.get("instantPowerW"), "v2_power": d2.get("meter/active-power"),
                                  "v1_ctl": c1.get("isUserControllable"),
                                  "v2_ctl": d2.get("switch/relay-controllable")}
        out["v1_circuit_keys"] = sorted(next(iter(v1.values()), {}))
    print(json.dumps(out, indent=1, default=str))

    if a.capture:
        aw = devs.get(by_name.get("Air-Water 1")) or {}
        pd = json.loads(devs[panel_id]["$description"])
        lug_ids = [k for k in (pd.get("children") or []) if "lugs" in (devs.get(k, {}).get("$description") or "")]
        props = {k: v for k, v in devs[panel_id].items() if not k.startswith("$")}
        for k in ("status/postal-code", "status/wifi-ssid"):
            if k in props:
                props[k] = "redacted"
        cap = {"source": f"SPAN panel {reg.get('serialNumber')}, ebus/5 tree recorded READ-ONLY "
                         f"{time.strftime('%Y-%m-%d')} by deploy/span-v2-probe.py. Postal code and Wi-Fi SSID redacted.",
               "serial": reg.get("serialNumber"),
               "register_keys": sorted(reg),
               "panel": {"$description": {**pd, "children": []}, "properties": props, "heartbeat": "power-flows/grid"},
               "circuit": {"$description": json.loads(aw["$description"]),
                           "properties": {k: v for k, v in aw.items() if not k.startswith("$")}},
               "lugs": {"$description": json.loads(devs[lug_ids[0]]["$description"]) if lug_ids else {},
                        "ids": lug_ids}}
        Path(a.capture).write_text(json.dumps(cap, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
