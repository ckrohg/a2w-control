# SPAN local API v2: where it lives and how A2W uses it (#199)

The panel's own OpenAPI (firmware r202639) says v1 REST is removed on **2026-12-31**. That spec advertises
`version: v1+v2` but lists no v2 circuit paths, because v2 is not REST for circuits. It is MQTT on the panel.

## The interface

| Need | v1 (removed 2026-12-31) | v2 |
|---|---|---|
| Auth | `POST /api/v1/auth/register` → bearer token | `POST /api/v2/auth/register` `{name, description, hopPassphrase}` → `accessToken` plus `ebusBrokerUsername` / `ebusBrokerPassword` / `ebusBrokerHost` / `ebusBrokerMqttsPort` / `serialNumber` / `hostname` |
| Trust | none (plain HTTP) | `GET /api/v2/certificate/ca` → the panel's CA (PEM); MQTT over TLS on 8883 |
| Circuit list + power | `GET /api/v1/circuits` | subscribe `ebus/5/#` (Homie 5, parent/child). A device whose `$description.type` is `energy.ebus.device.circuit` is a circuit: `info/name`, `switch/relay` (`OPEN`/`CLOSED`), `switch/relay-controllable` (`true`/`false`), `meter/active-power` (W, a load reads **negative**, as v1 `instantPowerW` does) |
| Set relay | `POST /api/v1/circuits/{id}` `{"relayStateIn": {"relayState": …}}` | publish `OPEN`/`CLOSED` to `ebus/5/<circuit>/switch/relay/set`; read back on `switch/relay` |

On r202639 the broker username is the panel serial and the broker password equals the passphrase.
Python 3.13 rejects the panel's certificate ("Missing Authority Key Identifier") unless `ssl.VERIFY_X509_STRICT` is
cleared. Chain and hostname checks still apply. The cert verifies by the broker host name and by the panel's IP.

## How the bridge uses it

`bridge/span_v2.py` holds one persistent MQTT session (paho, started on first use). `bridge/span_local.SpanClient`
serves both transports behind the same interface, and every consumer keeps receiving the v1 `/circuits` shape.

## Rollout (owner decision 2026-10-29) — the config keys

Both keys live in the `span:` section of the Pi's live config, `~/bridge-data/config.yaml` (outside the repo: no
merge, tag or deploy changes it; back it up first, then restart `heatpump-bridge`).

| Step | Config | What it does |
|---|---|---|
| 1. Release (default) | `transport: v1` (or the key absent) | Exactly today's behaviour: v1 REST only, no v2 connection at all. |
| 2. Soak, a few days | `transport: v1` + `v2_soak: true` | Still v1 for every read and write. After each v1 read the bridge also reads the v2 tree and compares name, relay state and controllable per circuit. It never writes over v2, and a v2 failure never slows or fails the v1 read. Watch `/api/health.span.soak` (`compared`, `agree`, `disagree`, `last_disagreement`) and drift-check `[10]`. |
| 3. Flip, with the owner's OK | `transport: auto` (drop `v2_soak`) | v2 first for reads and writes, v1 as the fallback while the panel still serves it. |
| Later, optional | `transport: v2` | v2 only (no v1 attempts). Not required: `auto` already works after v1 is removed. |

drift-check `[10]` passes a pinned v1 until 2026-12-15 and fails after that; a soak disagreement fails it; in
`auto`/`v2`, a read answered by v1 fails it (v2 is failing).

- **Which transport answered** is in `/api/health.span` and in the hub frame (`span.transport`: `read`, `write`,
  `v2.connected`, `v2_error`, `soak`).
- **Writes are QoS 0.** paho re-sends QoS ≥ 1 publishes after a reconnect, even with a clean session, so a "lost"
  OPEN could land after the CLOSE that ended the cycle. Read-back and the CLOSE retries cover a lost QoS 0 write.
- **An OPEN that may have reached the panel is never re-sent over v1.** v1 is tried for an OPEN only when v2
  provably sent nothing (no session, or paho refused before the socket). A CLOSE does fall back to v1.
- **The OpenPermit choke point is unchanged.** `SpanClient._set_relay_sync` checks the permit once. Its recheck
  (expiry + guard) runs at whichever transport's dispatch boundary actually sends.
- **Unknown is never "down".** A silent session (no message for 90 s), a disconnected one, or a circuit whose
  `$state` is not `ready` reads as an error or `None`, never as OPEN or 0 W. Every (re)connect starts from an empty
  tree: until that connection's retained tree is complete (or 5 s after its SUBACK, for a declared property the
  panel never publishes), a read raises. Relay states from before an outage are never served as current.
- **Registration backs off.** A broker that refuses what the panel just issued used to mean a new panel client every
  10 minutes. Re-registering now waits 10 min, then 20, 40 … capped at 6 h. The state is persisted in
  `span-v2-register.json`, so a restart doesn't reset it. After 3 registrations in a row without a session,
  `/api/health.span…v2.auth_alarm` turns true and one record-tier event is written (`span_v2` /
  `v2_register_backoff`; `v2_register_ok` when it clears). After each registration the bridge deletes its own older
  `a2w-bridge-v2-*` clients (`DELETE /api/v2/auth/clients/{name}`); never the v1 client, 6bb's, or a probe.
- **The soak never delays v1.** Starting, re-registering or restarting the soak session (HTTP to the panel) runs on
  a background thread, never under the client lock that a v1 read or a relay write needs.
- **The CA is trust-on-first-use.** `GET /api/v2/certificate/ca` is plain HTTP; the PEM is pinned on disk after the
  first fetch, and re-fetched only when a session never comes up (a re-issued CA).
- **Circuit ids.** v2's device id for a circuit is the same 32-hex id v1 used (verified 2026-10-29: Air-Water 1
  `32a6a2a2…`, Air-Water 2 `c7f7ca8b…`, Buffer Tank `dfbc1200…`, identical in `span_readings` and on the eBus tree).
  Ids are still compared with dashes removed (`canon_id`), so a power-cycle record written under v1 recovers under v2
  even if a firmware update starts spelling them as dashed UUIDs.
- **Credentials** persist next to the v1 token (`bridge-data/span-v2-creds.json`, 0600; `span-v2-ca.pem`). A broker
  refusal re-registers from the passphrase (10-minute cooldown). A session that never connects is restarted after
  60 s on the other address with a freshly fetched CA.
- **6bb switches these breakers too** (owner decision). The tree is live, so a relay someone else switched shows up
  on the next read.

## What the real panel looks like (recorded read-only 2026-10-29, r202639)

- 19 children under the panel device `nj-2312-003t6`: 2 `energy.ebus.device.lugs` (`…-lugs-up`, `…-lugs-dn`) and
  17 circuits. A circuit's `$description.name` is its id; the human name is only in `info/name`.
- `switch/relay` is the enum `UNKNOWN,OPEN,CLOSED` (settable). `UNKNOWN` reads as unknown (`None`), never as off.
  Also published: `switch/relay-requester` (`NONE`, `USER`, …), `breaker/rating`, `meter/current`,
  `meter/imported-energy`, `load-shed/priority`, `pcs/*`.
- The panel streams about 1,900 messages a minute; each circuit's `meter/active-power` updates about every 2 s.
  The retained tree arrives within about 0.12 s of the SUBACK. A2W's client synced and read all 17 circuits in
  0.16 s.
- Idle heat pumps read `-5.9` W and `-9.0` W; v1 `span_readings` show the same sign (Air-Water 1 down to `-6557` W).
- On Python 3.11 `VERIFY_X509_STRICT` is not set by default; the session verified both by IP and with the broker
  name as SNI.

## Tests and the fake

`sim/fake_span_v2.py` is a real MQTT broker on TLS plus the panel's Homie tree, built from
`sim/span_v2_capture.json` (recorded read-only from the real panel by `deploy/span-v2-probe.py --capture`). A
`/set` is checked against the circuit's own published `$description`, as the v1 fake checks the OpenAPI schema
(#200). `tests/conftest.py` runs the breaker, self-heal, backup-gate and deliberate-stop suites twice: once on the v1
fake, once on a v2-only panel with v1 removed.

## Still to do on the real panel

The owner's release tag (no behaviour change), the soak, the flip to `auto`, then the Air-Water 2 power-cycle test
on v2 (issue #199, "Done when").
