/**
 * @purpose A2W planner service — Phase A-2: the SensorLinx reader. Polls the ECO-0600
 * every POLL_SECONDS via api.sensorlinx.co, stores narrow readings in Neon, versions any
 * config drift (curve/staging/backup edits) with an ntfy alert, and exposes /health.
 * Also the SOLE guarded writer of the HBX curve (writes.ts; README §Single-writer invariant):
 * any FOREIGN (non-planner) curve write is detected + paged, and a second live instance flagged.
 * Edge-triggered offline alerting after OFFLINE_AFTER_FAILURES consecutive poll failures.
 */

import http from "node:http";
import { SensorLinxClient } from "./sensorlinx";
import { Store, SlxReading } from "./store";
import { extractConfig, handlePolledConfig, PendingTracker, type CurveDiagnosis } from "./drift";
import { piHealth, withLiveAges, READING_GAP_MIN_S, BOOT_JUMP_S, CLOCK_STEP_S, DROPOUT_WINDOW_S, LOOKBACK_S, FUTURE_S, SETTLE_S, type PiHealth } from "./pilink";
import crypto from "node:crypto";
import os from "node:os";
import { TempiqPusher } from "./tempiq";
import { TempiqWindowPoster } from "./tempiq-windows";
import { IdentificationDriver, IDENT_MODES, type IdentMode } from "./identify";
import { TempiqReader, parseCopRefetchRequest } from "./tempiq-read";
import { HubClient, type HubState } from "./hub";
import { computeShadowPlan, curveTargetF, fetchForecast, forecastWithFallback, bandFor, DEFAULT_OPTS, DemandFloor, MIN_PREBOOST_DRAWS, MIN_PREBOOST_F, MAX_PREBOOST_F, STANDBY_F_PER_H, priorExcursionsFromPlans } from "./shadow";
import { shapeCurve, curveOutputF, canShapeFromFeed, parseShapedCurveMode, curveAlreadyInForce } from "./curve";
import { solveWinterDp, DEFAULT_TANK_UA, type DpHour } from "./winterdp";
import { aggregateTankUa } from "./tank-ua-push";
import { hygieneVerdict, hygieneIntervalH, lastDwellEnd, drawGapStats } from "./hygiene";
import { AutoPilot } from "./autopilot";
import { SpanWatch } from "./spanwatch";
import {
  fetchNwsAlerts,
  fetchStormForecast,
  deriveSyntheticTriggers,
  fetchOutageStatus,
  evaluateStormState,
  stormCeilingF,
  StormAlert,
  SyntheticTrigger,
  StormState,
} from "./storm";
import { DemandFeed, requiredAwtF, type FloorPolicy } from "./demand";
import { ForecastFeed, planPreheat, predictedCapRisk } from "./forecast";
import { logAdjacencyShadowFloor } from "./spatial";
import { learnDhwWindows, detectDrawTimes, measureWindowSags, peakWindows, type WindowSag } from "./dhw";
import { advanceCallMinutes, decideFloorRaise, FLOOR_RAISE_MIN_F } from "./floor-cadence";
import { HbxWriter, WriteError, curveOverridden, raiseWriteBarrier, deviceWritesInFlight, withDeviceLock, piStateUnverifiable } from "./writes";
import { StageWatch, parseStagePumpMap, partitionRestore, calledStagesAllStopped, type StagePump } from "./stagewatch";
import { BackupGate, BG, parseGateConfig, type GatePump } from "./backupgate";
import { spanHealth, SpanLocalAlarm, type SpanHealth } from "./spanlocal";
import { AlertOutbox } from "./alerts";
import { renderAlertEmail } from "./alertemail";
import { route, tierSubject, Latches, PageBudget, PAGE_BUDGET_PER_WEEK, episodeTier, piUnreachablePageAfterS, type Tier, type NotifyOpts } from "./alertpolicy";
import {
  PH, TREND, evaluatePump, evaluateTankFlat, PumpHealthWatch, parseLiveChecks, episodeKind, parseEpisodeKind, rollupDay, trend,
  digest, etDay, etHour, etDayStart, type Verdict, type DayRow, type TrendOut,
} from "./pumphealth";
import { PhaseB, operativeLeadF, staleProofApplicable, staleProofNote, type OperativeLead } from "./phaseb";
import { decayScanOnce } from "./decay";
import { pushTankUa } from "./tank-ua-push";
import { pushTankReheat } from "./tank-reheat-push";
import { RealizedSavings } from "./realized";
import { observePeers, peerLiveMs, type PeerHeartbeat } from "./singlewriter";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    console.error(`FATAL: missing required env var ${name}`);
    process.exit(1);
  }
  return v;
};

const EMAIL = env("SENSORLINX_EMAIL");
const PASSWORD = env("SENSORLINX_PASSWORD");
const DATABASE_URL = env("DATABASE_URL");
const BUILDING_ID = env("SLX_BUILDING_ID", "673e25ab8db6198c521700ed");
const SYNC_CODE = env("SLX_SYNC_CODE", "AECO-2036");
const POLL_SECONDS = Number(env("POLL_SECONDS", "300"));
const PORT = Number(process.env.PORT ?? 8080);
const NTFY_TOPIC = process.env.NTFY_TOPIC;
const NTFY_SERVER = process.env.NTFY_SERVER ?? "https://ntfy.sh";
// Email (Resend) and the 6bb phone push are chosen by TIER, never by priority: see alertpolicy.ts and
// knowledge/reference/alert-policy.md (owner, 2026-10-20). Priority now only sets ntfy loudness.
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_TO = process.env.RESEND_TO ?? "";
const RESEND_FROM = process.env.RESEND_FROM ?? "A2W Alerts <onboarding@resend.dev>";
const OFFLINE_AFTER_FAILURES = 5;
const SLX_ATTENTION_FAILURES = 72; // ~6 h at the 5-min poll

const HUB_URL = process.env.HUB_URL;
const HUB_CLIENT_TOKEN = process.env.HUB_CLIENT_TOKEN;
const LAT = process.env.LAT ?? "42.63";
const LON = process.env.LON ?? "-70.87";
const SHADOW_EVERY_MIN = Number(process.env.SHADOW_EVERY_MIN ?? "60");

// Realized-savings engine inputs (realized.ts). Same defaults the dashboard used, now the source
// of truth: the planner computes the measured per-day ledger and the dashboard just reads it.
const ELECTRIC_RATE_USD_KWH = Number(process.env.ELECTRIC_RATE_USD_KWH ?? "0.30");
const DAILY_KWH_BASELINE = Number(process.env.DAILY_KWH_BASELINE ?? "11.8");
const STANDBY_UA_BTU = Number(process.env.STANDBY_UA_BTU ?? "25");
// Local days the realized ledger recomputes every hour (the SQL caps the window at the 2026-07-16 cutover, so a large
// value is harmless). Default 45. One-off repair after the window-edge fix: set REALIZED_LOOKBACK_DAYS=120 on Railway,
// let the startup run rewrite every day back to the cutover ("realized-savings: recomputed N days" in the log), and
// drop the variable at the next deploy.
const REALIZED_LOOKBACK_DAYS = Number(process.env.REALIZED_LOOKBACK_DAYS ?? "45") || 45;

const PLANNER_API_TOKEN = process.env.PLANNER_API_TOKEN;

// Storm mode (§6.11, W0-5). Notify-first: triggers always page the owner, but the plan
// is only shaped when STORM_MODE_ENABLED=1 (plan §11 Q6 is an open owner question).
const STORM_MODE_ENABLED = process.env.STORM_MODE_ENABLED === "1";
const STORM_CAP_F = Number(process.env.STORM_CAP_F ?? "135");
// #114 owner decision 2026-09-25: the pre-charge step above the curve target. 10 °F (to strictCap)
// is DHW resilience — ~1.6 showers / ~12.8 h of coast for ~$0.39. Set 3 to restore pre-2026-09-25
// behaviour. See knowledge/reference/storm-precharge-economics.md.
const STORM_STEP_F = Number(process.env.STORM_STEP_F ?? "10");
const OUTAGEWATCH_URL = process.env.OUTAGEWATCH_URL ?? "https://victorious-light-production.up.railway.app";

const slx = new SensorLinxClient(EMAIL, PASSWORD);
const store = new Store(DATABASE_URL);
const realized = new RealizedSavings(store, {
  rateUsdKwh: ELECTRIC_RATE_USD_KWH, uaBtuHrF: STANDBY_UA_BTU, ambientF: 70, dailyKwhFallback: DAILY_KWH_BASELINE,
});
const hub = HUB_URL && HUB_CLIENT_TOKEN ? new HubClient(HUB_URL, HUB_CLIENT_TOKEN) : null;
if (!hub) console.warn("HUB_URL/HUB_CLIENT_TOKEN not set — I1 monitor disabled");
if (!PLANNER_API_TOKEN) console.warn("PLANNER_API_TOKEN not set — write API disabled");

const PHASE_B_ENABLED = process.env.PHASE_B_ENABLED === "1";
const PHASE_B_DRY_RUN = process.env.PHASE_B_DRY_RUN === "1";
// Auto-pilot: drive the HBX buffer TARGET to the shadow plan's current-hour value (target-side
// twin of Phase B). Off by default; DRY_RUN=1 logs what it would set without writing.
const AUTOPILOT_ENABLED = process.env.AUTOPILOT_ENABLED === "1";
const AUTOPILOT_DRY_RUN = process.env.AUTOPILOT_DRY_RUN === "1";

// #58 afternoon bank: one block/day at the day's warmest hour raised to dhwFloor + BANK_F,
// so the day's charge is bought at the best outdoor COP. 0 (default) = off — plans identical
// to before. Only ever ADDS heat above the DHW floor; clamped to a sane 0–15 °F.
const BANK_F = Math.min(Math.max(Number(process.env.BANK_F ?? "0") || 0, 0), 15);

// #59 winter DP: the cost-optimal 24 h target trajectory. The solve itself is SHADOW-FIRST —
// it runs (and lands in plan meta + /health) whenever the horizon dips below the compute
// threshold, so shoulder season builds a comparison record automatically. Commanded targets
// change only behind WINTER_DP_ENABLED=1, and then strictly as raises above the floor logic.
const WINTER_DP_ENABLED = process.env.WINTER_DP_ENABLED === "1";
const DP_COMPUTE_BELOW_F = 55; // any forecast hour below this → solve (inert in high summer)
let winterDpState: Record<string, unknown> | null = null; // /health surface

// #59 first-cold-week commissioning watch: real cold + a cap-pinned plan + the same hydronic
// zone calling across consecutive hourly shadow cycles = the signature of the 135°F strictCap
// under-serving an emitter (the as-found system ran 145–165°F on such days). Latched: one
// urgent (email-tier) alert per episode; clears when any leg of the condition breaks.
const CAP_WATCH_OUTDOOR_F = 35;
const CAP_WATCH_STREAK = 3; // consecutive shadow cycles ≈ hours
const capWatchStreaks = new Map<string, number>();
// #90 escalation backstop: consecutive shadow cycles each zone has been calling. A zone
// still calling after a full cycle is not keeping up at the current supply temp, whatever
// the room telemetry says (demand.setpointF is null whenever a zone is off, and has never
// been observed populated in a heating season — the policy must not depend on it).
// #136: unbroken calling MINUTES per zone (was cycles) — advanced on every sample from the elapsed time.
const zoneCallMinutes = new Map<string, number>();
let lastCallSampleAt: number | null = null;
/** zone_call_samples' 60-day prune rides the insert once an hour (same shape as the Pi-clock prune). */
let zoneCallPrunedAt = 0;
/** #136: the demand floor is re-checked every poll and the current plan block raised in place when it lags. */
const FLOOR_CADENCE_ENABLED = process.env.FLOOR_CADENCE !== "0";
const floorCadence = { lastCheckAt: null as string | null, lastFloorF: null as number | null, lastBlockF: null as number | null, lastDecision: null as string | null, raises: [] as { at: string; ts: string; from: number; to: number }[] };
let capWatchLatched = false;

// Phase 3 v2: narrow daily auto-sanitize. The FIRST automated write to the pumps.
// OFF by default — deploying this changes NOTHING until AUTO_SANITIZE_ENABLED=1.
// When on, the I8 hygiene check fires one durable/guarded boost(131,60) per overdue
// soak (see checkI8). Fail-safe: a rejected boost falls through to the existing alert.
const AUTO_SANITIZE_ENABLED = process.env.AUTO_SANITIZE_ENABLED === "1";
// Runtime override of AUTO_SANITIZE_ENABLED: env only SEEDS controller_flags; the Optimize-page toggle
// owns it thereafter. Refreshed each poll from the row; read by checkI8 + the shadow interlock + /health.
let autoSanitizeLive = AUTO_SANITIZE_ENABLED;

// I8 pasteurization cadence (configurable + season-aware; see hygiene.ts). The interval is the
// rolling window in which the tank must have held a real ≥SANITIZE_VERIFY_F/≥SANITIZE_DWELL_MIN dwell.
// Base default 26 h = today's behavior byte-for-byte. HYGIENE_SUMMER_INTERVAL_H (default = base, a
// no-op) lets the owner relax the cadence in the cool-tank regime (warm outdoor) — coil-only potable
// volume + 4–6 h Legionella doubling ⇒ a 2–3 day summer cadence still pasteurizes with margin. A hard
// 72 h ceiling in hygiene.ts caps any value so a bad env can't disable hygiene. Winter is unaffected:
// the tank runs hot continuously, so the dwell is satisfied for free and the interval never binds.
const HYGIENE_BASE_INTERVAL_H = Number(process.env.HYGIENE_MAX_INTERVAL_H ?? "26");
const HYGIENE_SUMMER_INTERVAL_H = Number(process.env.HYGIENE_SUMMER_INTERVAL_H ?? String(HYGIENE_BASE_INTERVAL_H));
const HYGIENE_SUMMER_OUTDOOR_F = 55; // ≥ this outdoor ⇒ cool-tank regime ⇒ the summer interval applies
let lastOutdoorF: number | null = null; // freshest outdoor from the poll — the season signal for checkI8
/**
 * #122 Wave 1: the freshest thermal state, cached at poll time so /health can report it without a
 * DB round-trip on every scrape (drift-check, the storm watch and the mirror all poll it).
 *
 * This exists because on 2026-09-26, mid-High-Wind-Warning, the only way to answer "is the buffer
 * warm enough to coast an outage?" was to INFER it from hygiene.hours_since_dwell. For a system
 * whose entire purpose is thermal resilience, the tank temperature not being in its own health
 * endpoint is the wrong default. Setpoints ride along free: checkI1 already fetches hub state
 * every poll.
 */
let lastShapedCurve: ReturnType<typeof shapeCurve> | null = null; // #133 (b): the curve the latest plan implies
let lastDeviceCurve: { dot: number; wwsd: number; dbt: number; mbt: number } | null = null; // #133 acceptance 3: the curve IN FORCE
let lastThermal: {
  at: string | null;
  tank_f: number | null;
  tank_target_f: number | null;
  outdoor_f: number | null;
  setpoints_f: Record<string, number | null>;
} = { at: null, tank_f: null, tank_target_f: null, outdoor_f: null, setpoints_f: {} };
const PHASE_B_PUMPS = (process.env.PHASE_B_PUMPS ?? "pump1,pump2").split(",").map((s) => s.trim()).filter(Boolean);
// #133 (b): SHAPED_CURVE=1 makes the auto-pilot command the plan's demand-shaped reset curve for
// non-excursion hours and Phase B lead its output. Off = byte-identical to the pre-#133 planner: no
// curve is computed, no plan block is stamped, /health.curve.plan_implies stays null.
// SHAPED_CURVE=shadow computes + stamps + reports (/health.curve.plan_implies) but writes nothing —
// the auto-pilot is live on the pilot, so "1" would command the first shaped curve within a poll.
const SHAPED_CURVE_MODE = parseShapedCurveMode(process.env.SHAPED_CURVE);
const SHAPED_CURVE = SHAPED_CURVE_MODE === "live";
const SHAPED_CURVE_STAMP = SHAPED_CURVE_MODE !== "off";
const phaseB = PHASE_B_ENABLED && hub
  ? new PhaseB(store, hub, PHASE_B_PUMPS, PHASE_B_DRY_RUN, ntfy, SHAPED_CURVE,
      // Phase B writes through the hub (not writes.ts): gate it on the SAME lease the HBX writes honour — checked
      // FRESH against the DB row before every send, exactly like writes.ts does — and on the shutdown barrier
      // (codex passes 1–2 on #162: the dying container must not renew a 90-min pump lease, and a cached held=true
      // can be stale after 12 min of failed renews while a successor has claimed the row).
      async () => !shuttingDown && (!WRITER_LEASE_ENABLED || await store.holdsWriterLease(INSTANCE_ID, INSTANCE_FRESH_MS)))
  : null;

// SPAN backup-element power alarm — an INDEPENDENT net (vs the HBX's own backup_called decision
// flag) that pages when the 16.5 kW element draws REAL energy. Uses the SPAN CLOUD API (SRP login,
// no tunnel — the same path TempIQ uses). Dormant unless SPAN_USERNAME is set. See spanwatch.ts.
const SPAN_USERNAME = process.env.SPAN_USERNAME;
const SPAN_PASSWORD = process.env.SPAN_PASSWORD ?? "";
const SPAN_BACKUP_CIRCUIT = process.env.SPAN_BACKUP_CIRCUIT ?? "backup";
const SPAN_BACKUP_ALARM_KWH = Number(process.env.SPAN_BACKUP_ALARM_KWH ?? "0.3"); // drawn in the trailing 60 min; 16.5 kW hits 0.3 kWh in ~65 s
const SPAN_BUILDING_ID = process.env.SPAN_BUILDING_ID; // optional; auto-discovered if unset
const SPAN_POLL_SECONDS = Number(process.env.SPAN_POLL_SECONDS ?? "60");
// The pump (compressor) circuits on the SPAN panel — summed each poll into span_energy so the
// realized-savings engine can use REAL metered daily electricity instead of the SPAN daily average.
const SPAN_PUMP_CIRCUITS = process.env.SPAN_PUMP_CIRCUITS ?? "air-water";
const spanWatch = SPAN_USERNAME
  ? new SpanWatch(SPAN_USERNAME, SPAN_PASSWORD, SPAN_BACKUP_CIRCUIT, SPAN_BACKUP_ALARM_KWH, ntfy, SPAN_BUILDING_ID, store, SPAN_PUMP_CIRCUITS)
  : null;
if (spanWatch) console.log(`SPAN backup watch ON — circuit "${SPAN_BACKUP_CIRCUIT}", alarm >${SPAN_BACKUP_ALARM_KWH} kWh in 60 min; pump-energy circuits "${SPAN_PUMP_CIRCUITS}" → span_energy, every ${SPAN_POLL_SECONDS}s`);
else console.log("SPAN backup watch OFF (set SPAN_USERNAME to enable the element power alarm)");

// TempIQ push seam (§A-7, TempIQ#1480 — live 2026-07-14). Inert without the flag+token.
const TEMPIQ_PUSH_ENABLED = process.env.TEMPIQ_PUSH_ENABLED === "1";
const TEMPIQ_BASE_URL = process.env.TEMPIQ_BASE_URL ?? "https://tempiq.vercel.app";
const TEMPIQ_SURFACE_TOKEN = process.env.TEMPIQ_SURFACE_TOKEN;
const TEMPIQ_PUSH_EVERY_MIN = Number(process.env.TEMPIQ_PUSH_EVERY_MIN ?? "5");
const tempiq = TEMPIQ_PUSH_ENABLED && hub && TEMPIQ_SURFACE_TOKEN
  ? new TempiqPusher(hub, TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN)
  : null;
if (TEMPIQ_PUSH_ENABLED && !tempiq) console.warn("TEMPIQ_PUSH_ENABLED but hub/TEMPIQ_SURFACE_TOKEN missing — pusher disabled");

// TempIQ read seam (§6.7, TempIQ#1470 read half — live 2026-07-14). Inert without the flag+token.
const TEMPIQ_READ_ENABLED = process.env.TEMPIQ_READ_ENABLED === "1";
const TEMPIQ_READ_EVERY_MIN = Number(process.env.TEMPIQ_READ_EVERY_MIN ?? "60");
// TempIQv2#2124: TempIQ defers a COP point until the charge's end is observable and re-upserts its overlap day on
// every hourly run, so each read tick re-reads this many days behind the newest mirrored point (upsert, not
// insert-only). 0 restores the pre-#2124 "newest point" cursor — it then misses every completed row.
const COP_OVERLAP_DAYS = Number(process.env.COP_OVERLAP_DAYS ?? "3");
const tempiqRead = TEMPIQ_READ_ENABLED && TEMPIQ_SURFACE_TOKEN
  ? new TempiqReader(store, TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN, { copOverlapDays: COP_OVERLAP_DAYS })
  : null;
if (TEMPIQ_READ_ENABLED && !tempiqRead) console.warn("TEMPIQ_READ_ENABLED but TEMPIQ_SURFACE_TOKEN missing — reader disabled");

// TempIQ perturbation-window seam (a2w#137 — our half of gtm#1596 / gtm#1616 Part C). Posts the
// episodes in which WE were driving the buffer target so TempIQ quarantines them from passive
// learning (and, later, U4 fits only labelled probes). Quarantine-only kinds — no assignment is
// ever claimed here. Inert without the flag+token; same seam as the pusher.
const TEMPIQ_WINDOWS_ENABLED = process.env.TEMPIQ_WINDOWS_ENABLED === "1";
const TEMPIQ_WINDOWS_EVERY_MIN = Number(process.env.TEMPIQ_WINDOWS_EVERY_MIN ?? "5");
const tempiqWindows = TEMPIQ_WINDOWS_ENABLED && TEMPIQ_SURFACE_TOKEN
  ? new TempiqWindowPoster(store, TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN)
  : null;
if (TEMPIQ_WINDOWS_ENABLED && !tempiqWindows) console.warn("TEMPIQ_WINDOWS_ENABLED but TEMPIQ_SURFACE_TOKEN missing — window poster disabled");

// Winter-solver shadow seam (§6.9, W0-4). SHADOW ONLY: proposes demand floors to the
// shadow planner and snapshots them; flag off = today's behavior byte-for-byte.
const WINTER_SOLVER_SHADOW = process.env.WINTER_SOLVER_SHADOW === "1";
const demandFeed = WINTER_SOLVER_SHADOW && TEMPIQ_SURFACE_TOKEN
  ? new DemandFeed(TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN)
  : null;
if (WINTER_SOLVER_SHADOW && !demandFeed) console.warn("WINTER_SOLVER_SHADOW but TEMPIQ_SURFACE_TOKEN missing — winter solver shadow disabled");

// Required-supply FORECAST (#87; TempIQ gtm#1591, shipped TempIQv2#2017). NOT the A-8
// prediction contract — that was gated STOP at Phase 0 and never built, so there is no
// p_call and no pre-heating of zones that are merely LIKELY to call; see forecast.ts's
// header. Two independent gates on purpose: FETCH records what the forecast WOULD have
// done (plan meta + /health); PREHEAT is what lets it actually raise a commanded target.
// Both default off, so until the owner flips them the planner behaves as it does today.
// #90 cost-first demand floor (owner direction 2026-08-24). "escalate" (default): the
// cheap local model is the floor, TempIQ's capacity number is only a CEILING, and the
// calling room's own deficit decides how far up we go. "learned" = pre-#90 behavior
// (consume TempIQ outright — expensive, pegs the cap all winter, see #89). "local" =
// ignore TempIQ's number entirely.
const DEMAND_FLOOR_POLICY = (process.env.DEMAND_FLOOR_POLICY ?? "escalate") as FloorPolicy;
const FORECAST_FETCH_ENABLED = process.env.FORECAST_FETCH_ENABLED === "1";
const FORECAST_PREHEAT_ENABLED = process.env.FORECAST_PREHEAT_ENABLED === "1";
// PREHEAT_CONFIDENCE is GONE (#87 rewire): it gated on p_call, which TempIQ's Phase 0
// backtest killed and never shipped. The gate is now live evidence — a zone must be
// CALLING to earn a forecast raise. See forecast.ts's header for why the old gate could
// not simply be deleted. Setting the old env var has no effect.
const forecastFeed = FORECAST_FETCH_ENABLED && TEMPIQ_SURFACE_TOKEN
  ? new ForecastFeed(TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN)
  : null;
if (FORECAST_FETCH_ENABLED && !forecastFeed) console.warn("FORECAST_FETCH_ENABLED but TEMPIQ_SURFACE_TOKEN missing — demand forecast disabled");
if (FORECAST_PREHEAT_ENABLED && !FORECAST_FETCH_ENABLED) console.warn("FORECAST_PREHEAT_ENABLED without FORECAST_FETCH_ENABLED — no forecast to act on");
let forecastState: Record<string, unknown> | null = null; // /health surface
let predictedCapLatched = false; // one predictive cap alert per episode

// Adjacency-aware setback shadow (#33). SHADOW ONLY: logs what the tank floor WOULD be if warm-adjacent
// zones borrowed heat (deeper-setback savings), on top of the winter-solver floor. Never changes the
// live floor/setpoint. Flag off = no behavior change and no extra fetch.
const ADJACENCY_SETBACK_SHADOW = process.env.ADJACENCY_SETBACK_SHADOW === "1";
if (PHASE_B_ENABLED && !hub) console.warn("PHASE_B_ENABLED but no hub configured — tracking disabled");
if (phaseB) console.log(`PHASE B ${PHASE_B_DRY_RUN ? "DRY-RUN" : "ACTIVE"} for ${PHASE_B_PUMPS.join(", ")} (target + ${5}°F, leased)`);

const cToF = (c: number) => (c * 9) / 5 + 32;

let lastPollAt: string | null = null;
let lastDriftAt: string | null = null;
// #177: the newest curve diagnosis (echo_suspected | foreign | reverted) → /health.drift.last_foreign. Seeded from the
// DB at boot so a redeploy does not blank it.
let lastCurveDiagnosis: CurveDiagnosis | null = null;
// #165: the Pi link's story from the mirror's tables (pilink.ts) — computed off the request path every
// PI_LINK_REFRESH_MS and served from here, so a /health scrape never touches the database.
const PI_LINK_REFRESH_MS = 10 * 60 * 1000;
let piLink: PiHealth | null = null;
let piLinkError: string | null = null;
let piLinkBusy = false;
let piClockOffsetS: number | null = null; // checkI1 measures it from the hub frame each poll
let piClockOffsetAt = 0;                   // …when; an observation older than 15 min anchors nothing (codex pass 17)
let piClockWriteBusy = false;
let piClockPrunedAt = 0;
async function refreshPiLink(): Promise<void> {
  if (piLinkBusy) return; // a slow DB must not stack refreshes
  piLinkBusy = true;
  try {
    const now = Date.now();
    // a connected frame is ≤ ~15 s old plus latency: anything beyond 30 s is the Pi clock, not the frame's age
    const fresh = piClockOffsetS != null && now - piClockOffsetAt <= 15 * 60_000;
    const off = !fresh ? null : Math.abs(piClockOffsetS as number) > 30 ? piClockOffsetS : 0;
    piLink = piHealth(await store.piLinkInputs(now, { gapS: READING_GAP_MIN_S, bootJumpS: BOOT_JUMP_S, clockStepS: CLOCK_STEP_S, windowS: DROPOUT_WINDOW_S, lookbackS: LOOKBACK_S, futureS: FUTURE_S, settleS: SETTLE_S }), now, off);
    piLinkError = null;
  } catch (e) {
    piLinkError = (e as Error).message;
    console.error("pi-link refresh failed:", piLinkError);
  } finally {
    piLinkBusy = false;
  }
}
// #177: an `unconfirmed` curve change awaiting the next poll's re-check (drift.ts PendingTracker) — reloaded from the
// DB on the first poll (retried until it succeeds once), settled in the DB once announced or superseded.
const pendingUnconfirmed = new PendingTracker(() => store.pendingUnconfirmed(), () => store.resolveUnconfirmed());
let lastShadowAt: string | null = null;
let consecutiveFailures = 0;
let offlineAlerted = false;
let i1Violated = false;
let i1Detail: string | null = null;
/** what the last I1 check compared the setpoints against (/health.i1.operative): the report, or the curve in force when stale */
let i1Operative: { f: number; basis: OperativeLead["basis"]; reported_f: number; note: string | null } | null = null;

// §6.11 storm machine state: trigger caches refreshed by the 30-min poll, the state
// itself stepped once per 5-min loop tick (and immediately on a manual arm/disarm).
let stormState: StormState = { kind: "idle" };
let pendingManual: { armHours?: number; disarm?: boolean } | null = null;
let stormAlerts: StormAlert[] = [];
let stormSynthetic: SyntheticTrigger[] = [];
let lastStormPollAt: string | null = null;

/** Flatten a fetch error to its real network story: unwrap undici's .cause and expand
 *  AggregateError (happy-eyeballs) into per-attempt `CODE addr:port` entries (hub #66). */
function describeFetchError(err: unknown): string {
  const e = err as Error & { cause?: unknown };
  const cause = e.cause as (Error & { code?: string; address?: string; port?: number;
                                      errors?: Array<Error & { code?: string; address?: string; port?: number }> }) | undefined;
  if (!cause) return e.message;
  const one = (c: { code?: string; message?: string; address?: string; port?: number }) =>
    `${c.code ?? c.message}${c.address ? ` ${c.address}:${c.port ?? ""}` : ""}`;
  if (cause.errors?.length) return `${e.message} — attempts: ${cause.errors.map(one).join("; ")}`;
  return `${e.message} — cause: ${one(cause)}`;
}

/**
 * EMAIL subjects come from tierSubject (alertpolicy.ts) — deliberately not the ntfy title, which is an HTTP header
 * and must stay Latin-1 (see the sanitizer below).
 *
 * The 2026-08-20 bridge-offline alert was delivered and never opened. It was not a
 * plumbing failure: it read as "A2W: heat-pump bridge offline" in an inbox that also gets
 * twice-daily job alerts from `tenet-job <onboarding@resend.dev>` — the SAME sender
 * address, because both projects use Resend's shared onboarding domain. With the address
 * identical and the subject unremarkable, a genuine emergency looked like routine mail.
 *
 * So the tier leads, in the one place with room for it. Only a page gets the siren; if everything shouts, nothing does.
 */
/** °F for an email fact ("?" when unknown). */
const f0 = (v: number | null | undefined) => (v == null ? "?" : `${Math.round(v)} °F`);

async function ntfy(title: string, body: string, priority: string, opts: NotifyOpts): Promise<void> {
  await ntfyDelivered(title, body, priority, opts);
}

/**
 * Push (+ email by priority). Resolves true when at least one configured channel ACKNOWLEDGED the alert (2xx) — or
 * when no channel is configured at all (rehearsal / local: the log line is the delivery) — and false when every
 * configured channel failed or refused. ntfy() is the fire-and-log form every alert uses; #177's pending-notice path
 * calls this one and resolves its evidence only on true (codex pass 9).
 */
// ── 6bb push (owner 2026-10-19) ─────────────────────────────────────────────────────────────────────────────
// ntfy had no subscriber (the owner never installed it — 2026-08-23: "emails are plenty"), so no A2W push ever
// reached a phone. High/urgent alerts and their all-clears now also go to the 6bb app's token-protected
// /api/external/alert, which pushes to the owner's devices. Email is untouched. No-op unless both vars are set.
const SIXBB_ALERT_URL = process.env.SIXBB_ALERT_URL ?? "";
const SIXBB_ALERT_KEY = process.env.SIXBB_ALERT_KEY ?? "";
async function sixbbPush(source: string, title: string, body: string, priority: string, tag: string): Promise<boolean> {
  if (!SIXBB_ALERT_URL || !SIXBB_ALERT_KEY) return false;
  for (const delay of [0, 3_000, 12_000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const r = await fetch(SIXBB_ALERT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${SIXBB_ALERT_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ source, title: title.trim(), body, priority, tag }),
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok || r.status === 429) return r.ok;   // answered: a rate cap is not retried
      console.error(`6bb push rejected: HTTP ${r.status}`);
      return false;
    } catch (e) {
      console.error("6bb push attempt failed:", (e as Error).message);
    }
  }
  return false;
}
const pushTag = (t: string) => t.replace(/[^A-Za-z0-9 ]/g, "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 50);

const latches = new Latches(store);
const pageBudget = new PageBudget();
let pageBudgetSeeded = false;

async function ntfyDelivered(title: string, body: string, priority: string, opts: NotifyOpts): Promise<boolean> {
  const resolved = !!opts.resolved;
  let delivered = false;
  if (!NTFY_TOPIC) {
    // No topic (rehearsal, local runs): the page is still a fact — log it so a harness can assert what WOULD have paged.
    console.log(`[ntfy] (no topic) ${opts.tier}/${priority}${resolved ? " resolved" : ""}: ${title}`);
  }
  if (NTFY_TOPIC) {
    // HTTP headers are ByteStrings — a leading emoji (⚠ = U+26A0) THROWS and silently
    // kills the push. Caught live by the first /api/drill run (2026-08-06): the real
    // freeze-risk title would have died the same way in January. The bridge and hub were
    // sanitized long ago; the planner never was. Strip to Latin-1; the body stays UTF-8.
    const safeTitle = title.replace(/[^\x00-\xFF]/g, "").trim();
    // Railway→ntfy.sh is intermittently unreachable at the TCP level (#66) — same
    // 3-attempt retry as the hub. Non-2xx is not retried (the server answered).
    const delays = [0, 3_000, 12_000];
    for (let attempt = 1; attempt <= delays.length; attempt++) {
      if (delays[attempt - 1]) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      try {
        const r = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
          method: "POST",
          headers: { Title: safeTitle, Priority: priority, Tags: `hbx,${opts.tier}` },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) console.error("ntfy push rejected:", r.status);
        else { delivered = true; if (attempt > 1) console.log(`ntfy delivered on attempt ${attempt}`); }
        break;
      } catch (e) {
        console.error(`ntfy send attempt ${attempt}/${delays.length} failed:`, describeFetchError(e));
      }
    }
  }

  // Which tier actually applies: a keyed open already sent (this restart's re-fire, or within RENOTIFY_MS) goes no
  // further; a keyed all-clear is due only if its alert was sent, and at the tier it was sent at.
  let tier: Tier = opts.tier;
  let suppressed: string | null = null;
  if (opts.key && resolved) {
    tier = (await latches.release(opts.key, opts.tier)) ?? "record";
    if (tier === "record" && opts.tier !== "record") suppressed = "nothing was sent for it";
  } else if (opts.key && opts.tier !== "record" && !(await latches.claim(opts.key, opts.tier))) {
    tier = "record";
    suppressed = "already sent (latched)";
  }
  const want = route(tier, resolved);

  let pushed = false;
  if (want.push && SIXBB_ALERT_URL && SIXBB_ALERT_KEY) {
    // the key, when there is one, is the 6bb tag: the all-clear REPLACES its alert on the phone
    const pushPriority = resolved ? "default" : (priority === "urgent" || priority === "max" ? "urgent" : "high");
    pushed = await sixbbPush("a2w-planner", title, body, pushPriority, pushTag(opts.key ?? title));
    if (pushed) delivered = true;
  }
  let emailed = false;
  if (want.email && RESEND_API_KEY && RESEND_TO) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
          // Cloudflare fronts Resend and 403s blocklisted/bare client signatures (the
          // bridge's urllib silently failed for weeks on this, 2026-08-06) — honest UA.
          "User-Agent": "a2w-planner/1.0",
        },
        body: JSON.stringify({
          from: RESEND_FROM, to: [RESEND_TO], subject: tierSubject(title, tier, resolved), text: body,
          html: opts.html ?? renderAlertEmail({ tier, resolved, title, body, action: opts.action, facts: opts.facts, source: "A2W planner" }),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) console.error("resend email failed:", r.status);
      else { delivered = true; emailed = true; }
    } catch (e) {
      console.error("resend email failed:", (e as Error).message);
    }
  }

  if (tier === "page" && !resolved && pushed) {
    if (!pageBudgetSeeded) {
      pageBudgetSeeded = true;
      const n = await store.pagesLast7d().catch(() => 0);
      for (let i = 0; i < n; i++) pageBudget.note(Date.now() - 1);
    }
    const n = pageBudget.note();
    if (pageBudget.over()) console.error(`[alert-policy] PAGE BUDGET EXCEEDED: ${n} pages in 7 days (budget ${PAGE_BUDGET_PER_WEEK}) — the alerting is too loud; check the notifications table`);
  }
  await store.logNotification({ source: "planner", tier: opts.tier, resolved, key: opts.key ?? null, title, body,
                                pushed, emailed, suppressed }).catch((e) => console.error("notification log failed:", (e as Error).message));

  // record tier has no owner channel to acknowledge: it is delivered by being logged. Otherwise true when a channel
  // acknowledged, or when none of the wanted channels is configured (rehearsal / local: the log line is the delivery).
  if (tier === "record") return true;
  const anyChannel = !!NTFY_TOPIC || (want.email && !!RESEND_API_KEY && !!RESEND_TO)
    || (want.push && !!SIXBB_ALERT_URL && !!SIXBB_ALERT_KEY);
  return delivered || !anyChannel;
}

function toReading(dev: Record<string, any>): SlxReading {
  const demands: { name: string; activated: boolean }[] = dev.demands ?? [];
  const byName = (n: string) => demands.find((d) => d.name === n)?.activated ?? null;
  const relStat: number[] | undefined = dev.relStat;
  return {
    ts: new Date(),
    tankF: dev.temps?.temp1?.actual ?? null,
    tankTargetF: dev.temps?.temp1?.target ?? null,
    outdoorF: dev.temps?.temp3?.actual ?? null,
    hdActive: byName("hd"),
    cdActive: byName("cd"),
    stagesCalled: Array.isArray(dev.stages)
      ? dev.stages.map((s: { activated?: boolean }) => s.activated === true)
      : null,
    backupCalled: dev.backup?.activated ?? null,
    relays: Array.isArray(relStat)
      ? relStat.reduce((acc, bit, i) => acc | ((bit ? 1 : 0) << i), 0)
      : null,
    connected: dev.connected ?? null,
  };
}

/**
 * The target the pumps must cover right now — phaseb.ts operativeLeadF on this poll's report and the config the
 * drift check just recorded: the report, or the curve in force's output when stale-target.ts proves the report a
 * frozen post-lowering snapshot. The last hour of polls is read only when the report sits above the command by
 * more than the adoption tolerance; a failed read leaves the proof unproven and the report in charge.
 */
async function operativeTarget(reading: SlxReading, cfg: Record<string, unknown> | null): Promise<OperativeLead | null> {
  if (reading.tankTargetF == null) return null;
  const recent = staleProofApplicable(reading.tankTargetF, cfg) ? await store.getRecentSeries(1).catch(() => []) : [];
  return operativeLeadF({ reportedF: reading.tankTargetF, cfg, outdoorNowF: reading.outdoorF, recent, nowMs: Date.now() });
}

/**
 * I1 (plan §3): every online pump's setpoint must sit above tank target + margin, or the
 * tank sensor can't terminate calls (the calls-forever deadlock → bkLag → 16.5 kW element).
 * Edge-triggered: one high-priority alert on entry, one notice on clear.
 * The target is the OPERATIVE one (operativeTarget) — the same term Phase B leads. Checked against the raw report,
 * a frozen 139.9 °F would be a false I1 for the 7–16 h stretch after every soak once the setpoints (rightly) cover
 * the 120 °F curve instead, and isI1Violated() would idle the identification driver on it.
 */
async function checkI1(op: OperativeLead | null): Promise<void> {
  i1Operative = op ? { f: Math.round(op.f * 10) / 10, basis: op.basis, reported_f: op.reportedF, note: staleProofNote(op.verdict) } : null;
  if (!hub || op == null) return;
  const tankTargetF = op.f;
  let state;
  try {
    state = await hub.getState();
  } catch (e) {
    console.warn("I1 check skipped — hub unreachable:", (e as Error).message);
    piClockOffsetS = null; piClockOffsetAt = Date.now(); // a failed observation invalidates the last one
    return;
  }
  // #122 Wave 1: free ride — this state is already fetched every poll for the I1 check.
  // Wave 2 rides along too (see checkLeaseAndPi): one hub read per poll, never two.
  lastPiConnected = state.pi_connected === true;
  // #165: the live Pi-clock offset (planner now − the frame's Pi time). The Pi pushes a frame every 15 s, so a
  // connected, fresh frame measures its clock to within ~15 s + latency; piHealth voids windows while it is off.
  piClockOffsetS = state.pi_connected && typeof state.ts === "number" && state.ts > 0
    ? Date.now() / 1000 - (state.ts > 1e11 ? state.ts / 1000 : state.ts) : null;
  piClockOffsetAt = Date.now();
  // persisted — the planner-clock history /health.pi needs to trust a dropout verdict (pilink.ts) — OFF the control
  // path: not awaited, one write in flight at most, bounded pool, stamped with the measurement time (codex pass 19)
  if (piClockOffsetS != null && !piClockWriteBusy) {
    piClockWriteBusy = true;
    const prune = Date.now() - piClockPrunedAt > 3_600_000;
    if (prune) piClockPrunedAt = Date.now();
    void store.insertPiClockObservation(new Date(piClockOffsetAt), piClockOffsetS, prune)
      .catch((e) => console.error("pi clock observation failed:", (e as Error).message))
      .finally(() => { piClockWriteBusy = false; });
  }
  healthHubState = { state, atMs: Date.now(), offsetS: piClockOffsetS }; // pump health rides this read (no extra hub traffic)
  lastThermal.setpoints_f = Object.fromEntries(
    state.pumps.map((p) => [p.id, p.setpoint_c != null ? Math.round(cToF(p.setpoint_c) * 10) / 10 : null]),
  );
  const required = tankTargetF + DEFAULT_OPTS.i1MarginF;
  const offenders = state.pumps
    .filter((p) => p.online && p.setpoint_c != null && cToF(p.setpoint_c) < required)
    .map((p) => `${p.id} setpoint ${cToF(p.setpoint_c as number).toFixed(1)}°F < required ${required.toFixed(1)}°F`);
  if (offenders.length && !i1Violated) {
    i1Violated = true;
    i1Detail = offenders.join("; ");
    console.warn(`I1 VIOLATION: ${i1Detail}`);
    await store.openI1Episode(i1Detail).catch(() => {});
    await ntfy(
      "I1 violation: HP setpoint below HBX target + margin",
      `Tank target ${tankTargetF.toFixed(1)}°F${op.basis === "stale→curve" ? ` (the curve in force — SensorLinx still reports ${op.reportedF.toFixed(1)}°F, a frozen post-lowering snapshot)` : ""}.\n${i1Detail}\nUnreachable-target deadlock risk — raise the HP setpoint or lower the HBX target.`,
      "high",
      // ~0.4/day and usually self-clearing within a cycle — the /optimize banner and the
      // i1_episodes history carry it. Record only (alert-policy.md).
      { tier: "record" },
    );
  } else if (!offenders.length && i1Violated) {
    i1Violated = false;
    i1Detail = null;
    await store.closeI1Episode().catch(() => {});
    await ntfy("I1 cleared", `All online pump setpoints back above tank target + ${DEFAULT_OPTS.i1MarginF}°F.`, "default", { tier: "record", resolved: true });
  }
}

// I8 hygiene = a REAL pasteurizing DWELL, not a momentary touch. Legionella die in ~32 min at
// 60°C/140°F but need ~5–6 h at 55°C/131°F — so "the tank hit 131°F once" (the old bar) is not a
// disinfection. We require the tank to have HELD ≥ SANITIZE_VERIFY_F for ≥ SANITIZE_DWELL_MIN
// continuous minutes. VERIFY_F (134) sits a few °F under the 140°F aim to tolerate sensor slop while
// still confirming the soak substantially reached temp; the current continuous-135°F regime clears
// it, so this doesn't false-alarm before the cool-tank plan goes live.
const SANITIZE_VERIFY_F = 134;
const SANITIZE_DWELL_MIN = 30;

/** Demand-aware sanitize gate (I8): should the plan emit the day's 140°F soak block? Auto-sanitize OFF
 *  ⇒ always true (conservative daily soak). ON ⇒ true only when the last real pasteurizing dwell is old
 *  enough that the hygiene window would lapse within a day — so we soak at the plan's warmest (cheapest)
 *  hour BEFORE it expires, and skip a redundant soak otherwise. Errors ⇒ true (fail safe). The soak runs
 *  on the plan→autopilot→Phase B path (setpoint-coordinated so it clears I1); checkI8 only alarms. */
async function sanitizeDueNow(): Promise<{ due: boolean; urgent: boolean }> {
  if (!autoSanitizeLive) return { due: true, urgent: false }; // OFF = conservative daily soak
  try {
    const intervalH = hygieneIntervalH(lastOutdoorF, HYGIENE_BASE_INTERVAL_H, HYGIENE_SUMMER_INTERVAL_H, HYGIENE_SUMMER_OUTDOOR_F);
    const series = await store.getRecentSeries(intervalH);
    const lastEnd = lastDwellEnd(series, SANITIZE_VERIFY_F, SANITIZE_DWELL_MIN);
    const hoursSince = lastEnd ? (Date.now() - lastEnd.getTime()) / 3_600_000 : Infinity;
    // Soak ~a day before the window lapses; floor at 3h so the default 26h interval still soaks ~daily
    // (no behavior change), while a relaxed summer interval (e.g. 60h) skips days between soaks.
    const due = hoursSince >= Math.max(intervalH - 24, 3);
    // URGENT = the window has actually lapsed, so the plan must stop shopping for the warmest hour
    // (computeShadowPlan's deadline backstop). lastEnd === null means no qualifying dwell anywhere in
    // the lookback — which includes "telemetry was down so we can't prove one happened". Treating that
    // as urgent soaks redundantly at worst; the opposite error is the one that matters.
    const urgent = lastEnd == null || hoursSince >= intervalH;
    return { due, urgent };
  } catch (e) {
    console.error("sanitizeDue check failed — defaulting to soak:", (e as Error).message);
    return { due: true, urgent: false };
  }
}

/** I8 thermal hygiene (plan §5.1): page (and, when armed, auto-soak) if the season-aware interval
 *  passes without a real pasteurizing DWELL (≥SANITIZE_VERIFY_F for ≥SANITIZE_DWELL_MIN continuous
 *  min) — the DHW coil's potable slug must get its hot soak. The dwell decision + interval are pure
 *  (hygiene.ts) so they're unit-tested. Edge-alerted with a clear once satisfied. Trivially satisfied
 *  under as-found/current temps; load-bearing once the cool-tank optimized targets run. */
let i8Alerted = false;
let i8BlindAlerted = false; // separate edge for the "can't verify" page — see checkI8
// Owner alert policy: a missed hygiene window is record-only; only this long without any soak reaches the owner.
const I8_ATTENTION_H = 72;
let i8Escalated = false;
// Last checkI8 verdict, surfaced on /health so go-live is verifiable with one curl (is the actuator
// armed? what interval is in force? was the last window pasteurized?) — not inferable from __version__.
let i8LastIntervalH: number | null = null;
let i8LastDwellMin: number | null = null;
let i8LastSatisfied: boolean | null = null;
let i8LastCheckedAt: string | null = null;
let i8LastBlind: boolean | null = null;
let i8LastGapMin: number | null = null;
// Hours since the END of the last qualifying dwell — the number the dashboard shows. Computed here,
// off the SAME series and thresholds as the verdict, so the card can never drift from the runtime
// rule (it used to compute its own "hours since tank_f >= 131", a momentary touch, not a dwell).
let i8HoursSinceDwell: number | null = null;

// DHW draw-gap picture, refreshed each shadow tick off the same 14 d of tank history the window
// learner already pulls. This is the STAGNATION half of the Legionella condition — the hygiene
// interval is indexed on outdoor temp and knows only the temperature half. OBSERVABILITY ONLY:
// nothing here gates the soak (issue #51 rule 4 — only a real thermal dwell resets the clock).
const DRAW_WINDOW_DAYS = 14;
let dhwDraws: ReturnType<typeof drawGapStats> | null = null;
/** #135: the measured per-window sags behind the latest plan's pre-boosts (/health.dhw). */
let dhwPreBoosts: WindowSag[] = [];
let learnedWindowsForHealth: [number, number][] | null = null;
async function checkI8(): Promise<void> {
  const intervalH = hygieneIntervalH(lastOutdoorF, HYGIENE_BASE_INTERVAL_H, HYGIENE_SUMMER_INTERVAL_H, HYGIENE_SUMMER_OUTDOOR_F);
  const res = await store.getRecentSeries(intervalH);
  // Completeness gate scales with the window (≈ the original 200-of-26h ≈ 64%), so a sparse history
  // (planner just started / DB gap) never false-fires the alert or an auto-soak.
  const minReadings = Math.round((intervalH * 200) / 26);
  const { dwellMin, satisfied, overdue, blind, largestGapMin } = hygieneVerdict(res, {
    verifyF: SANITIZE_VERIFY_F,
    dwellMin: SANITIZE_DWELL_MIN,
    minReadings,
  });
  i8LastIntervalH = intervalH;
  i8LastDwellMin = Math.round(dwellMin);
  i8LastSatisfied = satisfied;
  i8LastCheckedAt = new Date().toISOString();
  i8LastBlind = blind;
  i8LastGapMin = Math.round(largestGapMin);
  const lastEnd = lastDwellEnd(res, SANITIZE_VERIFY_F, SANITIZE_DWELL_MIN);
  // null = no qualifying dwell anywhere in the window, which is exactly the `overdue` case below.
  i8HoursSinceDwell = lastEnd ? (Date.now() - lastEnd.getTime()) / 3_600_000 : null;

  // checkI8 is a pure MONITOR/alarm — it never actuates the soak. Actuation is the plan→autopilot→
  // Phase B path (demand-aware via sanitizeDueNow → computeShadowPlan), which leads the pump setpoints
  // so the 140°F soak clears I1. (The old checkI8 auto-boost was I1-deadlocked in the cool-tank regime:
  // it set target 140 against 125°F setpoints with nothing to raise them. Removed.) If a soak is somehow
  // missed, page the owner.
  if (overdue && !i8Alerted) {
    i8Alerted = true;
    const gapNote = largestGapMin >= 60
      ? `\n\nNote: telemetry also went dark for ${(largestGapMin / 60).toFixed(1)}h inside this window — the missed soak is likely a consequence.`
      : "";
    await ntfy(
      `I8 hygiene: no ${SANITIZE_DWELL_MIN}-min ≥${SANITIZE_VERIFY_F}°F soak in ${intervalH}h`,
      `The DHW coil's potable slug hasn't held a pasteurizing soak (needs ≥${SANITIZE_VERIFY_F}°F for ${SANITIZE_DWELL_MIN} min; best in the window: ${Math.round(dwellMin)} min). Boost the tank to ${DEFAULT_OPTS.sanitizeF}°F for ~2h (Control → HBX card), or check why the planner's sanitize didn't run.${gapNote}`,
      "high",
      // one missed window self-corrects (the planner schedules the soak at the next chance): record. Escalates to the
      // owner only after I8_ATTENTION_H with no soak at all — see below.
      { tier: "record" },
    );
  } else if (satisfied && i8Alerted) {
    i8Alerted = false;
    await ntfy("I8 hygiene satisfied", `Tank held ≥${SANITIZE_VERIFY_F}°F for ${Math.round(dwellMin)} min — daily pasteurization met.`, "default", { tier: "record", resolved: true });
    if (i8Escalated) {
      i8Escalated = false;
      await ntfy("I8 hygiene soak completed", `Tank held ≥${SANITIZE_VERIFY_F}°F for ${Math.round(dwellMin)} min.`, "default",
                 { tier: "attention", resolved: true, key: "i8-72h" });
    }
  }

  // BLIND: can't confirm a soak, and the window is too sparse to call it overdue. This state used to
  // be SILENT — which meant an outage could mute the very alarm it had just caused to be needed. On
  // 2026-07-31 a 17.75h gap left ~508 readings against a 462 threshold: the overdue page survived by
  // ~10%, and three more hours of downtime would have bought silence instead. "Can't verify" is not
  // "fine", so it gets its own page. Edge-triggered, and cleared once a real dwell is seen again.
  if (blind && !i8BlindAlerted) {
    i8BlindAlerted = true;
    await ntfy(
      "I8 hygiene: CANNOT VERIFY — telemetry gap",
      `The pasteurization monitor is blind: only ${res.length} of ~${minReadings}+ expected readings in the last ${intervalH}h, with a ${(largestGapMin / 60).toFixed(1)}h stretch of no data. This does NOT mean the soak was missed — it means we can't prove it happened. Check the bridge/Pi is reporting; the planner will soak at the earliest hour while the window reads as lapsed.`,
      "high",
      { tier: "record" }, // a symptom of the telemetry gap, which the Pi-unreachable page already covers
    );
  } else if (satisfied && i8BlindAlerted) {
    i8BlindAlerted = false;
    await ntfy("I8 hygiene verifiable again", `Telemetry recovered and the tank held ≥${SANITIZE_VERIFY_F}°F for ${Math.round(dwellMin)} min.`, "default", { tier: "record", resolved: true });
  }

  // The owner hears about hygiene only when it has been missed for I8_ATTENTION_H — days, not one window.
  if (i8Alerted && !i8Escalated) {
    const long = await store.getRecentSeries(I8_ATTENTION_H);
    if (long.length >= Math.round((I8_ATTENTION_H * 200) / 26) && !lastDwellEnd(long, SANITIZE_VERIFY_F, SANITIZE_DWELL_MIN)) {
      i8Escalated = true;
      await ntfy(
        `I8 hygiene: no ${SANITIZE_DWELL_MIN}-min ≥${SANITIZE_VERIFY_F}°F soak in ${I8_ATTENTION_H}h`,
        `The DHW coil has gone ${I8_ATTENTION_H}h without a pasteurizing soak (≥${SANITIZE_VERIFY_F}°F for ${SANITIZE_DWELL_MIN} min), so the planner's automatic sanitize is not landing. Boost the tank to ${DEFAULT_OPTS.sanitizeF}°F for ~2h (Control → HBX card) and check why the scheduled soak didn't run.`,
        "high",
        { tier: "attention", key: "i8-72h",
          action: `Boost the tank to ${DEFAULT_OPTS.sanitizeF}°F for about 2 hours (Control page → HBX card).`,
          facts: [["Last soak", i8HoursSinceDwell == null ? `more than ${I8_ATTENTION_H} h ago` : `${Math.round(i8HoursSinceDwell)} h ago`],
                  ["Needed", `${SANITIZE_VERIFY_F}°F for ${SANITIZE_DWELL_MIN} min`]] },
      );
    }
  }
}

/**
 * Called-but-not-running (owner ask 2026-07-15; §8.1's capacity-outage rule made live):
 * an HBX stage call is up but NO pump's compressors are running. Requires the condition
 * to persist ≥2 consecutive polls (~10 min) — anti-short-cycle restarts and normal
 * call-to-start ramps are innocent. This is the alarm HP2's silent winter failure never
 * had, and the exact state the A-4 power-cycle produced. Episodes persist for the
 * incident log; edge-triggered ntfy both ways.
 */
let unservedStreak = 0;
let unservedAlerted = false;
// #185: the per-stage alarm (stagewatch.ts). STAGE_PUMP_MAP is the PHYSICAL stage-relay → heat-pump wiring
// (README §Per-stage unserved alarm says how to verify it at the panel); default {"1":"pump1","2":"pump2"}.
const STAGE_MAP = parseStagePumpMap(process.env.STAGE_PUMP_MAP);
if (STAGE_MAP.error) console.warn(STAGE_MAP.error);
const stageWatch = new StageWatch(STAGE_MAP.map);
let stageEpisodes24h: Record<string, number> | null = null;
let lastLagTMin: number | null = null; // the HBX's lag-stage timer, from this poll's config (named in the page)

/**
 * #185: step the per-stage watch on this poll's HBX stages and the hub state the all-idle check already fetched (no
 * extra hub traffic). `state` null = unknown (hub unreachable); a disconnected / stale Pi frame is unverifiable too
 * (#167 piStateUnverifiable) — then nothing moves. Fault codes come from the mirror's pump_snapshots.
 */
async function checkStages(reading: SlxReading, state: HubState | null, anyStageCall: boolean): Promise<void> {
  // with no call nothing moves — except an open #212 reminder, which closes once the pump is seen switched back on
  const live = !anyStageCall && !stageWatch.remindersOpen() ? [] : state && !piStateUnverifiable(state) ? state.pumps : null;
  let pumps: StagePump[] | null = live;
  if (live && live.some((p) => p.state === "fault")) {
    // codes only ANNOTATE a live fault, and only from a snapshot ≤ 15 min old (the Pi attaches one every ~5 min)
    // an annotation only — bounded (store's bounded pool), and a failure or timeout simply means no codes
    const codes = await store.pumpFaultCodes().catch(() => ({} as Record<string, { codes: string[]; ts: number }>));
    const nowS = Date.now() / 1000;
    pumps = live.map((p) => {
      const c = codes[p.id];
      return p.state === "fault" && c && Math.abs(nowS - c.ts) <= 15 * 60 ? { ...p, fault_codes: c.codes } : p;
    });
  }
  const events = stageWatch.step({ nowMs: Date.now(), stagesCalled: reading.stagesCalled, pumps, lagTMin: lastLagTMin });
  if (alertStateRestored && pumps != null && reading.stagesCalled != null) stageEvaluatedSinceRestore = true;
  for (const e of events) {
    if (e.kind === "open") {
      console.warn(`[stagewatch] ${e.title}: ${e.body}`);
      await openAlert(e.type, e.stage, e.pumpId, e.title, e.body);
    } else {
      await alerts.close(e.type, e.stage);
      await ntfy(e.title, e.body, "default", { tier: episodeTier(e.type), resolved: true });
    }
  }
  stageEpisodes24h = await store.alertEpisodes24h().catch(() => stageEpisodes24h);
}

/**
 * #183: the storm machine always starts idle (its state is in memory), so any storm_events row still open from BEFORE
 * this process started is an orphan — close it, or the mirror banner shows "armed" while /health.storm is idle. A storm
 * still live re-arms on the next trigger poll and opens a fresh row. A failed sweep is retried every tick (codex pass
 * 4), scoped to rows started before boot, so it can never close a storm this process armed meanwhile.
 */
const PROCESS_START = new Date();
const pendingStandDowns: Date[] = [];
async function retryStormStandDown(): Promise<void> {
  while (pendingStandDowns.length) {
    const at = pendingStandDowns[0];
    try { await store.closeStormEvents("stand-down", at, at); pendingStandDowns.shift(); }
    catch (e) { console.error("storm stand-down close failed (retried next tick):", (e as Error).message); return; }
  }
}
let stormSweepDone = false;
async function sweepStormOrphans(): Promise<void> {
  if (stormSweepDone) return;
  try {
    const closed = await store.closeStormEvents("planner restart while idle", PROCESS_START, PROCESS_START, true);
    stormSweepDone = true;
    if (closed) console.log(`[storm] closed ${closed} orphaned storm_events row(s) — planner restart while idle`);
  } catch (e) {
    console.error("storm orphan sweep failed (retried next tick):", (e as Error).message);
  }
}

/**
 * #185 / #187: open alert episodes are re-adopted at boot — they close on clear instead of re-paging; undelivered ones
 * are re-sent by alerts.retry(). A FAILED load is not "nothing open" (codex pass 3): it is retried every tick until it
 * succeeds. Until then the watches run anyway — a page must never wait on the DB — and a late restore reconciles
 * itself: an adopted episode whose condition has cleared is closed by the next step, and closeAlertEpisodes closes
 * every row of that kind/key, so a duplicate opened meanwhile closes with it.
 */
let alertStateRestored = false;
let stageEvaluatedSinceRestore = false; // set by checkStages after a successful restore
let spanEvaluatedSinceRestore = false;  // set by checkSpanLocal after a successful restore
async function restoreAlertState(): Promise<void> {
  if (alertStateRestored) return;
  try {
    const open = await store.openAlertEpisodes();
    // a stage episode is re-adopted only if it is about the pump that stage maps to NOW: after STAGE_PUMP_MAP was
    // corrected, an old episode for the wrong unit is closed, never allowed to suppress the right one (codex pass 10)
    const isStage = (o: { kind: string }) => o.kind === "stage_unserved" || o.kind === "fault_called" || o.kind === "stopped_reminder";
    // an episode the outbox is already closing (opened and recovered while restore was failing) is never re-adopted —
    // re-adopting it would latch the watch "open" over rows being closed and silence a recurrence (codex pass 11)
    // pump health: a shadow episode belongs to the shadow outbox, a live one to the paging outbox; one whose check was
    // promoted or demoted since it opened is closed — the watch re-evaluates and re-opens it under the current mode
    const ph = open.map((o) => ({ o, k: parseEpisodeKind(o.kind) }));
    const phKeep = ph.filter(({ o, k }) => k && k.live === PH_LIVE.live.has(k.check) && !(k.live ? alerts : shadowAlerts).isClosing(o.id, o.uid));
    const phStale = ph.filter(({ o, k }) => k && k.live !== PH_LIVE.live.has(k.check)).map(({ o }) => o);
    // backup gate: an open episode of the CURRENT mode's kind = the gate closed the breaker (virtually, in shadow); one
    // of the other mode is closed — a shadow "would close" is not a breaker the live gate closed, and vice versa
    const isGate = (o: { kind: string }) => o.kind === "backup_gate" || o.kind === "backup_gate_shadow";
    const gateOpen = open.filter((o) => isGate(o) && !alerts.isClosing(o.id, o.uid) && !gateShadowAlerts.isClosing(o.id, o.uid));
    const gateKeep = gateOpen.filter((o) => o.kind === backupGateKind);
    const gateStale = gateOpen.filter((o) => o.kind !== backupGateKind);
    const { keep, stale } = partitionRestore(open.filter((o) => !parseEpisodeKind(o.kind) && !isGate(o) && !alerts.isClosing(o.id, o.uid)), STAGE_MAP.map);
    if (stale.length || phStale.length || gateStale.length) await store.closeAlertEpisodeIds([...stale, ...phStale, ...gateStale].map((o) => o.id)); // a failure → the whole restore retries
    alerts.adopt(keep);
    (BACKUP_GATE_CFG.mode === "live" ? alerts : gateShadowAlerts).adopt(gateKeep);
    if (gateKeep.length) backupGate.restore({ closedByGate: true, atMs: Date.now() }); // dwell restarts now: conservative
    alerts.adopt(phKeep.filter(({ k }) => k!.live).map(({ o }) => o));
    shadowAlerts.adopt(phKeep.filter(({ k }) => !k!.live).map(({ o }) => o));
    pumpWatch.restore(phKeep.filter(({ o }) => o.pumpId != null).map(({ o, k }) => ({ check: k!.check, pumpId: o.pumpId as string })));
    stageWatch.restore(keep.filter(isStage)
      .map((o) => ({ type: o.kind as "stage_unserved" | "fault_called" | "stopped_reminder", stage: o.key })));
    if (keep.some((o) => o.kind === "span_local_stale")) spanLocalAlarm.restore(true);
    alertStateRestored = true;
  } catch (e) {
    console.error("alert state restore failed (retried next tick):", (e as Error).message);
  }
}

// #185 / #187: the alert outbox (alerts.ts) — pages resolved only on acknowledged delivery, re-sent every poll.
const alerts = new AlertOutbox(store, (title, body, kind) => ntfyDelivered(title, body, "high", { tier: episodeTier(kind) }));
async function openAlert(kind: string, key: string, pumpId: string | null, title: string, body: string): Promise<void> {
  await alerts.open(kind, key, pumpId, title, body);
}

// #187: the SPAN-local heartbeat (spanlocal.ts) — refreshed every poll, served from here on /health.span.
const spanLocalAlarm = new SpanLocalAlarm();
let spanLocal: SpanHealth | null = null;
let spanLocalError: string | null = null;
async function checkSpanLocal(): Promise<void> {
  const nowS = Date.now() / 1000;
  const cloud = {
    enabled: !!spanWatch, last_ok_at: spanWatch?.lastOkAt ?? null,
    fail_streak: spanWatch?.failStreak ?? 0, last_error: spanWatch?.lastError ?? null,
    // the backup-element alarm's inputs: energy the element drew in the trailing 60 min (what pages at
    // SPAN_BACKUP_ALARM_KWH) and SPAN's day-cumulative reading it is differenced from.
    backup_kwh_last_hour: spanWatch?.lastHourKwh ?? null, backup_kwh_today: spanWatch?.lastDayKwh ?? null,
    backup_alarmed: spanWatch?.alarmed ?? false,
  };
  spanLocal = spanHealth(await store.spanLocalLatest(nowS), nowS, cloud);
  spanLocalError = null;
  const n = spanLocalAlarm.step(spanLocal);
  if (alertStateRestored && spanLocal.local_stale !== null) spanEvaluatedSinceRestore = true;
  if (n && !n.resolved) await openAlert("span_local_stale", "span", null, n.title, n.body);
  else if (n) {
    await alerts.close("span_local_stale", "span");
    await ntfy(n.title, n.body, n.priority, { tier: episodeTier("span_local_stale"), resolved: true });
  }
}

/**
 * Pump health (pumphealth.ts; owner ask 2026-10-19): the "running but not doing its job, no fault code" checks, every
 * tick, independent of SensorLinx. SHADOW by default: an episode is written to alert_episodes as shadow_pump_<check>,
 * logged, shown on /health.pump_health and in the daily digest — never paged. PUMP_HEALTH_LIVE=<check,…> promotes a
 * check to the paging outbox (kind pump_<check>). Thresholds: knowledge/reference/pump-health-baseline-20261019.md.
 * Gated like stagewatch: no live Pi frame (#167 piStateUnverifiable) or no measured Pi clock offset → nothing moves.
 */
const PUMP_HEALTH_ENABLED = process.env.PUMP_HEALTH_ENABLED !== "0";
const PUMP_HEALTH_DIGEST = process.env.PUMP_HEALTH_DIGEST !== "0";
const PUMP_HEALTH_DIGEST_HOUR = Number(process.env.PUMP_HEALTH_DIGEST_HOUR ?? "7"); // America/New_York
const PH_LIVE = parseLiveChecks(process.env.PUMP_HEALTH_LIVE);
if (PH_LIVE.error) console.warn(PH_LIVE.error);
/** pump id → SPAN circuit name. The default is the map the owner confirmed for self-heal (Pi config, 2026-10-19). */
const PUMP_SPAN_CIRCUITS: Record<string, string> = (() => {
  const dflt = { pump1: "Air-Water 1", pump2: "Air-Water 2" };
  const raw = process.env.PUMP_SPAN_CIRCUITS;
  if (!raw?.trim()) return dflt;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const ok = v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string" && x.trim());
    if (!ok || !Object.keys(v).length) throw new Error("not a {pump: circuit} object");
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x).trim()]));
  } catch (e) {
    console.warn(`PUMP_SPAN_CIRCUITS ignored (${(e as Error).message}) — using the default`);
    return dflt;
  }
})();
let healthHubState: { state: HubState; atMs: number; offsetS: number | null } | null = null;
const pumpWatch = new PumpHealthWatch();
let pumpNames: Record<string, string> = {};
let pumpHealthGate: string | null = "not evaluated yet";
let pumpHealthError: string | null = null;
let pumpDailyError: string | null = null;
let pumpHealthAt: string | null = null;
let pumpEvaluatedSinceRestore = false;
// shadow episodes: same outbox machinery, but the "channel" is the log line — never ntfy, never email
const shadowAlerts = new AlertOutbox(store, async (title, body) => { console.warn(`[pumphealth][shadow] ${title}: ${body}`); return true; });

async function checkPumpHealth(): Promise<void> {
  if (!PUMP_HEALTH_ENABLED) { pumpHealthGate = "disabled (PUMP_HEALTH_ENABLED=0)"; return; }
  if (!hub) { pumpHealthGate = "no hub configured"; return; }
  // ride checkI1's read when it is from this tick; otherwise (SensorLinx down, no tank target) read the hub ourselves
  if (!healthHubState || Date.now() - healthHubState.atMs > 4 * 60_000) {
    try {
      const state = await hub.getState();
      const offsetS = state.pi_connected && typeof state.ts === "number" && state.ts > 0
        ? Date.now() / 1000 - (state.ts > 1e11 ? state.ts / 1000 : state.ts) : null;
      healthHubState = { state, atMs: Date.now(), offsetS };
    } catch (e) {
      pumpHealthGate = `hub unreachable: ${(e as Error).message}`;
      return;
    }
  }
  const { state, offsetS } = healthHubState;
  const blind = piStateUnverifiable(state) ?? (offsetS == null ? "Pi clock offset unknown" : null);
  if (blind) { pumpHealthGate = blind; return; } // a blind spell never opens or closes an episode
  pumpNames = Object.fromEntries(state.pumps.map((p) => [p.id, p.name?.trim() || p.id]));
  const ids = state.pumps.map((p) => p.id).filter((id) => PUMP_SPAN_CIRCUITS[id]);
  const nowS = Date.now() / 1000;
  const nowPi = nowS - (offsetS as number);
  const from = nowPi - PH.LOOKBACK_S;
  const readings = await store.pumpReadingsWindow(ids, from, nowPi + 60);
  const span = await store.spanWindow(ids.map((id) => PUMP_SPAN_CIRCUITS[id]), from, nowPi + 60);
  if (!readings || !span) { pumpHealthGate = "mirror tables absent (readings / span_readings)"; return; }
  const tank = (await store.tankWindow(new Date((nowS - PH.LOOKBACK_S) * 1000)))
    .map((t) => ({ ...t, ts: t.ts - (offsetS as number) })); // planner clock → Pi clock, like the readings
  const uaRaw = Number((winterDpState as Record<string, unknown> | null)?.tank_ua);
  const ua = Number.isFinite(uaRaw) && uaRaw > 0 ? uaRaw : DEFAULT_TANK_UA;
  const verdicts: Verdict[] = [];
  for (const id of ids) verdicts.push(...evaluatePump(id, readings[id] ?? [], span[PUMP_SPAN_CIRCUITS[id]] ?? [], nowPi));
  for (const [stage, id] of Object.entries(STAGE_MAP.map)) {
    if (!PUMP_SPAN_CIRCUITS[id]) continue;
    verdicts.push(evaluateTankFlat(stage, id, readings[id] ?? [], span[PUMP_SPAN_CIRCUITS[id]] ?? [], tank, nowPi, ua));
  }
  pumpHealthGate = null;
  pumpHealthAt = new Date().toISOString();
  if (alertStateRestored && verdicts.some((v) => v.state !== "unknown")) pumpEvaluatedSinceRestore = true;
  pumpWatch.setNames(pumpNames);
  for (const e of pumpWatch.step(verdicts)) {
    const live = PH_LIVE.live.has(e.check);
    const kind = episodeKind(e.check, live);
    const title = e.title;
    if (e.kind === "open") {
      if (live) await openAlert(kind, e.pumpId, e.pumpId, `⚠ ${title}`, e.body);
      else await shadowAlerts.open(kind, e.pumpId, e.pumpId, `${title} (shadow)`, e.body);
    } else if (live) {
      await alerts.close(kind, e.pumpId);
      await ntfy(title, e.body, "default", { tier: episodeTier(kind), resolved: true });
    } else {
      await shadowAlerts.close(kind, e.pumpId);
      console.log(`[pumphealth][shadow] ${title}: ${e.body}`);
    }
  }
}

/** The daily rollup: one missing day per tick (yesterday first, then back-fill to the trend's 21 days), then the trend. */
let pumpDays: DayRow[] = [];
let pumpDaysLoaded = false;
let pumpTrend: TrendOut | null = null;
let pumpDigestDoneFor: string | null = null;
let pumpDigestLast: { day: string; sent_at: string } | null = null;
const TREND_SPAN_DAYS = TREND.CUR_DAYS + TREND.BASE_DAYS;
const dayAdd = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
async function checkPumpHealthDaily(): Promise<void> {
  if (!PUMP_HEALTH_ENABLED) return;
  const nowS = Date.now() / 1000;
  const today = etDay(nowS);
  const yesterday = dayAdd(today, -1);
  const since = dayAdd(today, -TREND_SPAN_DAYS);
  if (!pumpDaysLoaded) { pumpDays = await store.pumpHealthDays(since); pumpDaysLoaded = true; }
  const ids = Object.keys(PUMP_SPAN_CIRCUITS);
  const have = new Set(pumpDays.map((r) => `${r.day}\u0000${r.pumpId}`));
  // a day is rolled up once it has been over for 30 min (the mirror's push lag), newest first
  for (let d = yesterday; d >= since; d = dayAdd(d, -1)) {
    const missing = ids.filter((id) => !have.has(`${d}\u0000${id}`));
    if (!missing.length) continue;
    const fromS = etDayStart(d), toS = etDayStart(dayAdd(d, 1));
    if (nowS < toS + 30 * 60) continue;
    const readings = await store.pumpReadingsWindow(missing, fromS - 300, toS);
    const span = await store.spanWindow(missing.map((id) => PUMP_SPAN_CIRCUITS[id]), fromS, toS);
    if (!readings || !span) return; // rehearsal DB without the mirror tables
    for (const id of missing) {
      const m = rollupDay(readings[id] ?? [], span[PUMP_SPAN_CIRCUITS[id]] ?? [], fromS, toS);
      await store.upsertPumpHealthDay(d, id, m);
      pumpDays.push({ day: d, pumpId: id, m });
    }
    break; // one day per tick: the back-fill never puts a burst of reads on the production database
  }
  pumpDays = pumpDays.filter((r) => r.day >= since);
  pumpTrend = trend(pumpDays, ids, yesterday);

  // the digest: once per day after PUMP_HEALTH_DIGEST_HOUR, when yesterday is rolled up for every pump
  if (!PUMP_HEALTH_DIGEST || pumpDigestDoneFor === yesterday || etHour(nowS) < PUMP_HEALTH_DIGEST_HOUR) return;
  if (!ids.every((id) => pumpDays.some((r) => r.day === yesterday && r.pumpId === id))) return;
  if (!(await store.claimPumpDigest(yesterday))) { pumpDigestDoneFor = yesterday; return; } // sent already (or by a peer)
  try {
    const eps = await store.pumpHealthEpisodes24h().catch(() => []);
    const { title, body, html } = digest(yesterday, pumpDays, pumpTrend, eps, pumpWatch.status(), pumpNames, PH_LIVE.live);
    // a normal day is record-only (dashboard + Monday digest); a flagged drift is worth an email
    if (await ntfyDelivered(title, body, "default", { tier: /drift flagged/.test(title) ? "attention" : "record", html })) {
      await store.markPumpDigestSent(yesterday);
      pumpDigestDoneFor = yesterday;
      pumpDigestLast = { day: yesterday, sent_at: new Date().toISOString() };
    } else {
      await store.releasePumpDigest(yesterday); // no channel heard it — the next tick retries
    }
  } catch (e) {
    await store.releasePumpDigest(yesterday).catch(() => {});
    throw e;
  }
}

/**
 * The backup element's DYNAMIC gate (backupgate.ts; owner rule 2026-10-19): close the Buffer Tank breaker when a pump has
 * failed and the rest cannot hold the tank, or every available pump runs and the tank stays below the floor; re-open it
 * once recovered. SHADOW by default (BACKUP_GATE): pages "would close / would open" through the alert outbox (episode
 * kind backup_gate_shadow — open = the gate's virtual breaker is closed) and switches nothing. BACKUP_GATE=live sends the
 * close through the hub (needs HUB_ARM_TOKEN) to the Pi's guarded BreakerController; re-opening a live breaker also needs
 * BACKUP_GATE_REOPEN=1 here and span.backup_reopen on the Pi (both off; owner OK). Runs on the writer only, every poll.
 * Thresholds: knowledge/reference/backup-gate-thresholds.md. The Pi-local fallback (both pumps down, no cloud) is the
 * bridge's backup_fallback.py; its status rides the hub state frame and is shown beside this one on /health.
 */
const BACKUP_GATE_CFG = parseGateConfig(process.env);
for (const e of BACKUP_GATE_CFG.errors) console.warn(e);
const BACKUP_CIRCUIT = "Buffer Tank";
const HUB_ARM_TOKEN = process.env.HUB_ARM_TOKEN ?? "";
const backupGate = new BackupGate(BACKUP_GATE_CFG.mode, BACKUP_GATE_CFG.reopen, BACKUP_GATE_CFG.t);
const backupGateKind = BACKUP_GATE_CFG.mode === "live" ? "backup_gate" : "backup_gate_shadow";
let backupGateBlind: string | null = "not evaluated yet";
let backupGateError: string | null = null;
let backupGateHub: { relay: string | null; element_w: number | null; pi_fallback: Record<string, unknown> | null } = { relay: null, element_w: null, pi_fallback: null };
let backupGateEpisodes7d: number | null = null;
// shadow episodes page through their OWN outbox: default priority (never a 6bb phone push — #211 pushes high/urgent and
// every `resolved`), email forced on, so a would-close is one email per episode, re-sent only until a channel hears it.
// The would-open is a log line + /health + the dashboard: no second email.
// shadow mode never notifies the owner (alert-policy.md): the episode row, /health and the dashboard carry it
const gateShadowAlerts = new AlertOutbox(store, (title, body) => ntfyDelivered(title, body, "default", { tier: "record" }));

async function checkBackupGate(reading: SlxReading): Promise<void> {
  if (BACKUP_GATE_CFG.mode === "off") { backupGateBlind = "disabled (BACKUP_GATE=off)"; return; }
  if (!hub) { backupGateBlind = "no hub configured"; return; }
  // one gate per house: a second instance mid-handover only reports (it would page / command twice)
  if (WRITER_LEASE_ENABLED && !(writerLeaseState?.held ?? false)) { backupGateBlind = "not the writer-lease holder"; return; }
  let state: HubState | null = null;
  backupGateError = null; // a failed live command stays visible as backup_gate.retry_at
  try { state = await hub.getState(); } catch (e) { state = null; backupGateError = `hub unreachable: ${(e as Error).message}`; }
  const blind = state ? piStateUnverifiable(state) : "hub unreachable";
  const bt = state?.span?.circuits?.find((c) => c.name === BACKUP_CIRCUIT) ?? null;
  const relay = bt?.relay_state === "OPEN" || bt?.relay_state === "CLOSED" ? bt.relay_state : null;
  backupGateHub = {
    relay, element_w: typeof bt?.power_w === "number" ? Math.abs(bt.power_w) : null,
    pi_fallback: (state?.span?.backup_fallback as Record<string, unknown> | undefined) ?? null,
  };
  // per-stage episodes (stagewatch, stepped just before this in the same poll) mark the pump wired to that stage
  const stages = stageWatch.status();
  const pumps: GatePump[] | null = state && !blind
    ? state.pumps.map((p) => ({
        id: p.id, name: p.name, online: p.online, state: p.online ? p.state ?? null : "offline",
        stageEpisode: Object.values(stages).some((s) => s.pump === p.id && (s.unserved_open || s.fault_open)),
      }))
    : null;
  backupGateBlind = blind;
  const events = backupGate.step({
    nowMs: Date.now(), tankF: reading.tankF, tankTargetF: reading.tankTargetF, stagesCalled: reading.stagesCalled,
    pumps, relay: blind ? null : relay,
  });
  const outbox = BACKUP_GATE_CFG.mode === "live" ? alerts : gateShadowAlerts;
  for (const e of events) {
    console.warn(`[backupgate][${BACKUP_GATE_CFG.mode}] ${e.title}: ${e.body}`);
    if (e.kind === "confirmed") {
      // a live command whose hub answer was lost, now seen done on the relay: record it as the gate's own
      if (e.confirms === "close") await openAlert(backupGateKind, "buffer_tank", null, e.title, e.body);
      else { await alerts.close(backupGateKind, "buffer_tank"); await ntfyDelivered(e.title, e.body, "default", { tier: episodeTier(backupGateKind), resolved: true }); }
      continue;
    }
    if (e.kind !== "close" && e.kind !== "open") { await ntfyDelivered(e.title, e.body, e.priority, { tier: "record" }); continue; }
    if (BACKUP_GATE_CFG.mode === "live") {
      // the Pi's BreakerController verifies the relay read-back; the gate (and its episode) changes only on a verified
      // answer. A refusal (a bridge guard said no) stands the gate down for the episode; no Pi / no answer retries after
      // BG.RETRY_MS, and a late landing is confirmed from the relay. Either way the failure pages ONCE per episode.
      const fresh = !shuttingDown && (!WRITER_LEASE_ENABLED || await store.holdsWriterLease(INSTANCE_ID, INSTANCE_FRESH_MS));
      const r = !HUB_ARM_TOKEN ? { ok: false, refused: true, detail: "HUB_ARM_TOKEN is not set on the planner" }
        : !fresh ? { ok: false, refused: false, detail: "lost the writer lease" }
        : await hub.sendBreaker(BACKUP_CIRCUIT, e.kind, HUB_ARM_TOKEN, "backup-gate");
      const { page } = backupGate.applied(r.ok, Date.now(), r.refused);
      backupGateError = r.ok ? null : `${e.kind} ${r.refused ? "refused" : "failed"}: ${r.detail}`;
      if (!r.ok) {
        if (page) {
          await ntfyDelivered(`A2W could not ${e.kind} the backup element breaker`,
            `${r.detail}. ` + (r.refused ? "A bridge guard refused it; A2W will not retry until the condition ends. "
              : `A2W retries every ${BG.RETRY_MS / 60_000} min while the condition holds (no further pages). `) +
            (e.kind === "close" ? "If the house is losing heat, switch the Buffer Tank breaker ON at the SPAN panel. " : "") + e.body, "high",
            // a close that didn't land needs a hand at the panel; an open that didn't is only cost
            { tier: e.kind === "close" ? "page" : "attention",
              action: e.kind === "close" ? "Switch the Buffer Tank breaker ON at the SPAN panel if the house is losing heat."
                                         : "Switch the Buffer Tank breaker OFF at the SPAN panel when convenient (it is only costing money)." });
        }
        continue;
      }
    }
    if (e.kind === "close") await outbox.open(backupGateKind, "buffer_tank", null, e.title, e.body);
    else if (BACKUP_GATE_CFG.mode === "live") {
      await alerts.close(backupGateKind, "buffer_tank");
      await ntfyDelivered(e.title, e.body, "default", { tier: episodeTier(backupGateKind), resolved: true });
    } else {
      await gateShadowAlerts.close(backupGateKind, "buffer_tank"); // log + /health + dashboard only: no second email
    }
  }
  backupGateEpisodes7d = await store.alertEpisodesSince(backupGateKind, 7 * 24).catch(() => backupGateEpisodes7d);
}

// Owner alert policy: 29 of 36 unserved calls in Sept–Oct cleared within 15 min (start-up, defrost). The buffer tank
// carries the house for hours, so only a call left unserved this long is a page.
const UNSERVED_PAGE_POLLS = 9; // ~45 min at the 5-min poll
async function checkUnservedCall(reading: SlxReading): Promise<void> {
  if (!hub) return;
  const anyStageCall = reading.stagesCalled?.some(Boolean) === true;
  // one hub read serves both alarms; the stage watch runs first and never changes the all-idle logic below
  let st: HubState | null = null;
  if (anyStageCall || stageWatch.remindersOpen()) { try { st = await hub.getState(); } catch { st = null; } }
  await checkStages(reading, st, anyStageCall).catch((e) => console.error("stage check failed:", (e as Error).message));
  if (!anyStageCall) {
    unservedStreak = 0;
    if (unservedAlerted) {
      unservedAlerted = false;
      await store.closeUnservedEpisode().catch(() => {});
      await ntfy("Unserved call cleared", "The heat call ended or a pump is running again.", "default", { tier: "page", resolved: true, key: "no-heat" });
    }
    return;
  }
  if (!st) return; // hub unreachable — can't judge; don't false-alarm
  const running = st.pumps.some((p) => p.online && p.state === "heating");
  if (running) {
    unservedStreak = 0;
    if (unservedAlerted) {
      unservedAlerted = false;
      await store.closeUnservedEpisode().catch(() => {});
      await ntfy("Unserved call cleared", "A pump is running against the call again.", "default", { tier: "page", resolved: true, key: "no-heat" });
    }
    return;
  }
  if (!piStateUnverifiable(st) && calledStagesAllStopped(reading.stagesCalled, STAGE_MAP.map, st.pumps)) {
    // #212: every called stage's pump was switched off by a person (6bb / SPAN app / the panel). No heat is the owner's
    // choice, not a failure: the stage watch's one stopped_reminder covers a forgotten switch-off. The streak restarts.
    unservedStreak = 0;
    return;
  }
  unservedStreak++;
  if (unservedStreak >= UNSERVED_PAGE_POLLS && !unservedAlerted) {
    unservedAlerted = true;
    const detail = `HBX stage call active ~${unservedStreak * 5} min with no pump running (tank ${reading.tankF ?? "?"}°F / target ${reading.tankTargetF ?? "?"}°F)`;
    await store.openUnservedEpisode(detail).catch(() => {});
    await ntfy(
      "⚠ Heat call active but NO pump is running",
      `${detail}. Causes: pump powered off, failure-to-start (the HP2 winter pattern), or a write-disabled/faulted unit. The tank is falling while HBX waits.`,
      "high",
      // THE "no heat" incident: the per-stage unserved/fault-called episodes are its record-only symptoms
      { tier: "page", key: "no-heat",
        action: "Check both heat pumps: is each one powered on, and is either showing a fault code? Power-cycling a faulted pump's breaker at the SPAN panel often clears it.",
        facts: [["No heat for", `${unservedStreak * 5} min`], ["Tank", `${f0(reading.tankF)} (target ${f0(reading.tankTargetF)})`],
                ["Outdoor", f0(reading.outdoorF)],
                ["Pumps", st.pumps.map((p) => `${p.name ?? p.id}: ${p.online ? p.state ?? "?" : "offline"}`).join(" · ")]] },
    );
  }
}

/** R3 element accounting (plan §5.5): the 16.5 kW element being CALLED is always worth a
 *  page — legitimate on a design-cold day, a planner bug or config drift any other time.
 *  Edge-triggered; the element's actual runtime (breaker permitting) lives in SPAN. */
let backupWasCalled = false;
async function checkBackupCalled(called: boolean | null): Promise<void> {
  if (called === true && !backupWasCalled) {
    backupWasCalled = true;
    await ntfy(
      "16.5 kW backup element CALLED",
      "HBX has called the backup element (≈$5/hour if its breaker is on). Legitimate in design-cold; otherwise investigate.",
      "high",
      { tier: "record" }, // a call is not a draw: the SPAN power alarm (spanwatch) is the one that emails
    );
  } else if (called === false && backupWasCalled) {
    backupWasCalled = false;
    await ntfy("Backup element call ended", "HBX released the backup element.", "default", { tier: "record", resolved: true });
  }
}

/** DHW-comfort shortfall (owner ask 2026-07-16, load-bearing now that autopilot holds a low buffer):
 *  the buffer sits BELOW the DHW-ready floor for a SUSTAINED period — the HPs can't hold hot-water temp
 *  (a big draw, a genuine capacity shortfall, or a stuck-low autopilot target). This is the gap I8 does
 *  NOT cover: I8 verifies a daily HOT soak; this catches the opposite — the tank running too COLD to
 *  shower. Detection + high-priority page only (the HBX's own bkLag escalates to the element on a real
 *  drawn-down call, breaker permitting; auto-raising the target here would fight autopilot's rate-limit).
 *  Edge-triggered both ways. */
const DHW_SHORTFALL_F = 113;   // below the 45 °C unattended floor → clearly cold for delivery (normal cycle bottoms ~117°F)
const DHW_SHORTFALL_POLLS = 12; // ~60 min sustained at the 5-min poll — a draw dip recovers well inside that (alert-policy.md)
let dhwShortfallStreak = 0;
let dhwShortfallAlerted = false;
async function checkDHWShortfall(reading: SlxReading): Promise<void> {
  if (reading.tankF == null) return;
  if (reading.tankF >= DHW_SHORTFALL_F) {
    dhwShortfallStreak = 0;
    if (dhwShortfallAlerted) {
      dhwShortfallAlerted = false;
      await ntfy("DHW shortfall cleared", `Buffer back to ${reading.tankF.toFixed(0)}°F — hot water recovered.`, "default", { tier: "page", resolved: true, key: "dhw-shortfall" });
    }
    return;
  }
  dhwShortfallStreak++;
  if (dhwShortfallStreak >= DHW_SHORTFALL_POLLS && !dhwShortfallAlerted) {
    dhwShortfallAlerted = true;
    // one incident, one page: a cold tank while the "no heat" page is open is that incident's symptom (Oct 11 and
    // Oct 15 2026, HP2 E21: both fired for the same outage)
    const tier: Tier = unservedAlerted ? "record" : "page";
    await ntfy(
      "⚠ DHW comfort shortfall — buffer running cold",
      `Buffer ${reading.tankF.toFixed(0)}°F, below the ${Math.round(DEFAULT_OPTS.dhwFloorF)}°F DHW-ready floor for ~${dhwShortfallStreak * 5} min — the heat pumps aren't holding hot-water temp (big draw, capacity shortfall, or a stuck-low target). Showers may run lukewarm. If it persists: turn the SPAN breaker ON so the element can help, or raise the target on the Control page.`,
      "high",
      { tier, key: "dhw-shortfall",
        action: "Turn the backup element breaker ON at the SPAN panel so it can help, or raise the tank target on the Control page.",
        facts: [["Tank", `${f0(reading.tankF)} for ${dhwShortfallStreak * 5} min`], ["Hot-water floor", f0(DEFAULT_OPTS.dhwFloorF)]] },
    );
  }
}

/** Freeze-risk advisory (owner ask 2026-07-16): deep cold AND a low buffer at the same time. The HBX
 *  P17 anti-freeze is the hard device-side backstop; this is planner visibility so the owner knows to
 *  confirm the HPs are keeping up + the element breaker is on. Rare (design-cold only); edge-triggered. */
const FREEZE_OUTDOOR_F = 5;  // design-day outdoor
const FREEZE_TANK_F = 105;   // buffer has fallen below the DHW-ready floor while it's this cold out
let freezeRiskAlerted = false;
// #122 Wave 2. #116 established that NOTHING watched the writer lease: a planner that is up,
// healthy and silently not commanding setpoints read as fine everywhere. Same for a Pi that has
// gone quiet -- the 2026-09-16 incident was a 73-minute WiFi drop on a calm day, and the only
// reason anyone noticed was that a human happened to be looking. Both are edge-triggered so a
// long outage pages once, not every poll.
let leaseLostSince: number | null = null;
let leaseAlerted = false;
let lastPiConnected: boolean | null = null; // cached from checkI1's existing hub read
let piDisconnectedSince: number | null = null;
let piQuietAlerted = false;
let piQuietPaged = false;
const LEASE_LOST_ALERT_S = 900;  // past the ~11-15 min handover a redeploy legitimately causes
const PI_QUIET_ALERT_S = 600;
async function checkFreezeRisk(reading: SlxReading): Promise<void> {
  if (reading.outdoorF == null || reading.tankF == null) return;
  const risk = reading.outdoorF <= FREEZE_OUTDOOR_F && reading.tankF < FREEZE_TANK_F;
  if (risk && !freezeRiskAlerted) {
    freezeRiskAlerted = true;
    await ntfy(
      "⚠ Freeze-risk advisory",
      `Outdoor ${reading.outdoorF.toFixed(0)}°F with the buffer only ${reading.tankF.toFixed(0)}°F. The HBX P17 anti-freeze is the hard backstop, but confirm the HPs are keeping up and the SPAN breaker is on for the element.`,
      "urgent",
      { tier: "page", key: "freeze-risk", // house-threatening, intervene now
        action: "Make sure both heat pumps are running and the backup element breaker is ON at the SPAN panel.",
        facts: [["Outdoor", f0(reading.outdoorF)], ["Tank", f0(reading.tankF)]] },
    );
  } else if (!risk && freezeRiskAlerted) {
    freezeRiskAlerted = false;
    await ntfy("Freeze-risk cleared", `Outdoor ${reading.outdoorF.toFixed(0)}°F / buffer ${reading.tankF.toFixed(0)}°F — back in range.`, "default", { tier: "page", resolved: true, key: "freeze-risk" });
  }
}

// Non-blocking single-writer guard (#36): heartbeat this instance every poll and page if a
// SECOND planner instance is ever live against the shared DB (only one may write the HBX). It
// NEVER blocks a write — a blocking lease is the deferred defense-in-depth. A rolling Railway
// redeploy briefly overlaps two containers, so we require a peer to persist across TWO polls
// before paging; the alert clears when this is the only instance again.
const INSTANCE_ID = `${os.hostname()}:${process.pid}`;
const INSTANCE_FRESH_MS = 12 * 60 * 1000; // > 2× the 5-min poll, so a slow poll isn't "dead"
// Flag-gated single-writer LEASE (#36 defense-in-depth). OFF by default — enabling it makes a
// second planner instance's writes get refused (423) in writes.ts. Reuses the instance id +
// freshness. Enable deliberately at go-live and confirm takeover on the first redeploy.
const WRITER_LEASE_ENABLED = process.env.WRITER_LEASE_ENABLED === "1";
let writerLeaseState: { held: boolean; holder: string | null } | null = null;
// Graceful handover (2026-10-01): set on SIGTERM/SIGINT so no renew races the release and no timer fires again.
let shuttingDown = false;
// #177: the drift detector's 30 s re-read wait must never hold a poll past SIGTERM (shutdown settles loops for 9 s,
// then refuses to release the lease over a still-running poll) — cleanup() aborts this and the wait returns false.
const shutdownAbort = new AbortController();
function shutdownAwareWait(ms: number): Promise<boolean> {
  if (shuttingDown || shutdownAbort.signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const t = setTimeout(() => { shutdownAbort.signal.removeEventListener("abort", onAbort); resolve(true); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(false); };
    shutdownAbort.signal.addEventListener("abort", onAbort, { once: true });
  });
}
function abandonOnShutdown<T>(p: Promise<T>): Promise<T> {
  if (shutdownAbort.signal.aborted) return Promise.reject(new Error("planner shutting down"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("planner shutting down"));
    shutdownAbort.signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => shutdownAbort.signal.removeEventListener("abort", onAbort));
  });
}
// EVERY loop() still running (not just the latest — a slow poll can outlive the 5-min interval), so shutdown can wait
// for all actuation to settle before it releases the lease; and every lease renew/claim still awaiting the DB, so a
// renew that started before SIGTERM cannot re-claim the row after the release (codex pass 1 on #162).
const activeLoops = new Set<Promise<unknown>>();
const pendingLeaseOps = new Set<Promise<unknown>>();
let loopRunning = false;
let leaseRetryTimer: NodeJS.Timeout | null = null;
let leaseRetryBusy = false;
let leaseWaitingSince: number | null = null;
function track<T>(set: Set<Promise<unknown>>, p: Promise<T>): Promise<T> {
  set.add(p);
  p.then(() => set.delete(p), () => set.delete(p));
  return p;
}
async function settleAll(set: Set<Promise<unknown>>, boundMs: number): Promise<boolean> {
  const all = Promise.allSettled([...set]);
  const done = await Promise.race([all.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), boundMs))]);
  return done;
}
/**
 * A waiting instance used to re-try the claim only on its next 5-min poll, so even a cleanly released lease sat
 * unheld for up to 5 min. While not held, retry every 20 s (DB clock decides; the claim is atomic) and stop the
 * moment it is held — the write path still re-checks the lease on every PATCH, so this only shortens the wait.
 */
function scheduleLeaseClaimRetry(): void {
  if (!WRITER_LEASE_ENABLED || shuttingDown || leaseRetryTimer) return;
  leaseWaitingSince ??= Date.now();
  leaseRetryTimer = setInterval(async () => {
    if (shuttingDown) { clearInterval(leaseRetryTimer!); leaseRetryTimer = null; return; }
    if (leaseRetryBusy) return; // a slow DB must not stack callbacks
    leaseRetryBusy = true;
    try {
      const state = await track(pendingLeaseOps, store.renewOrClaimLease(INSTANCE_ID, INSTANCE_FRESH_MS));
      if (shuttingDown) {
        // SIGTERM landed while this claim was in flight: never keep a lease we are about to abandon
        if (state.held) await store.releaseWriterLease(INSTANCE_ID).catch(() => {});
        return;
      }
      writerLeaseState = state;
      if (state.held) {
        console.log(`writer lease acquired by ${INSTANCE_ID} after ${Math.round((Date.now() - (leaseWaitingSince ?? Date.now())) / 1000)} s waiting`);
        clearInterval(leaseRetryTimer!); leaseRetryTimer = null; leaseWaitingSince = null;
      }
    } catch (e) { console.error("writer-lease claim retry failed:", (e as Error).message); }
    finally { leaseRetryBusy = false; }
  }, 20_000);
  leaseRetryTimer.unref?.();
}
let instancePrevPeers = new Map<string, number>(); // peer id → its last heartbeat_at (ms), see singlewriter.ts
let multiInstanceAlerted = false;
// All 34 second-instance alerts in Sept–Oct 2026 came within 3 h of a planner deploy: Railway's old and new containers
// overlap for ~10–22 min. Record the overlap; only one that outlives a deploy reaches the owner.
const MULTI_INSTANCE_ATTENTION_MS = 30 * 60_000;
let multiInstanceSince: number | null = null;
let multiInstanceEscalated = false;
// A live peer heartbeats every poll; a row older than ~1.5 polls is a dead container's leftover (singlewriter.ts).
const PEER_LIVE_MS = peerLiveMs(POLL_SECONDS);
async function checkSingleWriter(): Promise<void> {
  // a shutting-down instance must not re-insert the heartbeat row cleanup() just dropped
  if (shuttingDown) return;
  let rows: PeerHeartbeat[];
  try {
    rows = await store.heartbeatInstance(INSTANCE_ID, INSTANCE_FRESH_MS);
  } catch (e) {
    console.error("single-writer heartbeat failed:", (e as Error).message);
    return;
  }
  // Count only peers seen on BOTH this poll and the last, heartbeating in between — filters a redeploy's overlap and a dead row.
  const { sustained, next } = observePeers(instancePrevPeers, rows, PEER_LIVE_MS);
  const peerSet = next;
  instancePrevPeers = next;
  const body = (ids: string[]) => `This planner (${INSTANCE_ID}) sees another live instance: ${ids.join(", ")}. Only ONE planner may write the HBX (README §Single-writer invariant, #36) — a second writer bypasses the guardrails and can collide. Shut the extra instance down, or set its AUTOPILOT_DRY_RUN=1 / PHASE_B_DRY_RUN=1.`;
  if (sustained.length && !multiInstanceAlerted) {
    multiInstanceAlerted = true;
    multiInstanceSince = Date.now();
    await ntfy("Second planner instance detected — single-writer at risk", body(sustained), "high", { tier: "record" });
  } else if (sustained.length && multiInstanceSince != null && !multiInstanceEscalated
             && Date.now() - multiInstanceSince >= MULTI_INSTANCE_ATTENTION_MS) {
    multiInstanceEscalated = true;
    await ntfy("Second planner instance still running after 30 min", body(sustained), "high",
               { tier: "record", key: "planner-multi-instance",
                 action: "In Railway, make sure only one a2w-planner deployment is running." });
  } else if (multiInstanceAlerted && !peerSet.size) {
    multiInstanceAlerted = false;
    multiInstanceSince = null;
    await ntfy("Planner single-instance restored", `${INSTANCE_ID} is the only live instance again.`, "default",
               multiInstanceEscalated ? { tier: "record", resolved: true, key: "planner-multi-instance" } : { tier: "record", resolved: true });
    multiInstanceEscalated = false;
  }
}

/**
 * Adoption monitor: a commanded HBX target (the reset-curve midpoint) only takes effect on the
 * device at the START of the next reheat cycle (proven 2026-07-16 — the device re-reads the cloud
 * curve when a call begins). A write that "took" shows up as the operative target (temp1.target)
 * converging onto the commanded midpoint; a silent failure leaves them diverged.
 *
 * We raise the edge-triggered high alert on EITHER signal that the write did not land:
 *   (a) a reheat has RUN while still diverged — the device got its chance to re-read the curve and
 *       didn't adopt. LATCHED across polls (`reheatSeenWhileOff`), so a short reheat that starts and
 *       ends between two 5-min samples still counts. The old `off && reheating` check only fired if
 *       we happened to sample mid-call, so in a low-call (warm) season a real failure could slip by.
 *   (b) the divergence has persisted past ADOPTION_STALE_MS with no convergence, RAISES ONLY —
 *       the raise case is the one that can strand (device satisfied at its old lower target will
 *       never call, so signal (a) can never arrive). For a LOWERING command the stale clock must
 *       NOT fire: the device's old target is HIGHER, so a warm tank simply hasn't needed a reheat
 *       yet — that's healthy coasting, not a failed write (owner caught the false page 2026-08-06);
 *       the next real reheat either adopts (converges) or trips signal (a).
 * A fresh command restarts the clock. Clears on convergence. A brief post-write divergence with no
 * reheat yet is the normal adoption lag, not a failure — neither signal fires until a reheat runs or
 * the backstop elapses.
 */
const ADOPTION_STALE_MS = 2 * 60 * 60 * 1000; // 2 h: a command unrealized this long is a failure
let adoptionAlerted = false;
let adoptionOffSince: number | null = null;
let adoptionReheatSeenWhileOff = false;
let adoptionLastCommanded: number | null = null;
async function checkAdoption(reading: SlxReading, config: Record<string, number>): Promise<void> {
  const operative = reading.tankTargetF;
  const dbt = config.dbt, mbt = config.mbt;
  if (operative == null || dbt == null || mbt == null) return;
  const commanded = (dbt + mbt) / 2;

  // A new command restarts adoption tracking: fresh grace period, fresh reheat observation, and a
  // clean alert slate so the previous command's verdict never bleeds onto this one.
  if (adoptionLastCommanded == null || Math.abs(commanded - adoptionLastCommanded) > 0.5) {
    adoptionLastCommanded = commanded;
    adoptionOffSince = null;
    adoptionReheatSeenWhileOff = false;
    adoptionAlerted = false;
  }

  const off = Math.abs(commanded - operative) > 3;
  if (!off) {
    // Converged (or never diverged): reset the off-stretch and clear any standing alert.
    adoptionOffSince = null;
    adoptionReheatSeenWhileOff = false;
    if (adoptionAlerted) {
      adoptionAlerted = false;
      await ntfy("HBX target adoption recovered", `Operative target now matches the commanded ${commanded.toFixed(1)}°F.`, "default", { tier: "record", resolved: true, key: "hbx-adoption" });
    }
    return;
  }

  // Diverged: track how long, and whether a reheat has had a chance to re-read the curve.
  if (adoptionOffSince == null) adoptionOffSince = Date.now();
  if (reading.stagesCalled?.some(Boolean) === true) adoptionReheatSeenWhileOff = true;
  const offForMs = Date.now() - adoptionOffSince;

  const commandIsRaise = commanded - operative > 3; // only a raise can strand (see header)
  if ((adoptionReheatSeenWhileOff || (commandIsRaise && offForMs > ADOPTION_STALE_MS))
      && !adoptionAlerted) {
    adoptionAlerted = true;
    const why = adoptionReheatSeenWhileOff
      ? "a reheat has run but the operative target never moved onto it"
      : `the RAISE has stayed diverged for ${Math.round(offForMs / 60000)} min with no adopting reheat`;
    console.warn(`ADOPTION FAILED: commanded ${commanded.toFixed(1)}°F, operative ${operative.toFixed(1)}°F — ${why}`);
    await ntfy(
      "HBX target not adopting",
      `Commanded ${commanded.toFixed(1)}°F but operative is ${operative.toFixed(1)}°F — ${why}. The cloud reset-curve write did not take effect on the device. Check the curve / re-command.`,
      "high",
      { tier: "record", key: "hbx-adoption", // the device keeps heating on its last curve: savings, not safety
        action: "Check the HBX in the SensorLinx app is online. The house keeps heating on the curve it has.",
        facts: [["Commanded", f0(commanded)], ["On the device", f0(operative)]] },
    );
  }
}

/** §6.11 trigger poll (every 30 min): NWS alerts + OpenMeteo-derived synthetic triggers.
 *  A dead feed leaves its cache empty — fetch failures never arm anything. */
async function stormTriggerPoll(): Promise<void> {
  try {
    stormAlerts = await fetchNwsAlerts(LAT, LON);
  } catch (e) {
    stormAlerts = [];
    console.warn("NWS alert fetch failed:", (e as Error).message);
  }
  try {
    stormSynthetic = deriveSyntheticTriggers(await fetchStormForecast(LAT, LON), Date.now()); // drop hours already past (#119)
  } catch (e) {
    stormSynthetic = [];
    console.warn("storm forecast fetch failed:", (e as Error).message);
  }
  lastStormPollAt = new Date().toISOString();
}

/** Fold cached triggers + the outage signal + any pending manual command through the
 *  pure state machine; persist an event row and page on every transition. */
async function stormEvaluate(outageActive: boolean | null): Promise<void> {
  const manual = pendingManual ?? undefined;
  pendingManual = null; // consumed exactly once
  const { state, transitions } = evaluateStormState(
    stormState,
    { alerts: stormAlerts, synthetic: stormSynthetic, outageActive, manual },
    new Date(),
  );
  stormState = state;
  if (!transitions.length) return;

  if (state.kind === "armed" || state.kind === "active") {
    let ceilingF = STORM_CAP_F;
    try {
      const cfg = await store.latestConfig();
      const latest = await store.getLatestSlx();
      const curve = cfg && latest?.outdoorF != null ? curveTargetF(cfg, latest.outdoorF) : null;
      ceilingF = stormCeilingF(curve, STORM_CAP_F, STORM_STEP_F);
    } catch { /* no config/reading yet — the cap stands */ }
    await store
      .insertStormEvent(state.trigger, { transitions, windowEnd: state.windowEnd }, ceilingF)
      .catch((e) => console.error("storm event insert failed:", (e as Error).message));
    await ntfy(
      `Storm mode ${state.kind}: ${transitions.join(", ")}`,
      `Trigger: ${state.trigger}. Window ends ${state.windowEnd}. Pre-charge ceiling ${ceilingF.toFixed(0)}°F.` +
        (!STORM_MODE_ENABLED
          ? "\nNotify-only: STORM_MODE_ENABLED off, plan not shaped."
          : PHASE_B_ENABLED && !PHASE_B_DRY_RUN
            ? `\nAuto-raise ACTIVE: pre-charging the tank toward ${ceilingF.toFixed(0)}°F (only raises, never lowers).`
            : `\nAuto-raise: proposing ${ceilingF.toFixed(0)}°F in the SHADOW plan only — the tank will NOT physically pre-charge until Phase B goes live (currently dry-run).`),
      "high",
      { tier: "record" }, // A2W preparing for weather is it doing its job; the outcomes it guards against page on their own
    );
  } else {
    // a failed close is retried every tick, scoped to rows started before this stand-down (codex pass 5); several
    // stand-downs during one DB outage queue up and apply oldest first (codex pass 7)
    pendingStandDowns.push(new Date());
    await retryStormStandDown();
    await ntfy(`Storm mode stand-down: ${transitions.join(", ")}`, "Storm window closed — back to the normal plan.", "default", { tier: "record", resolved: true });
  }
}

/** 5-min tick: OutageWatch (unreachable → null = NO signal) then one machine step. */
async function stormTick(): Promise<void> {
  const outage = await fetchOutageStatus(OUTAGEWATCH_URL); // never throws
  await stormEvaluate(outage ? outage.hasActiveOutage : null);
}

/**
 * #136: ONE definition of "the live demand floor now", shared by the hourly replan and the per-poll
 * re-check: refresh the feed, advance the unbroken-calling clock by the ELAPSED time since the last
 * sample (so escalation is per hour whatever the cadence), propose the floor at the current outdoor.
 * learnedSupply (TempIQ#1632): the LIVE floor is evaluated at now-outdoor, so it may prefer TempIQ's
 * learned per-zone reset curve; the DP's per-hour future floors stay on the local parametric model.
 */
async function sampleDemandFloor(outdoorHint: number | null): Promise<{ floor: ReturnType<DemandFeed["proposeFloor"]>; outdoorF: number | null }> {
  if (!demandFeed) return { floor: null, outdoorF: null };
  await demandFeed.refresh(); // never throws
  // Persist the calling set this refresh observed (zone_call_samples, ~5 min). Observation only,
  // fire-and-forget on the bounded pool: it can neither delay nor fail the floor path.
  {
    const prune = Date.now() - zoneCallPrunedAt > 3_600_000;
    if (prune) zoneCallPrunedAt = Date.now();
    void store.insertZoneCallSample(new Date(), demandFeed.callSample(), prune)
      .catch((e) => console.error("zone call sample failed:", (e as Error).message));
  }
  const latest = await store.getLatestSlx().catch(() => null);
  const outdoorF = latest?.outdoorF ?? outdoorHint;
  const now = Date.now();
  const elapsedMin = lastCallSampleAt == null ? 0 : (now - lastCallSampleAt) / 60_000;
  lastCallSampleAt = now;
  advanceCallMinutes(zoneCallMinutes, demandFeed.callingZoneIds(), elapsedMin);
  const floor = outdoorF != null ? demandFeed.proposeFloor(outdoorF, undefined, true, DEMAND_FLOOR_POLICY, zoneCallMinutes) : null;
  return { floor, outdoorF };
}

/**
 * #136: the per-poll floor re-check. If the floor now exceeds the plan's CURRENT block by
 * FLOOR_RAISE_MIN_F, raise that block in place (raises only, band-clamped, never over a soak, only
 * below the winter guard where the hourly plan applies the floor) — the auto-pilot and Phase B read
 * the plan on this same poll and act on it. The hourly replan is untouched.
 */
async function floorReCheckOnce(): Promise<void> {
  if (!demandFeed || !FLOOR_CADENCE_ENABLED) return;
  const { floor, outdoorF } = await sampleDemandFloor(lastThermal.outdoor_f);
  floorCadence.lastCheckAt = new Date().toISOString();
  // The 24 h raise history is the PERSISTED one (plan meta), refreshed every check: it survives a
  // redeploy and expires on its own when no raise follows — not a process-local list (codex, #149).
  floorCadence.raises = await store.recentFloorRaises(24).catch(() => floorCadence.raises);
  floorCadence.lastFloorF = floor?.tankTargetF ?? null;
  const plans = await store.recentPlans(6).catch(() => []);
  const latest = plans.at(-1);
  const nowMs = Date.now();
  const block = latest?.plan?.filter((b: { ts: string }) => new Date(b.ts).getTime() <= nowMs).at(-1) ?? null;
  floorCadence.lastBlockF = block ? Number(block.tank_target_f) : null;
  const cfgLive = await store.latestConfig().catch(() => null);
  const baseline = await store.baselineConfig().catch(() => null);
  const cfg = curveOverridden(cfgLive, baseline) ? baseline : cfgLive;
  const bandHiF = outdoorF != null ? bandFor(outdoorF, cfg, DEFAULT_OPTS.strictCapF).hi : DEFAULT_OPTS.strictCapF;
  const feed = demandFeed.status();
  const d = decideFloorRaise({
    block, floorF: floor?.tankTargetF ?? null, bindingZone: floor?.bindingZone ?? null, awtF: floor?.bindingAwtF ?? null,
    outdoorF, winterGuardF: DEFAULT_OPTS.winterGuardF, bandHiF,
    feedHealthy: feed.healthy, callingCount: feed.callingCount,
  });
  if (!d.raise) { floorCadence.lastDecision = d.why; return; }
  const hp1 = Math.round(Math.min(Math.max(d.toF + DEFAULT_OPTS.i1MarginF, DEFAULT_OPTS.hpMinF), DEFAULT_OPTS.strictCapF + DEFAULT_OPTS.i1MarginF));
  const r = await store.raiseLatestPlanBlock(d.ts, { tank_target_f: d.toF, hp1_setpoint_f: hp1, reason: d.reason }, { at: floorCadence.lastCheckAt, binding_zone: floor?.bindingZone ?? null, awt_f: floor?.bindingAwtF ?? null }).catch((e) => { console.error("floor re-check: raise failed:", (e as Error).message); return { applied: false, planId: null, movedToNewerPlan: false }; });
  const ok = r.applied;
  floorCadence.lastDecision = ok
    ? `raised ${d.fromF} → ${d.toF}°F${r.movedToNewerPlan ? " (on the plan the hourly replan had just inserted)" : ""}`
    : `no-op: the block was already ≥ ${d.toF}°F when the update ran${r.movedToNewerPlan ? " (a newer plan arrived meanwhile)" : ""}`;
  if (ok) {
    floorCadence.raises.push({ at: floorCadence.lastCheckAt, ts: d.ts, from: d.fromF, to: d.toF });
    console.log(`[floor-cadence] raised the current block ${d.fromF} → ${d.toF}°F — ${d.reason}`);
  }
}

/** The forecast the latest plan was built from: live, or the cache standing in for a failed fetch (/health.forecast). */
let lastForecast: { source: "live" | "cached"; fetched_at: string; hours: number; error: string | null; at: string } | null = null;

async function shadowOnce(): Promise<void> {
  const fc = await forecastWithFallback(
    () => fetchForecast(LAT, LON),
    { load: () => store.loadForecast(), save: (h) => store.saveForecast(h) },
    Date.now(),
  );
  const forecast = fc.hours;
  // #58: when the operative curve is one the autopilot wrote (near-flat band on the last
  // commanded target), the plan's ceiling, winter curve-mimic, and storm ceiling must all
  // reference the AS-FOUND baseline curve — judging any of them against our own write is
  // self-referential (see curveOverridden in writes.ts).
  const cfgLive = await store.latestConfig();
  const baseline = await store.baselineConfig().catch(() => null);
  const cfg = curveOverridden(cfgLive, baseline) ? baseline : cfgLive;

  // learned DHW windows once ≥5 days of tank history exist; fixed defaults until then
  let learned = null;
  let sags: WindowSag[] = [];
  try {
    const tankHistory = await store.getTankHistory(DRAW_WINDOW_DAYS);
    learned = learnDhwWindows(tankHistory);
    // Same rows, no extra query: the draw-gap picture for /health (see dhwDraws) and, per learned
    // window, how deep the draws sag the tank — the #135 pre-boost is sized from that.
    dhwDraws = drawGapStats(detectDrawTimes(tankHistory), Date.now());
    if (learned) sags = measureWindowSags(tankHistory, peakWindows(learned.hourScores));
  } catch (e) {
    console.warn("dhw learner failed, using default windows:", (e as Error).message);
  }
  const preBoosts = sags.map((w) => ({ windowStart: w.windowStart, windowEnd: w.windowEnd, boostF: Math.max(0, Math.round(w.sagP75F)), sagP75F: w.sagP75F, n: w.n }));
  dhwPreBoosts = sags;
  learnedWindowsForHealth = learned ? learned.windows : null;
  // Rolling-horizon fix: the bank / soak blocks this plan's own history already placed at hours that have started,
  // so the bank is chosen once per local day (shadow.ts priorExcursionsFromPlans) instead of re-landing on the
  // current hour every recompute. A history read failure means no memory — the pre-fix plan — never a skipped plan.
  const priorExcursions = priorExcursionsFromPlans(await store.recentPlans(26).catch(() => []), Date.now());
  const opts = { ...(learned ? { ...DEFAULT_OPTS, dhwWindows: learned.windows, preBoosts } : DEFAULT_OPTS), bankF: BANK_F, priorExcursions };

  // §6.9 demand floor: degraded feed → null floor → winter blocks keep the curve mimic.
  let demandFloor: DemandFloor | null = null;
  if (demandFeed) {
    const outdoorHint = forecast[0]?.outdoorF ?? null;
    const { floor, outdoorF } = await sampleDemandFloor(outdoorHint);
    // SHADOW (#33): what would the floor be if warm-adjacent zones borrowed heat? Logs only; the live
    // `demandFloor` below is untouched. Never throws / blocks the cycle.
    if (floor && ADJACENCY_SETBACK_SHADOW && TEMPIQ_SURFACE_TOKEN) {
      await logAdjacencyShadowFloor(floor, demandFeed.callingZoneIds(), TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN);
    }
    if (floor) {
      // "insights+calls" = call-driven (only HEATING zones bind); "insights" = the
      // conservative all-zones fallback when /calls is stale. Lets the /hbx card show
      // which posture produced the snapshot.
      const source = demandFeed.callsHealthy() ? "insights+calls" : "insights";
      try {
        await store.insertZoneFloorSnapshot({
          ts: new Date(),
          zones: floor.perZone,
          bindingZone: floor.bindingZone,
          bindingAwtF: floor.bindingAwtF,
          tankTargetF: floor.tankTargetF,
          source,
        });
      } catch (e) {
        console.error("zone floor snapshot failed:", (e as Error).message);
      }
      if (floor.tankTargetF != null && floor.bindingZone != null && floor.bindingAwtF != null) {
        demandFloor = { tankTargetF: floor.tankTargetF, bindingZone: floor.bindingZone, awtF: floor.bindingAwtF };
        // TempIQ#1508: binding on a seeded/unconfirmed emitter type means the floor may be
        // off by 15-25°F (radiant vs baseboard). Surface it; the /hbx card flags it too.
        if (floor.bindingVerified === false) {
          console.warn(`[demand] binding zone "${floor.bindingZone}" has an UNVERIFIED delivery_type — tank floor ${floor.tankTargetF}°F may be wrong; confirm in TempIQ (#1508)`);
        }
        // MONITOR ONLY (#89): TempIQ's requiredSupplyWaterTempF and our local parametric
        // model encode OPPOSITE assumptions about emitter sizing, and the gap widens as it
        // gets colder — TempIQ ramps baseboard 120°F@60 outdoor → 180°F@2.2 (a generic
        // TEXTBOOK curve for the emitter type, anchored on nothing this house has ever
        // done — see the corrected note in demand.ts and gtm#1592/gtm#1599), while ours
        // tops out at 135°F. Both agree in mild weather, which is the only weather this
        // integration has ever run in. Below ~50°F outdoor the
        // learned value alone pushes the floor past strictCap, where it clamps (safe) but
        // pegs — trading the winter savings away and firing cap-watch. Surface the
        // divergence in shoulder season so the sizing question gets settled deliberately
        // instead of at 2am in January. No behavior change here on purpose: which model is
        // right is an owner decision, not something to silently pick.
        const bindingZf = floor.perZone.find((z) => z.name === floor.bindingZone);
        if (bindingZf?.learned && bindingZf.awtF != null) {
          const localF = bindingZf.localF ?? requiredAwtF(bindingZf.deliveryType, outdoorF as number);
          if (localF != null && Math.abs((bindingZf.ceilingF ?? localF) - localF) >= 10) {
            // gtm#1593: say WHERE the ceiling came from. "type_curve_default" means it
            // measured nothing about this house, which is the difference between a
            // divergence worth acting on and one worth ignoring.
            const src = bindingZf.ceilingSource ?? "unknown(pre-gtm#1593)";
            console.warn(
              `[demand] MODEL DIVERGENCE on binding zone "${floor.bindingZone}" at ${Math.round(outdoorF as number)}°F outdoor: ` +
              `TempIQ ceiling ${bindingZf.ceilingF?.toFixed(1)}°F [anchor: ${src}] vs local ${localF.toFixed(1)}°F ` +
              `(${((bindingZf.ceilingF ?? 0) - localF).toFixed(1)}°F apart). Policy "${DEMAND_FLOOR_POLICY}" is running at ` +
              `${bindingZf.awtF.toFixed(1)}°F (room deficit ${bindingZf.deficitF.toFixed(1)}°F bought ${bindingZf.escalatedF.toFixed(1)}°F). ` +
              `Tank floor ${floor.tankTargetF}°F vs cap ${DEFAULT_OPTS.strictCapF}°F. See #89/#90.`,
            );
          }
        }
      }
    }
  }

  // INTERLOCK: hand the shadow planner the actuator state so its calendar sanitize boost stands down
  // exactly when the demand-driven checkI8 auto-sanitize is armed — one soak actuator, never two/none.
  const sanitizeDue = await sanitizeDueNow();
  if (sanitizeDue.urgent) {
    console.warn("[I8] pasteurization window LAPSED — scheduling the soak at the earliest hour, not the warmest");
  }
  const plan = computeShadowPlan(forecast, cfg, opts, demandFloor, sanitizeDue.due, sanitizeDue.urgent);
  if (!plan.length) throw new Error("empty forecast");

  // #59 winter DP — solve the cost-optimal trajectory over the SAME hard floors the plan
  // enforces. Always recorded (meta + /health) once the horizon reaches shoulder temps; only
  // WINTER_DP_ENABLED lets it raise commanded targets (never lower, band-clamped, sanitize
  // blocks outrank it, storm shaping below still raises on top). A solver failure logs and
  // leaves the plan untouched — the DP is an optimizer, never a dependency.
  let dpMeta: Record<string, unknown> | null = null;
  if (Math.min(...forecast.slice(0, 24).map((f) => f.outdoorF)) < DP_COMPUTE_BELOW_F) {
    try {
      const [anchor, fits, latestSlx] = await Promise.all([
        store.getCopAnchor(60).catch(() => null),
        store.getRecentDecayFits(30 * 24).catch(() => []),
        store.getLatestSlx().catch(() => null),
      ]);
      const tankUa = aggregateTankUa(fits)?.ua ?? DEFAULT_TANK_UA;
      const zones = demandFeed?.isHealthy() ? demandFeed.zones() : [];
      const dpHours: DpHour[] = forecast.slice(0, 24).map((f) => {
        const o = f.outdoorF;
        const band = bandFor(o, cfg, opts.strictCapF);
        // Hard floor: DHW-ready ∨ conservative all-zones demand floor at THIS hour's outdoor
        // (future calling state is unknown — assume any zone may call) ∨ the as-found curve
        // mimic when the demand feed is degraded below the winter guard ∨ the I4 lower band.
        const demandF = demandFeed?.isHealthy() ? demandFeed.proposeFloor(o, null)?.tankTargetF ?? 0 : 0;
        const mimicF = !demandF && o < opts.winterGuardF && cfg ? curveTargetF(cfg, o) ?? 0 : 0;
        const floorF = Math.min(opts.strictCapF, Math.max(opts.dhwFloorF, demandF, mimicF, band.lo));
        const capF = Math.max(floorF, Math.min(opts.strictCapF, band.hi));
        // Space-heat load forecast: hydronic zones' learned UA × indoor−outdoor. Zones without
        // a UA contribute nothing (degraded → the DP still guards floors, just banks less).
        const loadBtu = zones.reduce((s, z) => {
          if (requiredAwtF(z.deliveryType, o) === null || z.uaBtuHrF == null) return s;
          return s + z.uaBtuHrF * Math.max(0, 68 - o);
        }, 0);
        return { ts: f.ts.toISOString(), outdoorF: o, floorF, capF, loadBtu };
      });
      const dp = solveWinterDp(dpHours, { anchor, tankUa, startTankF: latestSlx?.tankF ?? dpHours[0].floorF });
      if (dp) {
        winterDpState = {
          computed_at: new Date().toISOString(), applied: WINTER_DP_ENABLED,
          saved_pct: dp.savedPct, dp_kwh: dp.totalKwh, floor_kwh: dp.floorKwh,
          tank_ua: tankUa, cop_anchored: !!anchor,
          bank_peak_f: Math.max(...dp.blocks.map((b) => b.targetF)),
        };
        dpMeta = { ...winterDpState, targets: dp.blocks.map((b) => ({ ts: b.ts, t: b.targetF, c: b.charge })) };
        if (WINTER_DP_ENABLED) {
          const byTs = new Map(dp.blocks.map((b) => [b.ts, b]));
          for (const block of plan) {
            const d = byTs.get(block.ts);
            if (!d || block.sani || /sanitize/i.test(block.reason)) continue;
            const band = bandFor(block.outdoor_f, cfg, opts.strictCapF);
            const raised = Math.round(Math.min(Math.max(block.tank_target_f, d.targetF), band.hi));
            if (raised <= block.tank_target_f) continue;
            block.tank_target_f = raised;
            // Same leading-setpoint treatment as bank/sanitize blocks: the advisory HP line
            // must cover the raised target or the plan draws an I1-violating hour.
            block.hp1_setpoint_f = Math.round(Math.min(Math.max(raised + opts.i1MarginF, opts.hpMinF), opts.strictCapF + opts.i1MarginF));
            // An excursion block (bank / #135 pre-boost) keeps its identity in the reason — the poster
            // classifies from it — and records the DP's raise alongside (codex, #148).
            block.reason = (block.bank || block.boost) ? `${block.reason}; DP raised to ${raised}°F` : d.reason;
          }
        }
      }
    } catch (e) {
      console.warn("winter DP failed (plan unaffected):", (e as Error).message);
    }
  }

  // §6.11 storm shaping — gated on the flag; notify-only mode leaves the plan untouched.
  // Only-raises rule: a storm never lowers a block below what the plan already wanted.
  if (STORM_MODE_ENABLED && (stormState.kind === "armed" || stormState.kind === "active")) {
    const storm = stormState;
    const startMs = storm.kind === "armed" ? Date.parse(storm.windowStart) : 0;
    const endMs = Date.parse(storm.windowEnd);
    for (const block of plan) {
      const tsMs = Date.parse(block.ts);
      if (!(tsMs >= startMs && tsMs <= endMs)) continue;
      const ceiling = Math.round(stormCeilingF(cfg ? curveTargetF(cfg, block.outdoor_f) : null, STORM_CAP_F, STORM_STEP_F));
      const raised = Math.max(block.tank_target_f, ceiling);
      if (raised === block.tank_target_f) continue;
      block.tank_target_f = raised;
      block.hp1_setpoint_f = Math.round(Math.min(Math.max(raised + opts.i1MarginF, opts.hpMinF), opts.hpMaxF));
      block.reason = `storm mode: banking heat (${storm.trigger})`;
      // a2w#156: the block's IDENTITY authorises its ceiling. A storm block may run up to STORM_CAP_F (owner-configured;
      // 135 by default, so it never exceeds the everyday cap unless deliberately raised); the auto-pilot reads this
      // flag, never the target's size.
      block.storm = true;
    }
  }

  // A-8 (#87) predicted demand. Runs LAST among the raise passes so it only lifts what the
  // reactive floor, DP, bank and storm left below the predicted need — and never lowers any
  // of them (planPreheat is raises-only by construction). With FORECAST_PREHEAT_ENABLED off
  // it mutates nothing and just records what it would have done.
  let preheatMeta: Record<string, unknown> | null = null;
  if (forecastFeed) {
    try {
      await forecastFeed.refresh(); // never throws
      const fc = forecastFeed.forecast();
      // Provenance gate: only zones TempIQ vouches for may command heat.
      //
      // NOTE (2026-08-24, verified against the live payload): /api/insights/zones does NOT
      // emit deliveryTypeVerified at all, so demand.ts parses it as null for every zone and
      // a `=== true` test is never satisfiable — that spelling made this whole path silently
      // inert. What TempIQ actually exposes is the gate's RESULT: its route only emits
      // requiredSupplyWaterTempF for zones that pass its own verified check (4 of 7 hydronic
      // zones here), so a present value IS the vouching signal available today. An explicit
      // false still hard-blocks, for when TempIQ starts sending the field
      // (delivery_type_source, migration 0162 — currently dead; asked for on TempIQv2#2009).
      const verifiedIds = new Set(
        (demandFeed?.zones() ?? [])
          .filter((z) => z.deliveryTypeVerified !== false
            && z.requiredSupplyF != null
            && requiredAwtF(z.deliveryType, 20) !== null)
          .map((z) => z.id),
      );
      if (fc && !verifiedIds.size) console.warn("[forecast] no zone carries a TempIQ-vouched supply temp — pre-heat inert this cycle");
      if (fc && verifiedIds.size) {
        // The call feed IS the gate now. Note the inversion vs computeFloors: there a null
        // feed conservatively treats every zone as calling (safe — a live requirement,
        // clamped); here the raise is speculative, so null must mean raise nothing.
        const callingNowIds = demandFeed?.callsHealthy() ? demandFeed.callingZoneIds() : null;
        const decisions = planPreheat(plan, fc, {
          verifiedZoneIds: verifiedIds,
          callingZoneIds: callingNowIds,
          ceilingFor: (b) => bandFor(b.outdoor_f, cfg, opts.strictCapF).hi,
          setpointFor: (t) => Math.round(Math.min(Math.max(t + opts.i1MarginF, opts.hpMinF), opts.strictCapF + opts.i1MarginF)),
          apply: FORECAST_PREHEAT_ENABLED,
        });
        preheatMeta = {
          enabled: FORECAST_PREHEAT_ENABLED, calling_zones: callingNowIds?.length ?? null,
          generated_at: fc.generatedAt, considered: decisions.length,
          applied: decisions.filter((d) => d.applied).length,
          decisions: decisions.slice(0, 12),
        };
        if (decisions.some((d) => d.applied)) {
          console.log(`[forecast] pre-heat applied to ${decisions.filter((d) => d.applied).length} block(s)`);
        }

        // Predictive cap check: tonight's predicted need vs the everyday cap, surfaced in the
        // AFTERNOON instead of at 2 am via the reactive 3-hour-pinned streak.
        const risk = predictedCapRisk(fc, opts.strictCapF, { verifiedZoneIds: verifiedIds });
        if (risk && !predictedCapLatched) {
          predictedCapLatched = true;
          await ntfy(
            "Winter cap check: tonight is predicted to need more than 135°F",
            `If ${risk.zoneName} is calling around ${new Date(risk.start).toLocaleString("en-US", { timeZone: "America/New_York" })} it will need ~${Math.round(risk.requiredSupplyF)}°F supply (tank ${risk.tankTargetF}°F), above the ${opts.strictCapF}°F everyday cap — this is a capacity warning at the forecast outdoor, NOT a prediction that the zone will call. If rooms run cold tonight, the seasonal cap needs a deliberate raise (see winter-dp-commissioning.md).`,
            "urgent",
          { tier: "attention", key: "cap-predicted", // an owner decision on the cap, not an emergency
            action: "Decide whether to allow a higher water temperature tonight (Control page), or accept that this zone may run a little cool." },
          );
        } else if (!risk) {
          predictedCapLatched = false;
        }
      }
      forecastState = {
        ...forecastFeed.status(), preheat_enabled: FORECAST_PREHEAT_ENABLED,
        verified_zones: verifiedIds.size,
        applied_last_cycle: preheatMeta ? (preheatMeta.applied as number) : 0,
      };
    } catch (e) {
      // An optimizer must never break the cycle that keeps the house warm.
      console.warn("demand forecast failed (plan unaffected):", (e as Error).message);
    }
  }

  // #59 cap-adequacy watch (see CAP_WATCH_* above) — runs on the FINAL plan values.
  try {
    const nowBlock = plan[0];
    const pinned = nowBlock.tank_target_f >= DEFAULT_OPTS.strictCapF - 1;
    const calling = demandFeed?.callsHealthy() ? demandFeed.callingZoneIds() ?? [] : [];
    if (nowBlock.outdoor_f < CAP_WATCH_OUTDOOR_F && pinned && calling.length) {
      for (const id of calling) capWatchStreaks.set(id, (capWatchStreaks.get(id) ?? 0) + 1);
      for (const id of [...capWatchStreaks.keys()]) if (!calling.includes(id)) capWatchStreaks.delete(id);
      const persistent = [...capWatchStreaks.entries()].filter(([, n]) => n >= CAP_WATCH_STREAK);
      if (persistent.length && !capWatchLatched) {
        capWatchLatched = true;
        const names = persistent
          .map(([id]) => demandFeed?.zones().find((z) => z.id === id)?.name ?? id)
          .join(", ");
        await ntfy(
          "Winter cap check: zones may need more than 135°F",
          `${names} ${persistent.length === 1 ? "has" : "have"} been calling for ~${CAP_WATCH_STREAK}+ hours at ${Math.round(nowBlock.outdoor_f)}°F outdoor with the plan pinned at the ${DEFAULT_OPTS.strictCapF}°F cap. The as-found system ran hotter on days like this — if rooms are cold, the seasonal cap needs a deliberate raise (issue #59).`,
          "urgent",
          { tier: "attention", key: "cap-watch", // an owner decision on the cap, not an emergency
            action: "Decide whether to allow a higher water temperature (Control page), or accept that these zones may run a little cool." },
        );
      }
    } else {
      capWatchStreaks.clear();
      capWatchLatched = false;
    }
  } catch (e) {
    console.warn("cap-adequacy watch failed:", (e as Error).message);
  }

  // #133 (b): the demand-shaped curve this plan implies, anchored at the coldest outdoor in the next

  // 24 h of forecast. Stamped on every block so the auto-pilot (and Phase B's lead) read it from the

  // plan they already read. Degraded demand feed → conservative (all buffer-served zones) curve.

  // Only a HEALTHY feed with buffer-served zones may shape the curve (codex pass 2): an empty or stale

  // zone list would derive a floor-only curve and under-serve space heat exactly while TempIQ is down.

  // Otherwise the blocks stay unstamped and the degraded-mode curve-mimic targets remain authoritative.

  lastShapedCurve = null;

  if (SHAPED_CURVE_STAMP && demandFeed && canShapeFromFeed(demandFeed.isHealthy(), demandFeed.zones())) try {

    const wwsd = typeof (cfgLive as { wwsd?: unknown } | null)?.wwsd === "number" ? (cfgLive as { wwsd: number }).wwsd : 125;

    const aheadF = forecast.slice(0, 24).map((f) => f.outdoorF).filter((v) => Number.isFinite(v));

    const shaped = shapeCurve({

      zones: demandFeed ? demandFeed.zones() : [],

      callingZoneIds: demandFeed ? demandFeed.callingZoneIds() : null,

      wwsd, anchorOutdoorF: aheadF.length ? Math.min(...aheadF) : undefined,

      hbxBaseline: baseline, dhwFloorF: opts.dhwFloorF, capF: DEFAULT_OPTS.strictCapF,

      learnedSupply: true, policy: DEMAND_FLOOR_POLICY,

    });

    for (const b of plan) (b as unknown as Record<string, unknown>).shaped_curve = shaped;

    lastShapedCurve = shaped;

  } catch (e) {

    console.warn("shaped curve not computed:", (e as Error).message);

  }


  // #173: the writer answers status().curve_in_force.shaped with the same predicate /health uses, against the
  // same plan curve (null when none was shaped this plan) — so the dashboard and /health cannot disagree.
  writer.setPlanCurve(lastShapedCurve);

  await store.insertShadowPlan(plan, {
    forecast_source: fc.source,
    forecast_fetched_at: fc.fetchedAt.toISOString(),
    dhw_windows: opts.dhwWindows,
    pre_boosts: opts.preBoosts ?? [],
    windows_learned: !!learned,
    learn_days: learned?.days ?? 0,
    draw_events: learned?.drawEvents ?? 0,
    bank_f: BANK_F,
    prior_excursions: priorExcursions, // what the bank remembered (spent / pinned) when this plan was computed
    ...(dpMeta ? { winter_dp: dpMeta } : {}),
    ...(preheatMeta ? { preheat: preheatMeta } : {}),
  });
  // Published only now — after the plan built from this forecast is persisted — so /health.forecast
  // always describes the LATEST STORED plan, never an attempt that failed further down (codex).
  lastForecast = { source: fc.source, fetched_at: fc.fetchedAt.toISOString(), hours: forecast.length, error: fc.error ?? null, at: new Date().toISOString() };
  lastShadowAt = new Date().toISOString();
  const targets = plan.map((b) => b.tank_target_f);
  console.log(
    `shadow plan: ${plan.length} blocks, targets ${Math.min(...targets)}–${Math.max(...targets)}°F, ` +
    `windows ${JSON.stringify(opts.dhwWindows)} (${learned ? `learned, ${learned.days}d/${learned.drawEvents} draws` : "defaults"})`,
  );
}

/**
 * Plan-vs-actual: for each completed hour, score the shadow block from the most recent
 * plan computed BEFORE that hour against what HBX actually targeted. gap_f > 0 = the
 * as-found system ran hotter than the shadow plan wanted — the opportunity, in °F-hours.
 * "Actually targeted" is the OPERATIVE target: the reported temp1.target freezes while the device is idle and
 * read 139.9 °F for 7 h after the 2026-10-19 soak with the 120 °F curve in force (gap +19.9 all evening), so an
 * hour whose samples prove the report stale (store.hourlyActuals reportedStale) scores against the curve in
 * force instead. Both values are recorded (stale-slx-target-2026-10-19.md).
 */
async function scoreOnce(): Promise<void> {
  const [plans, actuals] = await Promise.all([store.recentPlans(30), store.hourlyActuals(26)]);
  if (!plans.length || !actuals.length) return;
  let scored = 0;
  const gaps: number[] = [];
  for (const a of actuals) {
    const eligible = plans.filter((p) => p.computedAt < a.hour);
    if (!eligible.length) continue;
    const plan = eligible[eligible.length - 1];
    const block = plan.plan.find(
      (b: { ts: string }) => new Date(b.ts).getTime() === a.hour.getTime(),
    );
    if (!block) continue;
    const operativeF = a.reportedStale && a.commandedF != null ? a.commandedF : a.targetF;
    const gap = operativeF == null ? null : operativeF - block.tank_target_f;
    await store.upsertPlanScore({
      hourTs: a.hour,
      shadowTargetF: block.tank_target_f,
      actualTargetF: a.targetF,
      actualTankF: a.tankF,
      gapF: gap,
      planComputedAt: plan.computedAt,
      commandedTargetF: a.commandedF,
      reportedStale: a.reportedStale,
    });
    scored++;
    if (gap != null) gaps.push(gap);
  }
  if (scored) {
    const avg = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : NaN;
    console.log(`plan-vs-actual: scored ${scored} hours, avg gap ${isNaN(avg) ? "—" : `+${avg.toFixed(1)}°F`} (actual target above shadow)`);
  }
}

// Module-scope so both pollOnce (boost expiry) and the HTTP routes share one instance.
const writer = new HbxWriter(slx, store, hub, BUILDING_ID, SYNC_CODE, ntfy, AUTO_SANITIZE_ENABLED,
  WRITER_LEASE_ENABLED ? { instanceId: INSTANCE_ID, staleMs: INSTANCE_FRESH_MS } : null);
// #133 (b): SHAPED_CURVE=1 makes the auto-pilot command the plan's demand-shaped reset curve for
// non-excursion hours (a few writes a season) so the HBX weather-compensates on its own between
// writes and after a planner death. Off = today's flat per-hour target. The curve itself is computed
// in shadowOnce (it needs the demand feed + the 24 h forecast) and stamped on every plan block.
const autopilot = AUTOPILOT_ENABLED ? new AutoPilot(store, writer, AUTOPILOT_DRY_RUN, ntfy, SHAPED_CURVE, STORM_CAP_F) : null;
// #232: a restore (boost expiry, Control page "Restore curve") returns the plant to what THIS auto-pilot commands for
// the block in force — resolved inside the writer's restore slot — and to the as-found curve only when no plan is
// being commanded (no auto-pilot here, or it is in shadow).
if (autopilot) writer.setPlanCommand(() => autopilot.planCommand());

// Identification driver (identify.ts — a2w's half of gtm#1616, the "switchback driver" of #137): runs
// RANDOMISED supply-water probes drawn from TempIQ's identification plan so U4 can MEASURE each
// zone's requirement. Needs every actuator and feed: the guarded writer (I4/I1/rate limit), the
// auto-pilot (held for the window), Phase B (leads the setpoints for an up-probe), the demand feed
// (room-deficit abort), the hub (setpoint coverage, pump online), and the TempIQ token (plan +
// window posting). IDENTIFICATION_ENABLED=1 constructs it; the RUNTIME mode (off | shadow | armed)
// lives in controller_flags.identification_mode, seeded from IDENTIFICATION_MODE (default off) and
// switched from the dashboard's Optimize page or POST /api/identification.
const IDENTIFICATION_ENABLED = process.env.IDENTIFICATION_ENABLED === "1";
const IDENTIFICATION_MODE_SEED: IdentMode = (IDENT_MODES as readonly string[]).includes(process.env.IDENTIFICATION_MODE ?? "")
  ? (process.env.IDENTIFICATION_MODE as IdentMode) : "off";
const identification = IDENTIFICATION_ENABLED && autopilot && phaseB && demandFeed && hub && TEMPIQ_SURFACE_TOKEN
  ? new IdentificationDriver({
      store, writer, autopilot, phaseB, demandFeed, hub,
      baseUrl: TEMPIQ_BASE_URL, token: TEMPIQ_SURFACE_TOKEN, notify: ntfy,
      isI1Violated: () => i1Violated,
      isStormActive: () => stormState.kind !== "idle",
      // Fresh from the device, not store.latestConfig(): the same midpoint writer.status() reports, but read
      // now — so cleanup can never mistake a human's newer curve for the probe it wrote (codex pass 7).
      liveCommandedTargetF: async () => {
        const cfg = extractConfig(await slx.getDevice(BUILDING_ID, SYNC_CODE)) as { dbt?: unknown; mbt?: unknown };
        return typeof cfg.dbt === "number" && typeof cfg.mbt === "number" ? Math.round((cfg.dbt + cfg.mbt) / 2) : null;
      },
    }, IDENTIFICATION_MODE_SEED)
  : null;
if (IDENTIFICATION_ENABLED && !identification) {
  console.warn("IDENTIFICATION_ENABLED but a dependency is missing (autopilot / phase B / winter-solver feed / hub / TEMPIQ_SURFACE_TOKEN) — identification driver disabled");
}

/**
 * #122 Wave 2: page when the planner stops actually commanding, or the Pi goes quiet.
 *
 * The lease check deliberately waits LEASE_LOST_ALERT_S. A redeploy hands the lease over and
 * ~11-15 min unheld is NORMAL (#116, live-state) -- alerting on that would train the owner to
 * ignore the channel, which is worse than not having it.
 */
async function checkLeaseAndPi(): Promise<void> {
  const held = writerLeaseState?.held === true;
  if (!WRITER_LEASE_ENABLED) return;
  if (held) {
    if (leaseAlerted) {
      await ntfy("Writer lease recovered", "The planner is commanding setpoints again.", "default", { tier: "record", resolved: true, key: "writer-lease" });
    }
    leaseLostSince = null; leaseAlerted = false;
  } else {
    leaseLostSince ??= Date.now();
    const downS = Math.round((Date.now() - leaseLostSince) / 1000);
    if (downS >= LEASE_LOST_ALERT_S && !leaseAlerted) {
      leaseAlerted = true;
      await ntfy(
        "Planner not commanding setpoints",
        `The writer lease has been unheld for ~${Math.round(downS / 60)} min — longer than a redeploy handover. ` +
          `The planner is up and healthy but is NOT driving the pumps, so the tank is running on whatever ` +
          `was last written. Check /health writer_lease and whether a second instance is contending.`,
        "high",
        { tier: "record", key: "writer-lease", // the pumps hold (or lease-revert to) a safe setpoint meanwhile
          action: "Open the planner's /health page and check writer_lease; restart the a2w-planner service in Railway if it stays stuck." },
      );
    }
  }

  if (!hub) return;
  try {
    // pi_connected is the unambiguous signal and the one drift-check asserts on. HubState.ts is
    // deliberately NOT used for staleness here: its units are not documented, and guessing at a
    // timestamp scale is how you build an alert that fires at the wrong time or never.
    //
    // DELIBERATELY NOT a hub call of its own. checkI1 already fetches hub state every poll and
    // caches pi_connected there, so this check adds ZERO traffic. GET /api/state serves the hub's
    // in-memory copy of the Pi's last push (hub/src/index.ts:275), so it never reaches the Pi
    // either -- but a second redundant read per poll is still waste, and on a bridge with an open
    // comm-degradation bug (#76) the right default is to add no round-trips at all.
    const connected = lastPiConnected;
    if (connected === null) return;      // no reading yet this process; say nothing
    if (!connected) {
      piDisconnectedSince ??= Date.now();
      const downS = Math.round((Date.now() - piDisconnectedSince) / 1000);
      if (downS >= PI_QUIET_ALERT_S && !piQuietAlerted) {
        piQuietAlerted = true;
        await ntfy("Pi disconnected", `The bridge has been disconnected for ~${Math.round(downS / 60)} min.`, "high", { tier: "record" });
      }
      // THE "Pi unreachable" incident (hub dead-man, SPAN-local stale and I8-blind are its record-only symptoms). The
      // pumps hold their lease-reverted setpoints and the HBX keeps running its curve without the Pi, so this is a
      // page only after hours — sooner when it is freezing out (piUnreachablePageAfterS).
      const pageAfterS = piUnreachablePageAfterS(lastOutdoorF);
      if (downS >= pageAfterS && !piQuietPaged) {
        piQuietPaged = true;
        await ntfy(
          "Pi unreachable",
          `The heat-pump bridge (Pi) has not reported for ~${(downS / 3600).toFixed(1)} h` +
            (lastOutdoorF != null ? ` with ${Math.round(lastOutdoorF)}°F outside` : "") + `. The pumps hold their ` +
            `lease-reverted setpoints and the HBX keeps heating on its own curve, but A2W cannot see or optimize the plant. ` +
            `Check the Pi's power and the house internet/WiFi (the Pi is 6bb-a2w-control at 192.168.184.197).`,
          "high",
          { tier: "page", key: "pi-unreachable",
            action: "Check the Pi (6bb-a2w-control) has power, and that the house internet and WiFi are up. Unplugging and replugging the Pi is safe.",
            facts: [["Silent for", `${(downS / 3600).toFixed(1)} h`], ["Outdoor", f0(lastOutdoorF)]] },
        );
      }
    } else {
      if (piQuietAlerted) {
        await ntfy("Pi reconnected", "The bridge is pushing state again.", "default",
                   piQuietPaged ? { tier: "page", resolved: true, key: "pi-unreachable" } : { tier: "record", resolved: true });
      }
      piDisconnectedSince = null; piQuietAlerted = false; piQuietPaged = false;
    }
  } catch { /* hub unreachable is already covered by the poll-failure path */ }
}

async function pollOnce(): Promise<void> {
  const dev = await slx.getDevice(BUILDING_ID, SYNC_CODE);
  const reading = toReading(dev);
  await store.insertReading(reading);
  lastOutdoorF = reading.outdoorF; // season signal for the checkI8 interval (hygiene.ts)
  lastThermal = {
    ...lastThermal, // setpoints are refreshed by checkI1 below, not here
    at: reading.ts.toISOString(),
    tank_f: reading.tankF,
    tank_target_f: reading.tankTargetF,
    outdoor_f: reading.outdoorF,
  };
  // Foreign-write (single-writer-invariant) baseline — captured at poll time, BEFORE this
  // cycle's own guarded writes (expireBoosts / phase-b / autopilot). The planner's writer
  // self-records each write it makes (writes.ts patch → insertConfigVersion, `_source`-tagged),
  // so diffing the poll-time device config against the last-recorded config taken HERE means a
  // FOREIGN writer moved the curve — one that bypassed I4/I1/rate-limit/audit. (Reading the
  // baseline AFTER autopilot writes — the old placement — would false-flag autopilot's OWN
  // curve move as foreign the instant it goes live.) See README §Single-writer invariant, #36.
  // #177: the whole decision — seed / non-curve drift / curve diff → 30 s re-read → verdict (echo of our own write
  // vs foreign writer) → page only if it persists — lives in drift.ts handlePolledConfig, so it is testable without
  // a DB (drift.test.ts replays the two 2026-10-18 events). Every row now stores the raw device object.
  // It still records the change NOW — before any controller acts this poll — so store.latestConfig() (which
  // writer.status() and the auto-pilot's "already commanded there" check read) is current (codex pass 7 on the
  // identification driver: one cycle behind, cleanup could re-command a base over a human's newer curve).
  const prevVersion = await store.latestConfigVersion();
  const drift = await handlePolledConfig(prevVersion, dev, {
    // a SIGTERM mid-request abandons the confirmation (unconfirmed → nothing recorded; the successor re-checks)
    reread: () => abandonOnShutdown(slx.getDevice(BUILDING_ID, SYNC_CODE)),
    wait: shutdownAwareWait,
    lock: withDeviceLock,
    latest: () => store.latestConfigVersion(),
    plannerWrites: (sinceMs) => store.plannerWrites(new Date(sinceMs)),
    record: (r) => store.insertConfigVersion(r.config, r.changes, r),
    notify: (title, body, priority, opts) => ntfyDelivered(title, body, priority, opts),
  });
  if (drift.unsettled && !shuttingDown) {
    lastCurveDiagnosis = drift.diagnosis ?? lastCurveDiagnosis;
    // a curve change neither confirmed nor durably recorded: no controller may overwrite it this cycle (#177)
    throw new Error("HBX curve change seen but neither confirmed nor recorded — skipping this poll's actuation; the next poll re-checks");
  }
  const config = drift.config;
  lastLagTMin = typeof (config as { lagT?: unknown }).lagT === "number" ? (config as { lagT: number }).lagT : lastLagTMin;
  if (drift.kind === "seeded") console.log("seeded initial hbx_config_versions row");
  if (drift.changes) lastDriftAt = new Date().toISOString();
  if (drift.diagnosis) lastCurveDiagnosis = drift.diagnosis;
  {
    // an unconfirmed curve change is re-checked by the next poll; if that poll no longer sees it, say so (#177)
    await pendingUnconfirmed.step(drift, (n) => ntfyDelivered(n.title, n.body, "default", { tier: "record" }));
  }
  {
    const c = config as { dot?: unknown; wwsd?: unknown; dbt?: unknown; mbt?: unknown };
    lastDeviceCurve = [c.dot, c.wwsd, c.dbt, c.mbt].every((v) => typeof v === "number")
      ? { dot: c.dot as number, wwsd: c.wwsd as number, dbt: c.dbt as number, mbt: c.mbt as number } : null;
  }
  // I1 against the OPERATIVE target — the same term Phase B leads this poll (checkI1 / phaseb.ts operativeLeadF)
  await checkI1(await operativeTarget(reading, config));
  await checkBackupCalled(reading.backupCalled);
  await checkUnservedCall(reading).catch((e) => console.error("unserved-call check failed:", (e as Error).message));
  // after the stage watch, so this poll's stage episodes feed the gate
  await checkBackupGate(reading)
    .catch((e) => { backupGateError = `gate: ${(e as Error).message}`; console.error("backup gate failed:", backupGateError); });

  await checkDHWShortfall(reading).catch((e) => console.error("dhw-shortfall check failed:", (e as Error).message));
  await checkFreezeRisk(reading).catch((e) => console.error("freeze-risk check failed:", (e as Error).message));
  await checkSingleWriter().catch((e) => console.error("single-writer check failed:", (e as Error).message));
  if (WRITER_LEASE_ENABLED && !shuttingDown) {
    // Renew/claim the lease BEFORE this cycle's writes so the writer holds a fresh lease. (Not while shutting
    // down: a renew landing after the release would re-claim the row and bring the 12-min wait back.)
    try {
      const state = await track(pendingLeaseOps, store.renewOrClaimLease(INSTANCE_ID, INSTANCE_FRESH_MS));
      if (shuttingDown && state.held) await store.releaseWriterLease(INSTANCE_ID).catch(() => {}); // landed after SIGTERM
      else writerLeaseState = state;
    }
    catch (e) { console.error("writer-lease renew failed:", (e as Error).message); }
    if (!shuttingDown && writerLeaseState && !writerLeaseState.held) scheduleLeaseClaimRetry();
  }
  // #122 Wave 2 — runs AFTER the renew so it judges this cycle's lease, not last cycle's.
  await checkLeaseAndPi().catch((e) => console.error("lease/pi check failed:", (e as Error).message));
  await writer.expireBoosts().catch((e) => console.error("boost expiry failed:", (e as Error).message));

  // W2-A: pull the runtime autonomy override and apply it per-tick BEFORE the controllers run, so
  // the dashboard Off/Armed switch takes effect within one poll with no redeploy. Falls back to the
  // env-seeded values if the row is somehow unreadable. This governs ONLY dry-run (actuate vs
  // shadow) — the I4/I1 guardrails, single-writer invariant (#36), and rate limits are untouched.
  const flags = (await store.getControllerFlags().catch(() => null))
    ?? { autopilotDryRun: AUTOPILOT_DRY_RUN, phasebDryRun: PHASE_B_DRY_RUN, autoSanitize: AUTO_SANITIZE_ENABLED, identificationMode: IDENTIFICATION_MODE_SEED };
  if (autopilot) autopilot.setDryRun(flags.autopilotDryRun);
  if (phaseB) phaseB.setDryRun(flags.phasebDryRun);
  autoSanitizeLive = flags.autoSanitize; // dashboard toggle → demand-aware sanitize cadence (sanitizeDueNow)
  writer.setAutoSanitize(autoSanitizeLive);
  if (identification) {
    const m = (flags as { identificationMode?: string }).identificationMode ?? "off";
    identification.setMode(((IDENT_MODES as readonly string[]).includes(m) ? m : "off") as IdentMode);
  }

  // #136: the demand floor is re-checked every poll and the current block raised in place BEFORE Phase B
  // (so the pump setpoints lead the raised target on this same poll) and the auto-pilot (which writes it).
  await floorReCheckOnce().catch((e) => console.error("floor re-check failed:", (e as Error).message));
  if (phaseB) await phaseB.runOnce().catch((e) => console.error("phase-b failed:", (e as Error).message));
  // The driver runs BETWEEN Phase B (which may be leading a probe target) and the auto-pilot (which
  // it holds for the window): a window opened here is respected by the auto-pilot in the same poll.
  if (identification) await identification.tick();
  if (autopilot) await autopilot.applyLatestPlan().catch((e) => console.error("autopilot failed:", (e as Error).message));

  // Heartbeat the planner's ACTUAL (effective, runtime) controller flags so the dashboard shows
  // ground truth (the Plan page reads this row instead of hardcoded copy — a stale updated_at ⇒
  // planner down). Sourced from the live controller state, NOT the boot-time env const, so it
  // reflects a mid-run switch flip.
  await store.upsertControllerStatus({
    autopilotEnabled: AUTOPILOT_ENABLED,
    autopilotDryRun: autopilot ? autopilot.isDryRun : AUTOPILOT_DRY_RUN,
    autopilotResult: autopilot ? autopilot.lastResult : null,
    autopilotTargetF: autopilot ? autopilot.lastTargetF : null,
    phasebEnabled: PHASE_B_ENABLED,
    phasebDryRun: phaseB ? phaseB.isDryRun : PHASE_B_DRY_RUN,
    phasebResult: phaseB ? (Object.values(phaseB.lastResults).join(" · ") || null) : null,
    autoSanitize: autoSanitizeLive,
    identificationMode: identification ? identification.currentMode : null,
    identificationResult: identification ? identification.status().lastResult : null,
  }).catch((e) => console.error("controller status heartbeat failed:", (e as Error).message));

  await checkAdoption(reading, config as Record<string, number>).catch((e) => console.error("adoption check failed:", (e as Error).message));

}

async function loop(): Promise<void> {
  if (shuttingDown) return;
  if (loopRunning) { console.warn("poll overlap: the previous poll is still running — skipping this tick"); return; }
  loopRunning = true;
  try {
    await loopBody();
  } finally {
    loopRunning = false;
  }
}

async function loopBody(): Promise<void> {
  // restore FIRST, so this tick's stage / SPAN evaluation reconciles adopted episodes before any re-send (codex pass 5)
  await restoreAlertState();
  try {
    await pollOnce();
    lastPollAt = new Date().toISOString();
    if (consecutiveFailures >= OFFLINE_AFTER_FAILURES && offlineAlerted) {
      await ntfy("SensorLinx reader recovered", `polling resumed at ${lastPollAt}`, "default",
                 consecutiveFailures >= SLX_ATTENTION_FAILURES ? { tier: "record", resolved: true, key: "sensorlinx-offline" } : { tier: "record", resolved: true });
      offlineAlerted = false;
    }
    consecutiveFailures = 0;
  } catch (e) {
    consecutiveFailures++;
    console.error(`poll failed (${consecutiveFailures} consecutive):`, (e as Error).message);
    if (consecutiveFailures === OFFLINE_AFTER_FAILURES && !offlineAlerted) {
      offlineAlerted = true;
      await ntfy(
        "SensorLinx reader offline",
        `${consecutiveFailures} consecutive poll failures; last success: ${lastPollAt ?? "never"}`,
        "high",
        { tier: "record" }, // usually the SensorLinx cloud; the HBX keeps running its curve meanwhile
      );
    }
    if (consecutiveFailures === SLX_ATTENTION_FAILURES) {
      await ntfy("SensorLinx reader offline for 6 h",
        `${consecutiveFailures} consecutive poll failures; last success: ${lastPollAt ?? "never"}. The HBX keeps heating on its ` +
          `own curve, but the planner is blind and not optimizing. Check the SensorLinx app and the HBX's internet connection.`,
        "high", { tier: "record", key: "sensorlinx-offline",
                  action: "Check the HBX shows online in the SensorLinx app, and that its network cable or WiFi is connected." });
    }
  }

  // #187 / #185: the SPAN-local check and the alert outbox depend on neither SensorLinx nor the poll's success —
  // they run every tick on their own, so a SensorLinx outage cannot hide a SPAN outage or stall a re-send (codex pass 2)
  await sweepStormOrphans();
  await retryStormStandDown();
  await checkSpanLocal().catch((e) => { spanLocalError = (e as Error).message; console.error("span-local check failed:", spanLocalError); });
  // a DB row is re-sent only once its watch has evaluated the condition since the restore that adopted it — a resolved
  // incident is closed by that evaluation instead of paged (codex pass 5)
  await checkPumpHealth().then(() => { pumpHealthError = null; })
    .catch((e) => { pumpHealthError = (e as Error).message; console.error("pump health check failed:", pumpHealthError); });
  await alerts.retry((kind) => (kind.startsWith("shadow_") ? false
    : kind === "backup_gate_shadow" ? false // its own outbox (default priority, email) re-sends it, never the high one
    : kind === "backup_gate" ? true // open = the breaker is closed until the gate re-opens it
    : kind.startsWith("pump_") ? pumpEvaluatedSinceRestore
    : kind === "span_local_stale" ? spanEvaluatedSinceRestore : stageEvaluatedSinceRestore))
    .catch((e) => console.error("alert re-send failed:", (e as Error).message));
  await gateShadowAlerts.retry((kind) => kind === "backup_gate_shadow").catch((e) => console.error("backup-gate shadow re-send failed:", (e as Error).message));
  // shadow: flush closes / notified-marks owed; it never "re-sends" a DB row (live rows are the paging outbox's)
  await shadowAlerts.retry(() => false).catch((e) => console.error("shadow episode flush failed:", (e as Error).message));
  await checkPumpHealthDaily().then(() => { pumpDailyError = null; })
    .catch((e) => { pumpDailyError = (e as Error).message; console.error("pump health daily failed:", pumpDailyError); });

  // §6.11: the outage check + storm machine step ride the same 5-min cadence, outside
  // the poll try/catch so a SensorLinx failure never skips a storm evaluation.
  try {
    await stormTick();
  } catch (e) {
    console.error("storm tick failed:", (e as Error).message);
  }
}

async function main(): Promise<void> {
  // A one-shot run fails fast, so a broken database surfaces as a non-zero exit. The
  // long-running service waits the outage out instead of dying — see the comment on
  // ensureSchemaWithRetry() for why that distinction cost us four days in August.
  if (process.env.POLL_ONCE === "1") await store.ensureSchema();
  else await store.ensureSchemaWithRetry();
  lastCurveDiagnosis = await store.latestCurveDiagnosis().catch(() => null); // #177: /health survives a redeploy
  await pendingUnconfirmed.ensureLoaded();                                    // #177: so does an unsettled observation
  await restoreAlertState(); // #185 / #187 — retried every tick until it succeeds
  await sweepStormOrphans(); // #183 — retried every tick until it succeeds

  // W2-A: seed the runtime autonomy row from env on FIRST boot only (ON CONFLICT DO NOTHING),
  // preserving the EXACT current per-controller state so deploying this changes nothing until the
  // dashboard Off/Armed switch is used. Thereafter the controller_flags row is authoritative and
  // env changes don't clobber a live choice. mode is cosmetic ('arm' both-live / 'off' both-shadow /
  // 'custom' mixed); the two dry-run booleans are what actually govern actuation.
  const seedMode = !AUTOPILOT_DRY_RUN && !PHASE_B_DRY_RUN ? "arm"
    : AUTOPILOT_DRY_RUN && PHASE_B_DRY_RUN ? "off" : "custom";
  await store.seedControllerFlags({
    mode: seedMode, autopilotDryRun: AUTOPILOT_DRY_RUN, phasebDryRun: PHASE_B_DRY_RUN, autoSanitize: AUTO_SANITIZE_ENABLED,
    identificationMode: IDENTIFICATION_MODE_SEED,
  }).catch((e) => console.error("controller_flags seed failed:", (e as Error).message));

  // Graceful handover on redeploy (2026-10-01; codex pass 1 on #162 for the ordering). Railway SIGTERMs the old
  // container while the new one is already up. Without this the lease row kept the dead holder until the 12-min
  // staleness expiry + the successor's next poll (649–981 s measured). Order matters:
  //   1. shuttingDown + write barrier: no new device write starts, no renew/claim is scheduled, no timer fires again;
  //   2. wait (bounded) for every running poll and every pending lease op — actuation already on the wire finishes;
  //   3. release ONLY if nothing is still writing (a release over an in-flight PATCH would let two planners command
  //      the device) — otherwise exit WITHOUT releasing, which is the old, safe 12-min path;
  //   4. drop the heartbeat row, release once more (a renew that landed late is undone), close, exit 0.
  // The whole thing fits inside RAILWAY_DEPLOYMENT_DRAINING_SECONDS (set to 20 on the service) via a 12 s hard exit.
  // Registered BEFORE the one-shot branch so a local POLL_ONCE run can never strand the shared lease either.
  let cleanupDone = false;
  const cleanup = async (reason: string): Promise<void> => {
    if (cleanupDone) return;
    cleanupDone = true;
    shuttingDown = true;
    shutdownAbort.abort();
    raiseWriteBarrier();
    const hardExit = setTimeout(() => { console.error(`[shutdown] ${reason}: forced exit (in-flight work did not finish in time)`); process.exit(0); }, 12_000);
    hardExit.unref?.();
    // Drop the heartbeat row FIRST, right after the barrier: a barred, shutting-down instance is no longer a writer, and
    // the lease is a separate row. Done last, the 12 s hard exit could beat it and the successor counted this dead
    // container as a second planner for INSTANCE_FRESH_MS (every deploy, 2026-10). Not awaited here, so a slow DB cannot
    // eat the loop-settle budget; the drop near the end is the retry.
    void store.dropInstance(INSTANCE_ID).catch((e) => console.error("[shutdown] heartbeat row drop failed:", (e as Error).message));
    if (leaseRetryTimer) { clearInterval(leaseRetryTimer); leaseRetryTimer = null; }
    const loopsDone = await settleAll(activeLoops, 9_000);
    const leaseOpsDone = await settleAll(pendingLeaseOps, 1_500);
    if (WRITER_LEASE_ENABLED) {
      const quiet = loopsDone && leaseOpsDone && deviceWritesInFlight() === 0;
      if (quiet) {
        const released = await store.releaseWriterLease(INSTANCE_ID).catch((e) => { console.error("[shutdown] lease release failed:", (e as Error).message); return false; });
        console.log(`[shutdown] ${reason}: writer lease ${released ? "released" : "not held"} by ${INSTANCE_ID}`);
      } else {
        console.warn(`[shutdown] ${reason}: NOT releasing the writer lease — work still in flight (loops settled: ${loopsDone}, lease ops settled: ${leaseOpsDone}, device writes on the wire: ${deviceWritesInFlight()}); the successor takes over after the staleness window`);
      }
    } else {
      console.log(`[shutdown] ${reason}: exiting (writer lease disabled)`);
    }
    await store.dropInstance(INSTANCE_ID).catch(() => {}); // retry of the early drop (and undoes a heartbeat that raced it)
    // A renew/claim that landed between the wait and here could have re-claimed the row — undo it (conditional, safe),
    // but ONLY when every lease op has settled: an op still pending could land after this release too, and its own
    // compensating release needs the pool. So: give pending ops one more bounded chance, then release if quiet.
    const leaseOpsSettled = leaseOpsDone || await settleAll(pendingLeaseOps, 1_500);
    if (WRITER_LEASE_ENABLED && loopsDone && leaseOpsSettled && deviceWritesInFlight() === 0) {
      const releasedLate = await store.releaseWriterLease(INSTANCE_ID).catch(() => false);
      // the first gate may have refused over an in-flight write that has since finished — say what finally happened
      if (releasedLate) console.log(`[shutdown] ${reason}: writer lease released on the final check (work finished during cleanup)`);
    } else if (WRITER_LEASE_ENABLED && !leaseOpsSettled) {
      console.warn(`[shutdown] ${reason}: a lease renew/claim is still pending — leaving the row to the staleness window rather than racing it`);
    }
    // the hard-exit timer stays armed THROUGH store.close(): a hung pool.end() must not outlive the drain window
    await store.close().catch(() => {});
    clearTimeout(hardExit);
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void cleanup(sig).then(() => process.exit(0)));

  if (process.env.POLL_ONCE === "1") {
    // Each step runs on its own, exactly like the long-running loop's hourly chain: a forecast outage (open-meteo 503
    // on a virgin DB — the forecast-down rehearsal) used to FATAL the one-shot here while prod merely logged
    // "shadow failed" and carried on, so the rehearsal could not even observe the degraded behaviour it exists to test.
    const once = (label: string, fn: () => Promise<unknown>) => fn().then(() => {}, (e) => console.error(`${label} failed:`, (e as Error).message));
    await pollOnce();
    await once("shadow", shadowOnce);
    await once("score", scoreOnce);
    await once("decay scan", () => decayScanOnce(store));
    await once("realized-savings", () => realized.computeAndStore(REALIZED_LOOKBACK_DAYS));
    await once("pi-link", refreshPiLink);
    await once("span-local", checkSpanLocal);
    await once("alert re-send", () => alerts.retry());
    if (TEMPIQ_PUSH_ENABLED && TEMPIQ_SURFACE_TOKEN) await once("tempiq-ua-push", () => pushTankUa(store, TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN));
    if (TEMPIQ_PUSH_ENABLED && TEMPIQ_SURFACE_TOKEN) await once("tempiq-reheat-push", () => pushTankReheat(store, TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN));
    if (tempiq) await once("tempiq-push", () => tempiq.tick());
    if (tempiqRead) await once("tempiq-read", () => tempiqRead.tick());
    if (tempiqWindows) await once("tempiq-windows", () => tempiqWindows.tick());
    console.log("POLL_ONCE ok");
    await cleanup("POLL_ONCE"); // releases the shared lease this run may have claimed, drops the heartbeat, closes
    return;
  }

  const authed = (req: http.IncomingMessage): boolean => {
    if (!PLANNER_API_TOKEN) return false;
    const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(got), b = Buffer.from(PLANNER_API_TOKEN);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let s = "";
      req.on("data", (c) => { s += c; if (s.length > 4096) reject(new Error("body too large")); });
      req.on("end", () => resolve(s));
      req.on("error", reject);
    });

  http
    .createServer(async (req, res) => {
      try {
        if (req.url === "/health") {
          const ok = consecutiveFailures < OFFLINE_AFTER_FAILURES;
          return json(res, ok ? 200 : 503, {
            ok, lastPollAt, lastDriftAt, lastShadowAt, consecutiveFailures,
            // #177: the newest curve event, self-diagnosed — verdict echo_suspected (within 2 °F of a value the planner
            // wrote in the previous 60 min; default page) | foreign (high page) | reverted (re-read showed it gone; no page).
            // #165: Pi uptime, reboots and the 7-d dropout windows (phase_b_log `no Pi connected` runs), each with a
            // gap-vs-reboot verdict from the mirror's readings + system_stats. Corroborates the hub's own counters
            // (hub /health pi_dropouts_24h / _7d, #178), which reset on a hub redeploy; these come from the DB.
            // #185: the all-idle alarm beside the per-stage watch (stage → mapped pump, called-not-heating minutes,
            // open episodes) and episodes opened in 24 h. STAGE_PUMP_MAP is the physical wiring (README).
            unserved: {
              all_idle: { alerted: unservedAlerted, streak: unservedStreak },
              stage_pump_map: STAGE_MAP.map, stage_pump_map_error: STAGE_MAP.error,
              stages: stageWatch.status(), episodes_24h: stageEpisodes24h, lag_t_min: lastLagTMin,
            },
            // #187: the SPAN LOCAL stream (the Pi's LAN poller → span_readings) beside spanwatch's cloud state. Pages
            // when local is older than 15 min; the cloud failing alone only shows here.
            span: spanLocal ? { ...spanLocal, refresh_error: spanLocalError } : { pending: true, refresh_error: spanLocalError },
            // pump health (pumphealth.ts): "running but not doing its job" with no fault code, per pump, SHADOW unless
            // promoted in PUMP_HEALTH_LIVE. checks = the latest verdict per check (ok | tripped | unknown) and whether an
            // episode is open; gate = why nothing was evaluated this tick (null = evaluated). daily = the SPAN-metered rollup
            // for the newest complete day + the 7-d vs 14-d drift trend. Thresholds: pump-health-baseline-20261019.md.
            pump_health: {
              enabled: PUMP_HEALTH_ENABLED,
              live_checks: [...PH_LIVE.live], live_error: PH_LIVE.error,
              span_circuits: PUMP_SPAN_CIRCUITS,
              evaluated_at: pumpHealthAt, gate: pumpHealthGate, error: pumpHealthError,
              checks: pumpWatch.status(),
              thresholds: PH,
              daily: {
                through_day: pumpTrend?.through_day ?? null,
                days: pumpTrend ? pumpDays.filter((r) => r.day === pumpTrend!.through_day).map((r) => ({ pump: r.pumpId, ...r.m })) : [],
                days_stored: pumpDays.length,
                trend: pumpTrend ? { pumps: pumpTrend.pumps, twin: pumpTrend.twin, twin_flag: pumpTrend.twin_flag } : null,
                error: pumpDailyError,
              },
              digest: { enabled: PUMP_HEALTH_DIGEST, hour_et: PUMP_HEALTH_DIGEST_HOUR, last: pumpDigestLast },
            },
            // the backup element's dynamic gate (backupgate.ts). mode shadow = gate_state is VIRTUAL (what it would have
            // done); relay / element_w are the REAL Buffer Tank breaker from the Pi's SPAN snapshot; pi_fallback is the
            // bridge's cloud-free "both pumps down" fallback. blind = why this poll judged nothing (null = judged).
            backup_gate: {
              ...backupGate.status(Date.now()),
              circuit: BACKUP_CIRCUIT, blind: backupGateBlind, error: backupGateError,
              relay: backupGateHub.relay, element_w: backupGateHub.element_w,
              episodes_7d: backupGateEpisodes7d, config_errors: BACKUP_GATE_CFG.errors,
              live_ready: BACKUP_GATE_CFG.mode !== "live" || !!HUB_ARM_TOKEN,
              pi_fallback: backupGateHub.pi_fallback,
            },
            pi: piLink
              ? { ...withLiveAges(piLink, Date.now()), refresh_error: piLinkError }
              : { pending: true, refresh_error: piLinkError },
            drift: {
              last_at: lastDriftAt,
              last_foreign: lastCurveDiagnosis
                ? { at: lastCurveDiagnosis.at, fields: lastCurveDiagnosis.fields, planner_last_write: lastCurveDiagnosis.planner_last_write,
                    reread_confirmed: lastCurveDiagnosis.reread_confirmed, verdict: lastCurveDiagnosis.verdict,
                    device_before: lastCurveDiagnosis.device_before, device_after: lastCurveDiagnosis.device_after }
                : null,
            },
            // Which forecast the latest plan was built from — "cached" means open-meteo failed this hour
            // and the last good forecast (≤ 6 h old) stood in, so the plan + demand floor still refreshed.
            forecast: lastForecast,
            instance: { id: INSTANCE_ID, multi_instance: multiInstanceAlerted, peers: [...instancePrevPeers.keys()] },
            // #121: storm windows and shadow.ts's DHW windows are both correct ONLY because this
            // process runs with TZ set to Eastern — shadow.ts:120 relies on getHours() being local,
            // and storm.ts parses OpenMeteo's naive local timestamps against the process TZ. That
            // dependency lived in a code comment and a Railway dashboard variable, outside the repo,
            // with nothing asserting it. Reporting it is what lets drift-check make it loud.
            tz: { env: process.env.TZ ?? null, resolved: Intl.DateTimeFormat().resolvedOptions().timeZone },
            writer_lease: WRITER_LEASE_ENABLED ? (writerLeaseState ?? "pending") : "off",
            i1: hub ? { violated: i1Violated, detail: i1Detail, operative: i1Operative } : "disabled",
            tempiq_push: tempiq ? tempiq.status() : "disabled",
            tempiq_read: tempiqRead ? tempiqRead.status() : "disabled",
            tempiq_windows: tempiqWindows ? tempiqWindows.status() : "disabled",
            identification: identification ? identification.status() : "disabled",
            // #133 acceptance 3: the curve IN FORCE on the device + its output at the live outdoor, and the
            // shaped curve the latest plan implies — not just the last commanded scalar.
            curve: {
              mode: SHAPED_CURVE_MODE === "live" ? "shaped" : SHAPED_CURVE_MODE === "shadow" ? "shadow" : "flat-target",
              in_force: lastDeviceCurve ? {
                ...lastDeviceCurve,
                output_at_live_outdoor_f: lastThermal.outdoor_f != null ? Math.round(curveOutputF(lastDeviceCurve, lastThermal.outdoor_f) * 10) / 10 : null,
                // "shaped" = the PLAN's curve is the one in force (the auto-pilot's own four-field predicate), not a
                // spread heuristic: the floor-clamped plan curve has a 2 °F spread and read false the day it went live
                // (eval 2026-09-30 §10.10). spread_f keeps the old signal visible.
                shaped: lastShapedCurve ? curveAlreadyInForce(lastShapedCurve, lastDeviceCurve) : false,
                spread_f: Number.isFinite(Number(lastDeviceCurve.dbt) - Number(lastDeviceCurve.mbt)) ? Math.round((Number(lastDeviceCurve.dbt) - Number(lastDeviceCurve.mbt)) * 10) / 10 : null,
              } : null,
              plan_implies: lastShapedCurve ? {
                dot: lastShapedCurve.dot, dbt: lastShapedCurve.dbt, mbt: lastShapedCurve.mbt, wwsd: lastShapedCurve.wwsd, basis: lastShapedCurve.basis,
                output_at_live_outdoor_f: lastThermal.outdoor_f != null ? Math.round(curveOutputF(lastShapedCurve, lastThermal.outdoor_f) * 10) / 10 : null,
                // acceptance #1: would the live auto-pilot write this curve now? Same four-field
                // predicate the auto-pilot uses (dot / dbt / mbt / wwsd), so shadow and live agree
                // on configuration drift too (codex): false = already in force.
                would_write: !curveAlreadyInForce(lastShapedCurve, lastDeviceCurve),
              } : null,
            },
            phase_b: phaseB
              // lead: the terms of the last cycle's max() — the plan term is the auto-pilot's COMMAND for the block in force
              // (plan_basis curve / flat), beside the declared tank_target_f it led before (phaseb.ts planLeadF).
              ? { mode: PHASE_B_DRY_RUN ? "dry-run" : "active", pumps: PHASE_B_PUMPS, lastRunAt: phaseB.lastRunAt, lastResults: phaseB.lastResults, fail_streak: phaseB.streaks(), lead: phaseB.lastLead }
              : "disabled",
            // #136: the per-poll floor re-check — last decision and the raises it made in the past 24 h.
            demand_floor_cadence: (() => {
              const dayAgo = Date.now() - 86_400_000;
              const raises = floorCadence.raises.filter((r) => Date.parse(r.at) >= dayAgo); // pruned on read as well
              return { enabled: FLOOR_CADENCE_ENABLED && !!demandFeed, poll_seconds: POLL_SECONDS, min_raise_f: FLOOR_RAISE_MIN_F, ...floorCadence, raises, raises_24h: raises.length, raises_source: "shadow_plans.meta.floor_raises (persisted, rolling 24 h)" };
            })(),
            winter_solver: demandFeed
              ? { mode: demandFeed.isHealthy() ? "shadow" : "degraded", ...demandFeed.status() }
              : "off",
            // #59: last DP solve (null until the forecast first dips below the compute threshold)
            winter_dp: winterDpState ?? { mode: "idle", enabled: WINTER_DP_ENABLED },
            demand_forecast: forecastState ?? { mode: "idle", fetch_enabled: FORECAST_FETCH_ENABLED, preheat_enabled: FORECAST_PREHEAT_ENABLED },
            // #122 Wave 1. dhw_ready / coast_h are derived here rather than by every consumer,
            // because the whole point is that a reader should not have to know the physics to
            // answer "can this ride out an outage?". coast_h is the standing-loss-only time to
            // the DHW floor: C_eff/UA = 1/tank_ua hours per e-fold above the 65 °F ambient the UA
            // is defined against (winterdp.ts). Draws are NOT modelled -- one shower is ~9 °F --
            // so treat it as a ceiling, not a promise.
            thermal: (() => {
              // winterDpState is loosely typed; coerce and fall back rather than trust it.
              const uaRaw = Number((winterDpState as Record<string, unknown> | null)?.tank_ua);
              const ua = Number.isFinite(uaRaw) && uaRaw > 0 ? uaRaw : DEFAULT_TANK_UA;
              const t = lastThermal.tank_f;
              const floor = DEFAULT_OPTS.dhwFloorF;
              const coast =
                t != null && t > floor && ua > 0
                  ? Math.round((Math.log((t - 65) / (floor - 65)) / ua) * 10) / 10
                  : t != null && t <= floor
                    ? 0
                    : null;
              return {
                ...lastThermal,
                dhw_floor_f: floor,
                dhw_ready: t != null ? t >= floor : null,
                coast_h: coast,
                tank_ua: ua,
              };
            })(),
            storm: {
              state: stormState.kind,
              trigger: stormState.kind === "idle" ? null : stormState.trigger,
              windowEnd: stormState.kind === "idle" ? null : stormState.windowEnd,
              enabled: STORM_MODE_ENABLED,
              lastTriggerPollAt: lastStormPollAt,
            },
            // I8 thermal hygiene — runtime ground truth for go-live verification. auto_sanitize=true
            // means checkI8 owns the soak (shadow boost stood down); effective_interval_h reflects the
            // current season; last_satisfied=true confirms the coil's potable slug was pasteurized.
            // #135: per learned window, the measured draw sag and the pre-boost the plan sizes from it
            // (boost 0 / n < 3 = nothing planned for that window — the honest "not enough draws yet").
            dhw: {
              windows: dhwPreBoosts.map((w) => ({
                peak: [w.windowStart, w.windowEnd], draws: w.n, sag_p75_f: w.sagP75F, sag_median_f: w.sagMedianF,
                pre_draw_median_f: w.preDrawMedianF, trough_median_f: w.troughMedianF,
                boost_f: w.n >= MIN_PREBOOST_DRAWS && Math.round(w.sagP75F) >= MIN_PREBOOST_F ? Math.min(Math.round(w.sagP75F), MAX_PREBOOST_F) : 0,
              })),
              min_draws: MIN_PREBOOST_DRAWS, min_boost_f: MIN_PREBOOST_F, max_boost_f: MAX_PREBOOST_F, standby_f_per_h: STANDBY_F_PER_H,
              // peaks = hours where ≥ 50 % of observed days had a draw (unpadded); the floor windows are the padded 25 % ones
              peak_threshold: 0.5, floor_windows: learnedWindowsForHealth,
              // eval 2026-09-30 F6: did the boost actually fire? The last pre-boost block the auto-pilot acted on and how
              // (set | would-set | rate-limited | rejected: …); null until the first boost hour is reached.
              last_pre_boost: autopilot ? autopilot.lastPreBoost : null,
            },
            hygiene: {
              auto_sanitize: autoSanitizeLive,
              base_interval_h: HYGIENE_BASE_INTERVAL_H,
              summer_interval_h: HYGIENE_SUMMER_INTERVAL_H,
              effective_interval_h: i8LastIntervalH,
              last_dwell_min: i8LastDwellMin,
              last_satisfied: i8LastSatisfied,
              last_checked_at: i8LastCheckedAt,
              // The dwell RULE itself, so the dashboard renders the real bar instead of restating a
              // hardcoded one. hours_since_dwell null = no qualifying dwell in the whole window.
              hours_since_dwell: i8HoursSinceDwell == null ? null : Math.round(i8HoursSinceDwell * 10) / 10,
              verify_f: SANITIZE_VERIFY_F,
              dwell_min_required: SANITIZE_DWELL_MIN,
              sanitize_f: DEFAULT_OPTS.sanitizeF,
              // blind = monitor can't confirm a soak because telemetry has holes (distinct from
              // "overdue", which is a confident no). largest_gap_min is the evidence.
              blind: i8LastBlind,
              largest_gap_min: i8LastGapMin,
              // Stagnation half — from OUR 5-min tank series (dhw.ts detectDrawTimes), not TempIQ's
              // recharge stream, which undercounts ~6× and lags a day. Context, never a gate.
              draws: dhwDraws
                ? {
                    window_days: DRAW_WINDOW_DAYS,
                    event_count: dhwDraws.eventCount,
                    last_draw_at: dhwDraws.lastDrawAt ? dhwDraws.lastDrawAt.toISOString() : null,
                    hours_since_last_draw:
                      dhwDraws.hoursSinceLastDraw == null ? null : Math.round(dhwDraws.hoursSinceLastDraw * 10) / 10,
                    max_gap_h: dhwDraws.maxGapH == null ? null : Math.round(dhwDraws.maxGapH * 10) / 10,
                  }
                : null,
            },
          });
        }
        // #122 Wave 2. Answering "is the house ready for the storm?" on 2026-09-26 took five
        // separate commands and a human to join up. Confidence that must be RECONSTRUCTED each
        // time is not confidence. Public and read-only, same as /health: this reports, it never
        // actuates. `ready` is deliberately conservative — anything unknown blocks rather than
        // passes, because a readiness check that goes green on missing data is worse than none.
        if (req.url === "/api/readiness") {
          const el: Record<string, { ok: boolean | null; detail: string }> = {};
          const pollAgeS = lastPollAt ? Math.round((Date.now() - Date.parse(lastPollAt)) / 1000) : null;
          el.planner = {
            ok: consecutiveFailures < OFFLINE_AFTER_FAILURES && pollAgeS != null && pollAgeS < 900,
            detail: pollAgeS == null ? "never polled" : `last poll ${pollAgeS}s ago, ${consecutiveFailures} consecutive failures`,
          };
          const held = !WRITER_LEASE_ENABLED ? null : writerLeaseState?.held === true;
          el.commanding = {
            ok: held === null ? true : held,
            detail: held === null ? "lease disabled by config"
              : held ? `lease held by ${writerLeaseState?.holder}`
              : "LEASE NOT HELD — planner is not driving the pumps",
          };
          // Phase B's own honest string is the evidence (#97): before that fix it lied "lease 90m".
          const noLease = Object.values(phaseB?.lastResults ?? {}).some((v) => /NO LEASE ARMED/.test(String(v)));
          el.failsafe = {
            ok: phaseB ? !noLease : null,
            detail: !phaseB ? "phase B disabled" : noLease
              ? "FINDING-1 (#117): the Pi armed NO lease — revert-to-baseline CANNOT fire"
              : "Pi confirmed a lease — revert-to-baseline armed",
          };
          const t = lastThermal.tank_f;
          el.thermal = {
            ok: t == null ? null : t >= DEFAULT_OPTS.dhwFloorF,
            detail: t == null ? "no tank reading" : `tank ${t}F vs ${DEFAULT_OPTS.dhwFloorF}F DHW floor`,
          };
          el.storm = {
            ok: true, // informational: armed is neither good nor bad, it is a state
            detail: stormState.kind === "idle" ? "idle"
              : `${stormState.kind} (${stormState.trigger}) until ${stormState.kind === "armed" || stormState.kind === "active" ? stormState.windowEnd : "-"}`,
          };
          const blocking = Object.entries(el).filter(([, v]) => v.ok !== true).map(([k]) => k);
          return json(res, 200, {
            ready: blocking.length === 0,
            blocking,
            elements: el,
            note: "read-only; `ready` fails closed on unknowns. Propane, generator, trees and the water valve are NOT visible here — see epic #122.",
            at: new Date().toISOString(),
          });
        }

        if (req.url === "/api/drill" && req.method === "POST") {
          // Winter-readiness alert drill (owner-triggered, authed): fires the REAL alert
          // paths with [DRILL] prefixes at their REAL priorities so the whole tiering is
          // exercised end to end — urgent → ntfy + email, high → ntfy only. The safety
          // stack was built in August; this is how it gets proven before January without
          // faking sensor state. WARN THE OWNER FIRST — the messages look real on arrival.
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });
          await ntfy(
            "[DRILL] Freeze-risk advisory",
            "Drill of the PAGE tier (phone push + email). No freeze risk exists — if you received this by EMAIL and on your PHONE, the winter safety channel works end to end.",
            "urgent",
            { tier: "page" },
          );
          await ntfy(
            "[DRILL] Needs a look",
            "Drill of the ATTENTION tier (email only). If this arrived as an email and NOT on your phone, the tiering is correct.",
            "high",
            { tier: "attention" },
          );
          return json(res, 200, {
            fired: [
              { drill: "page", tier: "page",
                expect: "6bb phone push AND email, subject '🚨 A2W — [DRILL] …'" },
              { drill: "attention", tier: "attention",
                expect: "email ONLY, subject 'A2W needs a look — [DRILL] …' — a phone push here is the regression" },
            ],
          });
        }
        if (req.url === "/api/hbx/target" || req.url === "/api/hbx/restore" || req.url === "/api/hbx/boost") {
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });
          if (req.url === "/api/hbx/target" && req.method === "GET") {
            return json(res, 200, await writer.status());
          }
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = JSON.parse((await readBody(req)) || "{}");
          if (req.url === "/api/hbx/restore") {
            // #232: the default returns the plant to the plan's command for the block in force; {"to":"as-found"}
            // (or {"as_found":true}) is the pre-#232 emergency path — the July as-found endpoints, unconditionally.
            const to = body.to === "as-found" || body.as_found === true ? "as-found" : "plan";
            return json(res, 200, await writer.restore("dashboard", { endsBoost: true, to })); // the owner cancelled any boost
          }
          if (req.url === "/api/hbx/boost") {
            return json(res, 200, await writer.boost(Number(body.target_f), Number(body.minutes), "dashboard"));
          }
          return json(res, 200, await writer.setTarget(Number(body.target_f), "dashboard", undefined, { endsBoost: true }));
        }
        if (req.url === "/api/storm/arm" || req.url === "/api/storm/disarm") {
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (req.url === "/api/storm/arm") {
            const body = JSON.parse((await readBody(req)) || "{}");
            const hours = Math.min(Math.max(Number(body.hours) || 24, 1), 72);
            pendingManual = { armHours: hours };
          } else {
            pendingManual = { disarm: true };
          }
          await stormEvaluate(null); // manual wins in the machine — no need to wait on OutageWatch
          return json(res, 200, { state: stormState });
        }
        if (req.url === "/api/autonomy") {
          // W2-A: the dashboard Off/Armed switch. Same bearer gate as the other write routes; the
          // dashboard proxy holds the token server-side. Writes the runtime controller_flags row and
          // applies it to the in-memory controllers immediately (next poll would also pick it up).
          // off → both shadow (dry-run); arm → both live. set/req are future modes → 501.
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });
          if (req.method === "GET") {
            const f = await store.getControllerFlags();
            return json(res, 200, f ?? { mode: "off", autopilotDryRun: true, phasebDryRun: true });
          }
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = JSON.parse((await readBody(req)) || "{}");
          const mode = String(body.mode ?? "");
          if (mode !== "off" && mode !== "arm") {
            const future = mode === "set" || mode === "req";
            return json(res, future ? 501 : 400, {
              error: future
                ? `mode '${mode}' is not implemented yet (fast-follow) — only 'off' and 'arm' actuate today`
                : "mode must be 'off' or 'arm'",
            });
          }
          const dry = mode === "off"; // off = shadow (compute + log, write nothing)
          const curFlags = await store.getControllerFlags(); // preserve the independent auto-sanitize toggle
          const stored = await store.setControllerFlags({
            mode, autopilotDryRun: dry, phasebDryRun: dry,
            autoSanitize: curFlags?.autoSanitize ?? AUTO_SANITIZE_ENABLED, updatedBy: "dashboard",
          });
          if (autopilot) autopilot.setDryRun(stored.autopilotDryRun);
          if (phaseB) phaseB.setDryRun(stored.phasebDryRun);
          await ntfy(
            "Autonomy mode changed",
            `→ ${mode.toUpperCase()} (autopilot ${dry ? "shadow" : "LIVE"}, phase-b ${dry ? "shadow" : "LIVE"}) via dashboard`,
            mode === "arm" ? "high" : "default",
            { tier: "record" }, // the owner's own dashboard action: never notify them of it
          );
          console.log(`[autonomy] mode → ${mode} (dry-run ${dry}) via dashboard`);
          return json(res, 200, { ok: true, ...stored });
        }
        if (req.url === "/api/identification") {
          // Identification driver mode (identify.ts): off | shadow | armed. Independent of the autonomy
          // switch and of auto-sanitize — flips controller_flags.identification_mode and applies it live.
          // Same bearer gate as every other write route; the dashboard proxy holds the token.
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });
          if (req.method === "GET") {
            const cur = await store.getControllerFlags();
            return json(res, 200, { mode: cur?.identificationMode ?? IDENTIFICATION_MODE_SEED, driver: identification ? identification.status() : "disabled" });
          }
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = JSON.parse((await readBody(req)) || "{}");
          const mode = String(body.mode ?? "");
          if (!(IDENT_MODES as readonly string[]).includes(mode)) return json(res, 400, { error: "mode must be 'off' | 'shadow' | 'armed'" });
          await store.setIdentificationMode(mode, "dashboard");
          if (identification) identification.setMode(mode as IdentMode);
          await ntfy(
            "Identification mode changed",
            `→ ${mode.toUpperCase()} via dashboard${identification ? "" : " (driver not constructed on this deploy — set IDENTIFICATION_ENABLED=1)"}`,
            mode === "armed" ? "high" : "default",
            { tier: "record" }, // the owner's own dashboard action: never notify them of it
          );
          console.log(`[identify] mode → ${mode} via dashboard`);
          return json(res, 200, { ok: true, mode, driver: identification ? identification.status() : "disabled" });
        }
        if (req.url === "/api/sanitize") {
          // Dashboard I8 auto-sanitize toggle. INDEPENDENT of the autonomy mode — flips auto_sanitize in
          // the same controller_flags row (preserving mode + both dry-runs) and applies it live to the
          // checkI8 gate + shadow interlock. Same bearer gate as the other write routes.
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });
          const cur = await store.getControllerFlags();
          if (req.method === "GET") {
            return json(res, 200, { enabled: cur?.autoSanitize ?? AUTO_SANITIZE_ENABLED });
          }
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          const body = JSON.parse((await readBody(req)) || "{}");
          if (typeof body.enabled !== "boolean") return json(res, 400, { error: "body.enabled must be a boolean" });
          const base = cur ?? { mode: "off", autopilotDryRun: AUTOPILOT_DRY_RUN, phasebDryRun: PHASE_B_DRY_RUN };
          const stored = await store.setControllerFlags({
            mode: base.mode, autopilotDryRun: base.autopilotDryRun, phasebDryRun: base.phasebDryRun,
            autoSanitize: body.enabled, updatedBy: "dashboard",
          });
          autoSanitizeLive = stored.autoSanitize;
          writer.setAutoSanitize(autoSanitizeLive);
          await ntfy(
            `Auto-sanitize ${body.enabled ? "ARMED" : "disarmed"}`,
            `Daily I8 pasteurization ${body.enabled ? "will now fire automatically when overdue" : "is back to alert-only"} (via dashboard).`,
            body.enabled ? "high" : "default",
            { tier: "record" }, // the owner's own dashboard action: never notify them of it
          );
          console.log(`[sanitize] auto_sanitize → ${body.enabled} via dashboard`);
          return json(res, 200, { ok: true, enabled: stored.autoSanitize });
        }
        if (req.url === "/api/tempiq/cop-refetch") {
          // One-off mirror repair (TempIQv2#2124: TempIQ backfilled Sep 29 → Oct 27 with timestamps older than the
          // mirror's cursor): walk TempIQ's COP measurements from an explicit `since` (optional exclusive `before`)
          // and upsert them — the hourly tick's own walk, just from a caller-chosen bound. Same bearer gate as
          // POST /api/hbx/target. Runs inline on this request (a one-off; the poll loop is a separate timer and the
          // upsert is idempotent, so overlapping with a tick is harmless) with the reader's 20 s per-request
          // timeout and a 50-page bound. 401 no bearer · 405 not POST · 503 reader off · 422 malformed / future /
          // > 400-day since or a before ≤ since · 409 one already running · 502 a page failed (partial counts in
          // the body). The summary also sits on /health.tempiq_read.lastCopRefetch.
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (!tempiqRead) return json(res, 503, { error: "tempiq read disabled (TEMPIQ_READ_ENABLED=1 + TEMPIQ_SURFACE_TOKEN)" });
          let body: unknown;
          try { body = JSON.parse((await readBody(req)) || "{}"); } catch { return json(res, 422, { error: "body must be JSON: {\"since\": ISO, \"before\"?: ISO}" }); }
          const parsed = parseCopRefetchRequest(body, new Date());
          if (!parsed.ok) return json(res, 422, { error: parsed.error });
          if (tempiqRead.refetchInFlight()) return json(res, 409, { error: "a cop-refetch is already running on this instance" });
          const summary = await tempiqRead.refetchCop(parsed.since, parsed.before);
          return json(res, summary.error ? 502 : 200, summary);
        }
        res.writeHead(404).end();
      } catch (e) {
        if (e instanceof WriteError) return json(res, e.status, { error: e.message });
        console.error("api error:", e);
        return json(res, 500, { error: "internal error" });
      }
    })
    .listen(PORT, () => console.log(`a2w-planner (A-2 reader + A-5 shadow + I1 monitor + write API) on :${PORT}, polling every ${POLL_SECONDS}s`));

  // §6.11 trigger poll: own cadence, immediate first run so the first 5-min tick
  // (inside loop) already sees fresh NWS/OpenMeteo triggers.
  await stormTriggerPoll();
  setInterval(() => void stormTriggerPoll(), 30 * 60 * 1000);
  // #165: first computation in the background (never delays startup), then every 10 min
  void refreshPiLink();
  setInterval(() => void refreshPiLink(), PI_LINK_REFRESH_MS);

  // SPAN backup-element power alarm on its own tight cadence (default 60s) — independent of the
  // 5-min main loop so a running element is caught fast. No-op unless SPAN_USERNAME is configured.
  if (spanWatch) {
    void spanWatch.tick().catch((e) => console.error("spanwatch failed:", (e as Error).message));
    setInterval(() => void spanWatch.tick().catch((e) => console.error("spanwatch failed:", (e as Error).message)), SPAN_POLL_SECONDS * 1000);
  }

  await track(activeLoops, loop());
  setInterval(() => { if (!shuttingDown) void track(activeLoops, loop()); }, POLL_SECONDS * 1000);
  if (tempiq) {
    void tempiq.tick();
    setInterval(() => void tempiq.tick(), TEMPIQ_PUSH_EVERY_MIN * 60 * 1000);
  }
  if (tempiqRead) {
    void tempiqRead.tick();
    setInterval(() => void tempiqRead.tick(), TEMPIQ_READ_EVERY_MIN * 60 * 1000);
  }
  if (tempiqWindows) {
    void tempiqWindows.tick();
    setInterval(() => void tempiqWindows.tick(), TEMPIQ_WINDOWS_EVERY_MIN * 60 * 1000);
  }
  // Each hourly step runs on its own: a failed forecast fetch (open-meteo 429 after three deploys in an
  // hour, 2026-09-29 19:2xZ) used to abort the whole chain, so the decay scan, both TempIQ pushes, the
  // I8 check and the realized-savings engine all silently skipped an hour. None of them needs the plan.
  const step = (label: string, fn: () => Promise<unknown>) =>
    fn().then(() => {}, (e) => console.error(`${label} failed:`, (e as Error).message));
  const shadowLoop = async () => {
    if (shuttingDown) return;
    await step("shadow", shadowOnce);
    await step("score", scoreOnce);
    await step("decay scan", () => decayScanOnce(store));
    if (TEMPIQ_PUSH_ENABLED && TEMPIQ_SURFACE_TOKEN) {
      await step("tempiq-ua-push", () => pushTankUa(store, TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN));
      // gtm#1616 Part B: the measured reheat rate TempIQ prices down-probe recovery from.
      await step("tempiq-reheat-push", () => pushTankReheat(store, TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN));
    }
    await step("i8", checkI8);
    await step("realized-savings", () => realized.computeAndStore(REALIZED_LOOKBACK_DAYS));
  };
  await shadowLoop();
  setInterval(shadowLoop, SHADOW_EVERY_MIN * 60 * 1000);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
