# TempIQv2 borrowables catalog

> TempIQv2 (`~/Documents/Claude/TempIQv2`) is a **reference library only — NEVER edit it**.
> Copy patterns/code into this repo; no runtime dependency on TempIQ or its Supabase in v1.
> Catalogued 2026-07-04 from the live tree (ignore the stale copy under `repos/TempIQv2/`).

## HBX — SensorLinx cloud connector (READ-ONLY — no write path exists)

⚠️ **Reality check:** TempIQ can only *read* HBX telemetry. The ECO-0600 is reached through
HBX's SensorLinx cloud (`https://mobile.sensorlinx.co`), and the connector's only POSTs are
login calls. There is **no command/write path to the HBX** to borrow. (Fine for the bridge —
handoff keeps HBX out of scope; Phase 4 "HBX awareness" means reading its state, which this
covers.)

- Connector: `server/connectors/sensorlinx.ts` — class `SensorLinxConnector`
- Auth: `POST /account/login` `{email, password}` → JWT bearer; no real refresh (re-login every ~50 min, `TOKEN_REFRESH_INTERVAL`)
- Endpoints: `GET /buildings`, `GET /buildings/{id}/devices`, `GET /buildings/{id}/devices/{syncCode}` (polled telemetry, 5-min cadence, no webhooks)
- Data: `temps.temp1.actual/target` = tank temp/target, `temp3` = outdoor (°F); `relStat[]` 16 relay outputs; `stgRun[]` → zone calls (`parseZoneCalls`, lines ~697–743); `demandSignals[]`
- Gotcha: controller is property-level; prod writes land in the generic `readings` table (not `sensorlinx_telemetry`) — see `server/services/system-health/signal-oracle.ts:397-402`

**Borrow for Phase 4:** the auth/login dance, endpoint shapes, and zone-call parsing —
enough to know what the buffer tank and zones are calling for when A2W chooses setpoints.

### HBX WRITE — required in the future (decided 2026-07-04)

Owner requirement: A2W must eventually **write** to the HBX (e.g. change its setpoint to
match the heat pumps — coordinated control). TempIQ has nothing to borrow here, but the
path exists:

- HBX's own SensorLinx app "adjusts system parameters" remotely on the ECO-0600 — so a
  write endpoint exists on `mobile.sensorlinx.co`; TempIQ simply never used it
- HBX also advertises a server-side API for BMS/BACnet integrations
- Discovery method (settled): **Proxyman capture of the SensorLinx app** while changing a
  setpoint. The owner already used Proxyman to reverse the read side — same workflow for
  writes. Fallbacks: HBX's BMS API docs; ECO-0600 manual local BMS/RS-485 port
  (unconfirmed — nothing found in a quick search)
- Treat any HBX write with the same guardrail discipline as reg 2003: clamp, read-back
  verify, rate limit, audit with source

## SPAN panel — two connectors

### Cloud (`server/connectors/span-cloud.ts`)
- GraphQL `https://app-api.prod.span-csp.com/graphql`; AWS Cognito SRP auth (pool config hardcoded at lines 20–25, extracted from HAR); 1-min polling
- **Power is derived from cumulative hourly energy counters** (`latestMeasurement` is broken): ΔWh × 3600 / accumulationSeconds, in pure unit-tested `server/connectors/span-power-derivation.ts`
- **Hard-won lesson (gtm#837):** the hour counter steps ~once/hour; advance the energy anchor **only when the counter changes**, else power inflates 14–482×. Guards: first/idle/rollover/outage>300s/too-short<10s/impossible>50kW → null
- Storage: `spanCircuitReadings` (per-minute, `shared/schema/readings.ts:102-121`) + `spanCircuitAggregations` (10-min buckets) + mirror into generic `readings`
- Gotchas: exported energy always 0 from cloud API; never overwrite non-zero bucket power with 0W historical

### Local (`server/connectors/span.ts`)
- `http://{panelIp}/api/v1`; JWT via `POST /auth/register` after 3× door-button press
- `GET /panel` returns **true** `instantPowerW` per branch — no derivation needed
- Prefer this pattern if A2W ever reads SPAN directly: simpler, no Cognito, real power

### Heat pump circuit identification
- `server/services/thermal/circuit-classification.ts` — `getHpCondenserCircuitIds()` via `equipment_relationships` (`powers` → `hvac_unit_condenser`); system kinds include **`heat_pump_a2w`**
- Circuit metadata available: name, tabNumber, breakerRatingA, relayState, isSheddable…

**Borrow near-term (Phase 1 commissioning):** SPAN circuit power for the heat pump
condensers is an independent cross-check for the Modbus power registers (2063/2088 units
and scaling, plus fixed-freq compressor draw) — better than a clamp meter, already logging.

**Borrow later (Phase 4):** SPAN whole-home / circuit signals as inputs to setpoint logic.

## Integration posture (decided 2026-07-04)

A2W Control stays standalone. Future TempIQ integration = an API consumer of A2W's
endpoints (either TempIQ writes targets via the guarded setpoint API, or feeds signals and
A2W decides — deferred to Phase 4, leaning toward A2W owning the logic since guardrails
live here). The `source` field on setpoint writes is the seam.
