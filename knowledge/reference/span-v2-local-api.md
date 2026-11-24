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

## The config keys and the cutover

Both keys live in the `span:` section of the Pi's live config, `~/bridge-data/config.yaml` (outside the repo: no
merge, tag or deploy changes it; back it up first, then restart `heatpump-bridge`).

| `span.transport` | What it does |
|---|---|
| `v2` (**the default** since the cutover; the key may be absent) | v2 (MQTT on the panel) is the ONLY transport. Every read and write waits for the session; nothing is ever sent to v1 — not a register, not a read, not a relay write. |
| `auto` | v2 first for reads and writes, v1 REST as the fallback while the panel still serves it. In `auto` nothing waits on v2 while v1 can answer (a CLOSE above all); when v1 cannot, a read or a CLOSE waits for v2. |
| `v1` (**deprecated**) | v1 REST only, no v2 connection. Selectable by explicit config only, for a firmware surprise; the bridge logs `SPAN transport v1 is DEPRECATED … removes the v1 REST API on 2026-12-31` on every start and `/api/health.span.deprecated` (also in the hub frame) names it. With `v2_soak: true` the bridge also reads the v2 tree after each v1 read and compares name, relay state and controllable per circuit (read-only, never a v2 write; `/api/health.span.soak`). `v2_soak` is ignored under any other transport. |

### Cutover plan (#199)

The rollout so far (owner decision 2026-10-29): the release shipped pinned to `v1`, then `v2_soak: true` ran read-only
on the Pi from 2026-11-01 (`release-20261101-1`), then the flip to `auto`.

| Step | Where | What |
|---|---|---|
| 1. Auto soak | the Pi's config, release tag around 2026-11-24 | `transport: auto`. v2 answers every read and relay write; v1 is only the fallback. Clean = `/api/health.span.read` and `.write` stay `v2`, `v2_error` null, drift-check `[10]` passes, and the Air-Water 2 power-cycle test lands on v2 (issue #199 "Done when"). |
| 2. This change (branch `owner/span-v2-default-199`) | the repo; the owner merges it after about a week of clean `auto` and ships it in its own December release tag | The default becomes `v2` (`SpanConfig.transport`, `SpanClient`, `SpanLocalPoller`). `auto` is unchanged. `v1` stays selectable as an explicit, deprecated fallback that warns on every start; the v1 code is not deleted yet. An absent key is now `v2`, so a rollback is an explicit `transport: v1`. Every safety invariant stays at its choke point: the OpenPermit close-only rule in `SpanClient._set_relay_sync`, the backup-element arm path (close-only, never holds a permit), the guards in `BreakerController`. The test suites run every SPAN suite three times: a v2-only panel on the default and on `auto`, and the v1 fake on the explicit `v1` fallback. |
| 2b. Set `v2` | the Pi's config, by 2026-12-31 | Set `span.transport: v2` explicitly; it works on every release since #239, whatever tag the Pi runs. Do **not** just remove the key: on any release before step 2 an absent key is `v1`, so a slipped or older tag would leave the bridge unable to read or switch the panel from 2026-12-31. Not after 2026-12-31 on `auto`: with v1 gone every fallback attempt is latency and log noise. Optional cleanup, later: remove the key once the Pi is confirmed on a release that includes step 2 (#313). |
| 3. Remove v1 | the repo, after 2026-12-31 | Delete the v1 paths in `span_local.py` (`_register_sync`, `_circuits_sync`, `_v1_*`, `_soak_*`, the `v1` and `auto` values, `v2_soak`), the v1 run of `tests/conftest.py`'s `span_transport` fixture and the `v1_only` tests, and the v1 endpoints of `sim/fake_span.py`. `auto` goes with it: with no v1 to fall back to it is `v2`. |

drift-check `[10]` passes a pinned v1 until 2026-12-15 and fails after that; a soak disagreement fails it; in
`auto`/`v2`, a read answered by v1 fails it (v2 is failing); mode `auto` fails it from 2026-12-31 (set `span.transport: v2`).

- **Which transport answered** is in `/api/health.span` and in the hub frame (`span.transport`: `read`, `write`,
  `v2.connected`, `v2_error`, `soak`).
- **Writes are QoS 0.** paho re-sends QoS ≥ 1 publishes after a reconnect, even with a clean session, so a "lost"
  OPEN could land after the CLOSE that ended the cycle. Read-back and the CLOSE retries cover a lost QoS 0 write.
- **An OPEN that may have reached the panel is never re-sent over v1.** v1 is tried for an OPEN only when v2
  provably sent nothing (no session, or paho refused before the socket). A CLOSE does fall back to v1.
- **The OpenPermit choke point is unchanged.** `SpanClient._set_relay_sync` checks the permit once. Its recheck
  (expiry + guard) runs at whichever transport's dispatch boundary actually sends.
- **Unknown is never "down".** A silent session (no message for 10 s; the panel streams about 30 a second and paho
  needs up to ~60 s to notice a half-open link), a disconnected one, or a circuit whose `$state` is not `ready` reads
  as an error or `None`, never as OPEN or 0 W. Every (re)connect starts from an empty tree: until that connection's
  retained tree is complete, a read raises. Complete means every child the panel lists has a description and a
  state, with no exception: a child without them would be a whole circuit missing from the read, not one reading
  unknown. Only a declared property the panel never publishes is forgiven, 5 s after the SUBACK. Relay states from
  before an outage are never served as current. An OPEN of the backup element also refuses a tree whose last message
  is more than 3 s old.
- **Never wait while v1 can take it, always when it can't.** In `auto` a CLOSE doesn't wait for the session: if v2 is
  not usable right now it starts on a background thread and the CLOSE goes to v1 at once. If v1 can't take it either
  (removed, on cooldown, unreachable) the CLOSE then waits for v2, because a safety write is never refused when it could
  wait. Reads behave the same, and also wait during a process's first bring-up, outside the client lock, so a bridge
  restart doesn't land on v1. An OPEN always waits (it is not a safety write), and so does everything under
  `transport: v2` — the default since the cutover, where there is nothing else to send on. Under v2 the #239 point
  above (a restart's CLOSE never queues behind the first-bring-up wait) does not hold: the wait runs inline under the
  client lock, so during a panel outage a CLOSE queues behind a read's `CONNECT_WAIT_S` (15 s). That is acceptable,
  because the CLOSE needs the same session.
- **Registration backs off.** A broker that refuses what the panel just issued used to mean a new panel client every
  10 minutes. Re-registering now waits 10 min, then 20, 40 … capped at 6 h. The state is persisted in
  `span-v2-register.json`, so a restart doesn't reset it. After 3 registrations in a row without a session,
  `/api/health.span…v2.auth_alarm` turns true and one record-tier event is written (`span_v2` /
  `v2_register_backoff`; `v2_register_ok` when it clears). After each registration the bridge deletes its own older
  `a2w-bridge-v2-*` clients (`DELETE /api/v2/auth/clients/{name}`); never the v1 client, 6bb's, or a probe.
- **The soak never delays v1.** Starting, re-registering or restarting the soak session (HTTP to the panel) runs on
  a background thread, never under the client lock that a v1 read or a relay write needs.
- **The CA is trust-on-first-use.** `GET /api/v2/certificate/ca` is plain HTTP; the PEM is pinned on disk after the
  first fetch, and asked for again only after 60 s with no session, new or long-running (a re-issued CA). The panel
  rebooted itself on 2026-10-14, probably for a firmware update, and after v1 is removed a stale CA would leave it
  unreadable. A different PEM is accepted, so that case heals, and recorded once as a `span_v2` / `v2_ca_changed` event
  (record tier; `/api/health.span…v2.ca_replaced_at`). A firmware update explains that event; without one, something else
  answered for the panel on the LAN.
- **Circuit ids.** v2's device id for a circuit is the same 32-hex id v1 used (verified 2026-10-29: Air-Water 1
  `32a6a2a2…`, Air-Water 2 `c7f7ca8b…`, Buffer Tank `dfbc1200…`, identical in `span_readings` and on the eBus tree).
  Ids are still compared with dashes removed (`canon_id`), so a power-cycle record written under v1 recovers under v2
  even if a firmware update starts spelling them as dashed UUIDs.
- **Credentials** persist next to the v1 token (`bridge-data/span-v2-creds.json`, 0600; `span-v2-ca.pem`). A broker
  refusal re-registers from the passphrase (10-minute cooldown). After 60 s with no broker connection, whether it never
  connected or lost one, the bridge asks the panel for its CA. If the panel answers, the session restarts on the other
  address with that CA. If it doesn't, that's an outage (a panel reboot, the Pi's Wi-Fi): paho keeps reconnecting, the
  pinned CA stays, and the bridge asks again in 60 s.
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
(#200). `tests/conftest.py` runs the breaker, self-heal, backup-gate and deliberate-stop suites three times: on a
v2-only panel with v1 removed, on `auto` and on the default transport (`v2`, where teardown also asserts that no
FakeSpan saw a single v1 request); and on the v1 fake, on the explicit, deprecated `v1` fallback. `tests/test_span_v2.py` also proves the cutover on a panel that still serves both: the default resolves to
v2, `transport: v1` logs the deprecation warning, `auto` still prefers v2, and each relay-write path — the dashboard's
breaker control, the backup-element arm, the self-heal power cycle — lands on v2 while v1 is never asked.

## Still to do on the real panel

The `auto` soak on the Pi (release tag around 2026-11-24), the Air-Water 2 power-cycle test on v2 (issue #199, "Done
when"), then the owner merges the v2-default change (step 2 above) and cuts a tag before 2026-12-31. v1 is deleted
from the code after that date (step 3).
