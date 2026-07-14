# SensorLinx write API — discovered via Proxyman capture (Phase A-3, 2026-07-13)

> **Status: DISCOVERED & VERIFIED** (two live writes captured with full read-back).
> Source: Proxyman HAR of the SensorLinx iOS app, 2026-07-13 ~22:29 EDT.
> ⚠️ The HAR file in `~/Downloads` contains a **live refresh token and JWT** — do not
> commit it; delete after reference. Canonical as-found config:
> `hbx-config-asfound-20260713.json` (this folder).

## Host — NOT the one TempIQ uses

The current app talks to **`https://api.sensorlinx.co`** (TempIQ's connector polls the
older `mobile.sensorlinx.co`). The new host has a proper session model and richer
endpoints. The A2W adapter should target `api.sensorlinx.co`; TempIQ's old-host polling
keeps working independently.

## Auth

- Requests carry `Authorization: Bearer <JWT>`; the JWT expires in **15 min** (`iat`/`exp`).
- Renewal: `POST /account/session/refresh` with `{"refresh": "<long-lived refresh token>"}`
  → new JWT. (Initial login not captured — app had a session; assume `POST /account/login`
  as on the old host, capture once when building the adapter.)
- Adapter design: store the refresh token as the credential (Railway env var), refresh the
  JWT on demand / on 401.

## The write — per-section PATCH (the safe kind)

```
PATCH /buildings/{buildingId}/devices/{syncCode}
Authorization: Bearer <JWT>
Content-Type: application/json

{"htDif": 4, "dbt": 165, "mbt": 144}          ← hot-tank section save
{"bkLag": 231, "bkTemp": 90, "bkDif": 90, "bkOd": -22, "bkTk": 32}   ← backup section save
```

- **Partial documents**: only the fields of the edited settings screen are sent — no
  read-modify-write race on the rest of the config. The adapter can write exactly one
  field (e.g. `{"mbt": 140}`).
- **Response = the complete updated device object** (all ~90 fields + live temps) —
  read-back verification is built into the write response. Verified live: `mbt` 145→144
  and `bkLag` 230→231 both reflected immediately in the PATCH response.
- Cross-check: app-made changes also appear in the polled telemetry (old host) within one
  5-min TempIQ cycle (demonstrated in the A-0 data).

Our installation: `buildingId = 673e25ab8db6198c521700ed`, `syncCode = AECO-2036`
(ECO-0600, firmware 2.08, device id `65fc4be11eccbe1413b8d43f`).

## Reads (better than the old host)

- `GET /buildings/{id}/devices` → full device objects (the A-1 config snapshot source).
- `POST /buildings/{id}/devices/{syncCode}/history/minutes` with
  `{"start": "<ISO>", "minutes": N, "fields": ["temps.temp1.actual", "temps.temp1.target", ...]}`
  → **minute-resolution history of chosen fields**. The planner's SensorLinx reader should
  use this (beats 5-min whole-device polling).
- Real-time push exists: socket.io on `wss://api.sensorlinx.co/socket.io/?systemId={buildingId}`
  (JWT in the handshake frame). Optional upgrade for the reader; polling is fine for v1.
- Also seen: `GET /buildings`, `GET /buildings/{id}` (contains members/triggers), `GET
  /account/me`, `GET /config`.

## Field map (decoded from the as-found capture; °F throughout)

| Field | Meaning (manual name) | As-found |
|---|---|---|
| `dbt` / `mbt` | Max Tank Temp (@ design) / Min Tank Temp (@ WWSD) — the curve endpoints | **165 / 145** |
| `dot` | Outdoor Reset Design outdoor temp | **5** |
| `wwsd` | WWSD outdoor temp (curve warm end) | **125** (= never; effectively OFF, `wsd.wwsd.activated=false`) |
| `htDif` | Hot tank differential (centered) | **4** |
| `permHD` / `permCD` | Permanent heat/cool demand | **1** / 0 ← answers summer DHW: HD is always on |
| `dhwOn` / `dhwT` | DHW tank mode / target | **0** (unused, owner-confirmed) / 123 |
| `numStg` | HP stages | **3** (slot 3 = phantom — wired to nothing; backup on slot 4 b/c damaged hardware) |
| `rotTi` / `rotCy` | Rotate time (run-hrs) / cycles | **1** / 0 → rotation ON, includes the phantom |
| `lagT` / `lagOff` | Stage ON / OFF lag (min) | **60 / 30** |
| `bkLag` | Backup lag after all stages (min) | **230** |
| `bkDif` | Backup differential | 90 (= disabled-high) |
| `bkTemp` | Backup permitted below this outdoor | 90 (= essentially always permitted) |
| `bkOd` | Backup-only below this outdoor (HP lockout) | −22 (= never) |
| `bkTk` | Backup-only above this tank temp | 32 (= off/nonsensical) |
| `ecoCl`, `pgm`, `wkd*/wke*` | ECO Clock schedule | off |
| `webOut` | Web outdoor sensor | 0 (wired sensor) |
| `stages[].runTime`, `bkRun` | run-hour counters | 3170:00 / 3169:28 / 3172:00, backup **969:00** |
| `temps.temp1/3` | tank (actual+target) / outdoor | live values |
| `cwsd`, `cdot`, `mst`, `dst`, `clDif` | cooling-side twins | present, CD enabled but unused |

Curve check: (5 °F ↦ 165) → (125 °F ↦ 145) gives slope −0.167 °F/°F, intercept 165.8 —
matching the A-0 empirical fit (−0.161, 165.5) to within hourly-averaging error. **A-1's
four curve parameters are now exact.**

## Adapter guardrails (mapping per plan §5.2)

- Allowlist: v1 writes ONLY `dbt`, `mbt` (curve endpoints) — nothing else without a new
  decision. Band clamp (I4) in °F before conversion.
- Read-back: assert the PATCH response echoes the written field; cross-check
  `temps.temp1.target` moves onto the new line within one poll.
- Rate limit ≥15 min; audit old→new from the pre-write GET; baseline restore =
  PATCH `{"dbt":165,"mbt":145}` (values from `hbx-config-asfound-20260713.json`).
- The refresh token is the secret to protect; JWT is disposable.
