# SPAN v2 cutover runbook: `transport: v1` → `auto` on the Pi (#199)

The procedure for flipping the bridge's SPAN transport; the design is in `span-v2-local-api.md`. Citations are
`file:function` under `heatpump-bridge/bridge/`. Lines dated 2026-11-20 come from issue #199, not from the code.

**Status 2026-11-20.** Soak has run 17 days: 37,531 comparisons, 37,530 agree, 1 disagreement (2026-11-13T19:20Z,
during a Wi-Fi blind spell, see §2). The owner has approved the flip to `auto`. SPAN removes v1 REST on 2026-12-31.

**Standing rule.** Never toggle "Air-Water 1", "Air-Water 2" or "Buffer Tank" as a test. Nothing below asks you to.

## 1. What the settings do

Both keys are in the `span:` section (`config.py:SpanConfig`): `transport: Literal["v1","auto","v2"]`, default `"v1"`,
and `v2_soak: bool`, default `False`. `span_local.py:SpanClient.__init__` builds a v2 session only when
`transport != "v1"`, and a soak session only when `transport == "v1" and v2_soak`: `v2_soak` is ignored in `auto` and `v2`,
and `/api/health.span.soak` is `null` there.

| Setting | Reads | Relay writes |
|---|---|---|
| `v1` | v1 REST only (`SpanClient._fetch_sync` → `_v1_circuits`). No v2 connection exists. | v1 only (`_v1_set_relay_sync`). |
| `v1` + `v2_soak: true` | v1 decides. After each good v1 read, `SpanClient._soak_compare` reads the v2 tree and compares `name`, `relayState`, `isUserControllable` per circuit. It never waits, never raises, never writes. **Power is not compared.** | v1 only. |
| `auto` | v2 first, v1 fallback, then v2 again with a wait (`_fetch_sync`). | v2 first, fallback rules below (`_set_relay_sync`). |
| `v2` | v2 only, waits for the session; a v2 failure is a failed read (`_fetch_sync`). | v2 only; no v1 attempt (`_set_relay_sync`). |

**`auto`, reads** (`SpanClient._fetch_locked`, `_fetch_sync`, `span_v2.py:SpanV2.fetch`). The first read after a bridge
start waits for the v2 session, up to `CONNECT_WAIT_S` (15 s), so a restart does not land on v1. Every later read
asks v2 without waiting: if the tree is not usable right now the read goes to v1 at once and a background thread
works on the session (`SpanV2._kick`). If v1 fails too, v2 gets the wait it was spared; if both fail the read raises.

**`auto`, writes** (`SpanClient._set_relay_sync`, `SpanV2.set_relay`; QoS 0, `OpenPermit` checks unchanged):
- CLOSE: sent over v2 if the session is usable, without waiting for bring-up. Not sent (`V2NotSent`), or sent but
  not echoed within `ECHO_WAIT_S` (5 s): v1 is tried. If v1 cannot take it and v2 had sent nothing, it waits for v2.
- OPEN: always waits for v2. v1 is tried only when v2 provably sent nothing. An OPEN that was published but not
  echoed raises and is **never** re-sent over v1; the controller's read-back decides (`span_control.py:_do_cycle`).

**Broker unreachable** (`SpanV2._usable_reason`, `_bring_up`). A session that is disconnected, has an incomplete
tree, or has had no message for `STALE_AFTER_S` (10 s) is unusable: `fetch` raises. It never reads as OPEN or 0 W.
- `auto`: v1 answers. `/api/health.span.read` becomes `"v1"` and `v2_error` says why. After `NEVER_UP_S` (60 s) the
  bridge asks the panel for its CA; if it answers, the session restarts on the other address (`span.host` ↔
  `span.ip_fallback`), otherwise paho keeps reconnecting.
- `v2`: the read fails. Breaker actions are refused 503 "SPAN panel unreachable on the LAN"
  (`span_control.py:BreakerController._run`), self-heal loses its panel read after `SPAN_FRESH_S` (120 s,
  `self_heal.py:_span`), and "SPAN local link down" goes out after `down_alert_after_s` (4 h,
  `SpanLocalPoller._maybe_alert_down`).
- `v1` + soak: `soak.unavailable` goes up by one and `soak.last_error` is set. Nothing else changes.

## 2. Pre-flip checklist

`/api/health` needs no auth (`api.py:health`). On the Pi:

```bash
curl -s http://127.0.0.1:8000/api/health \
  | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["span"], indent=1))' \
  | tee /home/admin/span-soak-final-$(date +%Y%m%d).json
```

**Save this output.** The soak counters live in memory (`SpanClient._soak_stats`, started at `soak.since`) and the
restart in §3 erases them. Read, all from `SpanLocalPoller.status` → `SpanClient.transport_status`:

| Field | Want | Source |
|---|---|---|
| `span.mode` | `"v1"` | `transport_status` |
| `span.read`, `span.last_ok_ts` | `"v1"`; `last_ok_ts` under a minute old (poll every 25 s) | `SpanLocalPoller.poll_once` |
| `span.soak.compared` | large; equals `agree + disagree` | `_soak_compare` |
| `span.soak.disagree` | every one explained (see below) | `_soak_compare` |
| `span.soak.unavailable` | v1 reads where the v2 tree was not usable, so nothing was compared. Some are expected (start-up, Wi-Fi). Read `soak.last_error` for the latest reason. No pass threshold is set in the code. | `_soak_compare` |
| `span.soak.last_disagreement` | `{ts, diffs}`; `date -u -d @<ts>` should give the known 2026-11-13T19:20Z | `_soak_compare` |
| `span.soak.v2.connected`, `.synced` | both `true` | `SpanV2.status`, `_synced` |
| `span.soak.v2.last_message_age_s` | a few seconds; over 10 is stale | `SpanV2.status`, `STALE_AFTER_S` |
| `span.soak.v2.auth_alarm`, `.register_strikes`, `.error` | `false`, `0`, `null` | `SpanV2.status` |

Before any restart, confirm no breaker action is running: no pump "power-cycling" in `/api/health.self_heal`, and
`/api/span/circuits` (read auth) has `busy: null`, `pending_close: []` (`BreakerController.snapshot`).

**Real disagreement or blind spell?** `_soak_compare` treats `None`, `False` and `""` as one value
(`(a.get(k) or None) != (b.get(k) or None)`), so a diff always has a definite value on at least one side.

- **Real, stop and investigate:** both sides definite and different (`relayState v1='OPEN' v2='CLOSED'`); a `name`
  difference; `<circuit>: missing on v2`; `isUserControllable` differing while v2's `relayState` is definite; or
  `disagree` still climbing poll after poll.
- **Blind spell, expected:** v2 shows *nothing* where v1 shows something: `relayState v1='OPEN' v2=None` with
  `isUserControllable v1=True v2=False` on the same circuit. That pair is what `HomieTree.circuits` returns for a
  circuit whose `$state` is not `ready`. The 2026-11-13T19:20Z entry has this shape and coincides with the Pi's Wi-Fi
  drop that day. Whether the circuit was in fact not `ready` then is not determined from the code.
- **Timing skew, possible:** the v1 read and the v2 tree are not taken at the same instant, and 6bb also switches
  these breakers. One poll with two definite values at the time of a known switch (`span_breaker` events) is skew.
  This is an inference from the read order in `_fetch_sync`, not a case the code labels.

`scripts/drift-check.sh` `[10]` fails on any `soak.disagree > 0`, so it fails today on the one known entry. That
clears with the flip (no soak in `auto`).

## 3. The flip

The live config is `/home/admin/bridge-data/config.yaml` on the Pi (user `admin`), outside the repo. Back it up first:

```bash
cp -p /home/admin/bridge-data/config.yaml /home/admin/bridge-data/config.yaml.bak-$(date +%Y%m%d)-v2auto
grep -n -A12 '^span:' /home/admin/bridge-data/config.yaml     # find transport / v2_soak
```

Change only these lines (whether a `transport:` line exists today is not determined from the repo; absent = `v1`):

```yaml
span:
  transport: auto      # was: transport: v1, or absent
  # v2_soak: true      # delete or comment out; it is ignored unless transport is v1
```

```bash
diff /home/admin/bridge-data/config.yaml.bak-$(date +%Y%m%d)-v2auto /home/admin/bridge-data/config.yaml
sudo systemctl restart heatpump-bridge
```

`transport` is a `Literal`: a typo fails validation in `config.py:load_config`. What the service does then is not
determined from the code; if `/api/health` does not answer, restore the backup and restart.

**Within 2 minutes**, re-run the §2 curl (without the `tee`):

| Field | Expect | Why |
|---|---|---|
| `span.mode` | `"auto"` | `transport_status` |
| `span.read` | `"v2"`, `read_ts` and `last_ok_ts` under a minute old | first read waits for v2 (`_fetch_locked`) |
| `span.write`, `write_ts` | `null` | in memory, reset by the restart; set by the first relay write (`_note`) |
| `span.v2.started`, `.connected`, `.synced` | all `true` | `SpanV2.status` |
| `span.v2.broker` | `<span.host>:8883` (the first start uses `span.host`) | `SpanV2._start` |
| `span.v2.last_message_age_s` | under 10, normally near 0 | panel streams continuously |
| `span.v2.error`, `span.v2_error`, `span.v1_error`; `span.v2.register_strikes`, `.auth_alarm` | `null`; `0`, `false` | `SpanV2.status` |
| `span.soak` | `null` | no soak outside `v1` |

No new panel registration is expected: the session reuses the `span-v2-creds.json` and `span-v2-ca.pem` the soak
wrote beside the v1 token (`SpanV2._ensure_creds`, `_ensure_ca`; state dir from `SpanClient.__init__`). Top-level
`healthy` reflects the pumps, not SPAN; `self_heal` and `backup_fallback` should look as before.

**If `span.read` is `"v1"`:** v2 did not come up and the fallback is working. Nothing is broken today. Read
`span.v2_error`, wait a few polls (the session keeps retrying in the background), and if it does not turn to `"v2"`
roll back (§5) and journal the error. drift-check `[10]` fails while a read in `auto` is answered by v1.

## 4. Verifying the write path over v2

**The code offers no safe way to test a v2 write.** Specifically:

- No dry-run: `SpanClient.set_relay`, `SpanV2.set_relay` and `BreakerController.execute` have no such flag.
- The shadow modes (`self_heal.live`, `backup_fallback.live`, `span.arm_live` all `false`) send nothing on any transport.
- The default allowlist is the three heating circuits only (`config.py:_default_breakers`). The Pi's live
  `span.breakers` is not determined from the repo.
- A `close` on a circuit that already reads CLOSED is sent, not skipped (`BreakerController._do_close`), and would
  leave `span.write: "v2"`. It proves little: `SpanV2.set_relay` returns as soon as the tree shows the wanted state,
  which it already does, so it shows that paho accepted the publish, not that the panel acted on a `/set`. It could
  only go to Air-Water 1/2 (Buffer Tank is kept OPEN; a close there is a real change). How the panel treats a
  redundant CLOSED is not determined from the code. It is a relay command to a heating circuit: **do not do it.**
- The code would accept a non-heating circuit in `span.breakers` with `allow_cycle` or `allow_open`
  (`BreakerController._validate`). A real OFF/ON there is the only thing that would prove the panel honours a v2
  `/set`. It is a config change and a load drop the owner has not decided: not part of this runbook.
- `deploy/span-v2-probe.py` publishes nothing. The tests run every breaker path against a v2-only fake
  (`tests/conftest.py`): evidence about the bridge, not about the real panel.

As far as the repo records, v2 has only ever been *read* on the real panel: the first real action is the first proof.
**Owner decision, not made here:** `span-v2-local-api.md` ("Still to do") and #199's "Done when" list an Air-Water 2
power-cycle test on v2, which conflicts with the standing rule above.

**How the first real action will look.** Writes come from self-heal (`self_heal.py` → `execute(circuit,
"power_cycle", source="self-heal")`), the Pi's backup fallback (`execute("Buffer Tank", "close")`), the planner's
gate and the dashboard via the hub (`hub_client.py:_handle_breaker`), and the arm path when armed and `arm_live`.

- **Worked over v2:** `/api/health.span.write` is `"v2"` with a fresh `write_ts`. Events (`span` / `span_breaker`):
  `cycle_opened` then `cycle_done` for a power cycle, `closed` for a close, each "(verified)" from the read-back
  (`BreakerController._readback`). `write` names the **last** write's transport only; read it with the bridge log.
- **CLOSE fell back:** log line `span: CLOSED over v2 failed (…) — trying v1`, and `span.write` is `"v1"`. It works
  until 2026-12-31 and not after. Treat it as a v2 write failure and journal it.
- **OPEN did not take over v2:** the cycle is audited `cycle_open_unconfirmed`, then `verify_mismatch` with
  "switch-off NOT confirmed … circuit ON (verified)", and the alert title is "power cycle unconfirmed"
  (`BreakerController._do_cycle`). The circuit was never off, so nothing is left unsafe, but the pump stays in its
  fault and self-heal escalates to a human after `max_attempts` (README, Self-heal). If this appears, v2 writes are
  not working: roll back (§5) while v1 still exists.
- **Could not switch back ON:** `close_failed`, an urgent page, background re-closes every `reclose_interval_s`
  (`_alert_close_failed`, `_reclose_loop`). Follow the page: turn the breaker on at the panel.

## 5. Rollback to v1

```bash
cp -p /home/admin/bridge-data/config.yaml /home/admin/bridge-data/config.yaml.bak-$(date +%Y%m%d)-rollback
# edit span: transport: v1   (optionally v2_soak: true, to keep comparing)
sudo systemctl restart heatpump-bridge
```

Or restore the pre-flip backup, if nothing else in the file changed since. Expect `span.mode: "v1"`, `span.read: "v1"`,
`span.v2: null`, and `span.soak` back (counters from zero) if `v2_soak` is on. Possible only while the panel serves v1.

**The v1 token.** It is persisted as `span-local-token` next to the DB (`main.py`, `SpanClient._persist_token`) and
loaded at every start in every mode (`_load_token`). In `auto` it is used only on a fallback. The code calls it
"long-lived" and tracks no expiry: **how long it stays valid is not determined from the code.** Rollback does not
depend on it. A rejected token (401/403/412) is re-minted once from the passphrase (`_v1_fetch_sync` →
`_register_sync`). A restarted bridge can register at once; a second re-mint in the same process waits 600 s
(`_REREGISTER_COOLDOWN_S`). Once the panel answers the register call with 404, v1 is gone and rollback is not.

## 6. What breaks on 2026-12-31 if the bridge is still on v1

Every SPAN read fails, because every consumer goes through `SpanClient.fetch_circuits`:

- No circuit power samples and no relay read-back (`SpanLocalPoller.poll_once`).
- Every breaker action is refused 503 before anything is switched (`BreakerController._run`): no self-heal power
  cycle, no backup-element close from the fallback or the gate, no dashboard breaker control.
- Self-heal, the backup fallback and the deliberate-stop watch lose their panel evidence after 120 s
  (`SPAN_FRESH_S`). If the pumps also go quiet, self-heal reads the silent panel as a blind Pi and holds back the
  both-down page (`self_heal.py:_pi_blind`).
- One "SPAN local link down" alert after 4 h (`_maybe_alert_down`).

How `/api/health` shows it:

- `span.last_ok_ts` and `span.read_ts` stop advancing. **`span.read` still says `"v1"`**: it names the last transport
  that answered and is never cleared (`SpanClient._note`). Judge by the timestamps.
- `span.v1_error` is set. If the panel answers the circuits call with 404 the text is `circuits: http://…: HTTP 404`
  (`_circuits_sync`). If it rejects the token first, the re-register hits 404 and the text is `v1 register: HTTP 404 —
  v1 REST is not served by this panel` (`_register_sync`). Which of the two the panel will do is not determined from
  the code.
- Top-level `healthy` stays `true`: it looks only at the pumps (`api.py:health`).

Before that date: drift-check `[10]` fails a pinned `v1` from 2026-12-15. In `auto`, removal needs no action: reads
and CLOSEs wait for v2 when v1 cannot answer (`_fetch_sync`, `_set_relay_sync`).

## 7. Known quirks

- **Negative active power.** A load reads negative on v2 `meter/active-power`, as v1 `instantPowerW` does
  (`HomieTree.circuits`). Consumers take magnitudes (`span_local.py:house_load`,
  `BreakerController._backup_open_refusal`). The soak never compared power, so v2 power values were checked only by
  the 2026-10-29 probe (`span-v2-local-api.md`), not over the 17 days.
- **Python 3.13 certificate strictness.** 3.13 sets `ssl.VERIFY_X509_STRICT` by default and the panel's certificate
  fails it ("Missing Authority Key Identifier"). `span_v2.py:tls_context` clears that one flag; chain and hostname
  checks stay. The Pi's Python version is not determined from the repo.
- **Broker host / servername.** On r202639 the broker is `mqtts://192.168.184.206:8883`, servername
  `span-nj-2312-003t6.local`; the cert verifies by that name and by the IP; username is the panel serial, password
  the passphrase (#199). The bridge connects to `span.host`, alternating with `span.ip_fallback` on restarts
  (`SpanV2._start`), not to the registration's `ebusBrokerHost`. `span.v2.broker` shows the address in use.
- **Wi-Fi blind-spell false disagreement.** See §2. One entry, 2026-11-13T19:20Z. In `auto` nothing is compared, and
  the same shape is harmless: a heat-pump circuit with `relay_state` `None` makes self-heal discard the panel read
  (`self_heal.py:_span`) and an OFF action is refused as "already in an unknown state" (`BreakerController._run`).
- **CA change and registration backoff** record `span_v2` events (`v2_ca_changed`, `v2_register_backoff`); see
  `span-v2-local-api.md`. A CA change without a firmware update needs a look.

## 8. What to journal

- The final soak snapshot from §2 (`since`, `compared`, `agree`, `disagree`, `unavailable`, `last_disagreement`) and its file.
- The backup's file name, the `diff` output, and the restart time (UTC).
- After the flip: `mode`, `read`, `v2.connected`, `v2.synced`, `v2.broker`, any `v2_error`; drift-check `[10]`.
- Any fallback to v1 (`read` or `write` showing `"v1"` in `auto`), with `v2_error` and the time.
- The first real relay write over v2: time, circuit, source, `span.write`, the event codes, verified or not.
- Any `v2_ca_changed` / `v2_register_backoff` event, and any rollback: why, when, the health fields afterwards.
- The owner's decision on the Air-Water 2 power-cycle test (§4).
