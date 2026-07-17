/**
 * @purpose A2W planner service — Phase A-2: the SensorLinx reader. Polls the ECO-0600
 * every POLL_SECONDS via api.sensorlinx.co, stores narrow readings in Neon, versions any
 * config drift (curve/staging/backup edits) with an ntfy alert, and exposes /health.
 * Read-only: this service never writes to SensorLinx (write adapter = Phase C, plan §5.2).
 * Edge-triggered offline alerting after OFFLINE_AFTER_FAILURES consecutive poll failures.
 */

import http from "node:http";
import { SensorLinxClient } from "./sensorlinx";
import { Store, SlxReading } from "./store";
import { extractConfig, diffConfig } from "./drift";
import crypto from "node:crypto";
import { TempiqPusher } from "./tempiq";
import { TempiqReader } from "./tempiq-read";
import { HubClient } from "./hub";
import { computeShadowPlan, curveTargetF, fetchForecast, DEFAULT_OPTS, DemandFloor } from "./shadow";
import { AutoPilot } from "./autopilot";
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
import { DemandFeed } from "./demand";
import { logAdjacencyShadowFloor } from "./spatial";
import { learnDhwWindows } from "./dhw";
import { HbxWriter, WriteError } from "./writes";
import { PhaseB } from "./phaseb";
import { decayScanOnce } from "./decay";
import { pushTankUa } from "./tank-ua-push";

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
const OFFLINE_AFTER_FAILURES = 5;

const HUB_URL = process.env.HUB_URL;
const HUB_CLIENT_TOKEN = process.env.HUB_CLIENT_TOKEN;
const LAT = process.env.LAT ?? "42.63";
const LON = process.env.LON ?? "-70.87";
const SHADOW_EVERY_MIN = Number(process.env.SHADOW_EVERY_MIN ?? "60");

const PLANNER_API_TOKEN = process.env.PLANNER_API_TOKEN;

// Storm mode (§6.11, W0-5). Notify-first: triggers always page the owner, but the plan
// is only shaped when STORM_MODE_ENABLED=1 (plan §11 Q6 is an open owner question).
const STORM_MODE_ENABLED = process.env.STORM_MODE_ENABLED === "1";
const STORM_CAP_F = Number(process.env.STORM_CAP_F ?? "135");
const OUTAGEWATCH_URL = process.env.OUTAGEWATCH_URL ?? "https://victorious-light-production.up.railway.app";

const slx = new SensorLinxClient(EMAIL, PASSWORD);
const store = new Store(DATABASE_URL);
const hub = HUB_URL && HUB_CLIENT_TOKEN ? new HubClient(HUB_URL, HUB_CLIENT_TOKEN) : null;
if (!hub) console.warn("HUB_URL/HUB_CLIENT_TOKEN not set — I1 monitor disabled");
if (!PLANNER_API_TOKEN) console.warn("PLANNER_API_TOKEN not set — write API disabled");

const PHASE_B_ENABLED = process.env.PHASE_B_ENABLED === "1";
const PHASE_B_DRY_RUN = process.env.PHASE_B_DRY_RUN === "1";
// Auto-pilot: drive the HBX buffer TARGET to the shadow plan's current-hour value (target-side
// twin of Phase B). Off by default; DRY_RUN=1 logs what it would set without writing.
const AUTOPILOT_ENABLED = process.env.AUTOPILOT_ENABLED === "1";
const AUTOPILOT_DRY_RUN = process.env.AUTOPILOT_DRY_RUN === "1";

// Phase 3 v2: narrow daily auto-sanitize. The FIRST automated write to the pumps.
// OFF by default — deploying this changes NOTHING until AUTO_SANITIZE_ENABLED=1.
// When on, the I8 hygiene check fires one durable/guarded boost(131,60) per overdue
// soak (see checkI8). Fail-safe: a rejected boost falls through to the existing alert.
const AUTO_SANITIZE_ENABLED = process.env.AUTO_SANITIZE_ENABLED === "1";
const PHASE_B_PUMPS = (process.env.PHASE_B_PUMPS ?? "pump1,pump2").split(",").map((s) => s.trim()).filter(Boolean);
const phaseB = PHASE_B_ENABLED && hub
  ? new PhaseB(store, hub, PHASE_B_PUMPS, PHASE_B_DRY_RUN, ntfy)
  : null;

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
const tempiqRead = TEMPIQ_READ_ENABLED && TEMPIQ_SURFACE_TOKEN
  ? new TempiqReader(store, TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN)
  : null;
if (TEMPIQ_READ_ENABLED && !tempiqRead) console.warn("TEMPIQ_READ_ENABLED but TEMPIQ_SURFACE_TOKEN missing — reader disabled");

// Winter-solver shadow seam (§6.9, W0-4). SHADOW ONLY: proposes demand floors to the
// shadow planner and snapshots them; flag off = today's behavior byte-for-byte.
const WINTER_SOLVER_SHADOW = process.env.WINTER_SOLVER_SHADOW === "1";
const demandFeed = WINTER_SOLVER_SHADOW && TEMPIQ_SURFACE_TOKEN
  ? new DemandFeed(TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN)
  : null;
if (WINTER_SOLVER_SHADOW && !demandFeed) console.warn("WINTER_SOLVER_SHADOW but TEMPIQ_SURFACE_TOKEN missing — winter solver shadow disabled");

// Adjacency-aware setback shadow (#33). SHADOW ONLY: logs what the tank floor WOULD be if warm-adjacent
// zones borrowed heat (deeper-setback savings), on top of the winter-solver floor. Never changes the
// live floor/setpoint. Flag off = no behavior change and no extra fetch.
const ADJACENCY_SETBACK_SHADOW = process.env.ADJACENCY_SETBACK_SHADOW === "1";
if (PHASE_B_ENABLED && !hub) console.warn("PHASE_B_ENABLED but no hub configured — tracking disabled");
if (phaseB) console.log(`PHASE B ${PHASE_B_DRY_RUN ? "DRY-RUN" : "ACTIVE"} for ${PHASE_B_PUMPS.join(", ")} (target + ${5}°F, leased)`);

const cToF = (c: number) => (c * 9) / 5 + 32;

let lastPollAt: string | null = null;
let lastDriftAt: string | null = null;
let lastShadowAt: string | null = null;
let consecutiveFailures = 0;
let offlineAlerted = false;
let i1Violated = false;
let i1Detail: string | null = null;

// §6.11 storm machine state: trigger caches refreshed by the 30-min poll, the state
// itself stepped once per 5-min loop tick (and immediately on a manual arm/disarm).
let stormState: StormState = { kind: "idle" };
let pendingManual: { armHours?: number; disarm?: boolean } | null = null;
let stormAlerts: StormAlert[] = [];
let stormSynthetic: SyntheticTrigger[] = [];
let lastStormPollAt: string | null = null;

async function ntfy(title: string, body: string, priority = "default"): Promise<void> {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: title, Priority: priority, Tags: "hbx" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("ntfy send failed:", (e as Error).message);
  }
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
 * I1 (plan §3): every online pump's setpoint must sit above tank target + margin, or the
 * tank sensor can't terminate calls (the calls-forever deadlock → bkLag → 16.5 kW element).
 * Edge-triggered: one high-priority alert on entry, one notice on clear.
 */
async function checkI1(tankTargetF: number | null): Promise<void> {
  if (!hub || tankTargetF == null) return;
  let state;
  try {
    state = await hub.getState();
  } catch (e) {
    console.warn("I1 check skipped — hub unreachable:", (e as Error).message);
    return;
  }
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
      `Tank target ${tankTargetF.toFixed(1)}°F.\n${i1Detail}\nUnreachable-target deadlock risk — raise the HP setpoint or lower the HBX target.`,
      "high",
    );
  } else if (!offenders.length && i1Violated) {
    i1Violated = false;
    i1Detail = null;
    await store.closeI1Episode().catch(() => {});
    await ntfy("I1 cleared", `All online pump setpoints back above tank target + ${DEFAULT_OPTS.i1MarginF}°F.`);
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

/** Longest continuous span (minutes) the tank held ≥ minF, from the ascending reading series. */
function longestDwellMin(series: { ts: Date; tankF: number | null }[], minF: number): number {
  let best = 0;
  let runStart: Date | null = null;
  let runLast: Date | null = null;
  for (const r of series) {
    if (r.tankF != null && r.tankF >= minF) {
      if (runStart == null) runStart = r.ts;
      runLast = r.ts;
    } else if (runStart && runLast) {
      best = Math.max(best, (runLast.getTime() - runStart.getTime()) / 60000);
      runStart = runLast = null;
    }
  }
  if (runStart && runLast) best = Math.max(best, (runLast.getTime() - runStart.getTime()) / 60000);
  return best;
}

/** I8 thermal hygiene (plan §5.1): page if a rolling 26 h passes without a real pasteurizing dwell
 *  (≥SANITIZE_VERIFY_F for ≥SANITIZE_DWELL_MIN continuous min) — the DHW coil's potable slug must get
 *  its daily hot soak. Checked hourly; edge-alerted with a clear once satisfied. Trivially satisfied
 *  under as-found/current temps; load-bearing once the cool-tank optimized targets run. */
let i8Alerted = false;
async function checkI8(): Promise<void> {
  const res = await store.getRecentSeries(26);
  const dwellMin = longestDwellMin(res, SANITIZE_VERIFY_F);
  const satisfied = dwellMin >= SANITIZE_DWELL_MIN;
  const overdue = !satisfied && res.length > 200; // require a mostly-complete window

  // Phase 3 v2: auto-sanitize. When the flag is ON and the soak is overdue, fire ONE durable/guarded
  // boost to the 140°F sanitize target (sanitizeCapF so it isn't clamped to 135; I1 still guards) for
  // long enough to reach temp AND hold the dwell. Idempotency guard: skip if a boost is already active
  // (the soak stays unsatisfied for several polls while the water heats). The boost reuses the
  // human-triggered write primitive verbatim (envelope + I1 + rate limit + read-back + audit all
  // apply). Fail-safe: if setTarget rejects (e.g. I1 — a pump setpoint below target+margin), do NOT
  // retry; fall through to the overdue-soak alert so the owner is notified and nothing is forced.
  if (overdue && AUTO_SANITIZE_ENABLED) {
    const active = await store.activeBoost().catch(() => null);
    if (!active) {
      try {
        await writer.boost(DEFAULT_OPTS.sanitizeF, 120, "auto-sanitize", DEFAULT_OPTS.sanitizeCapF);
        await ntfy("Auto-sanitize", `Daily ${DEFAULT_OPTS.sanitizeF}°F soak triggered automatically.`);
        return; // boost placed; the soak will satisfy within ~24h — don't also alert
      } catch (e) {
        // Rejected (guardrail) or write failure — let the overdue alert below fire.
        console.warn("auto-sanitize boost rejected/failed:", (e as Error).message);
      }
    } else {
      return; // boost already running toward the soak — in progress, don't alert
    }
  }

  if (overdue && !i8Alerted) {
    i8Alerted = true;
    await ntfy(
      `I8 hygiene: no ${SANITIZE_DWELL_MIN}-min ≥${SANITIZE_VERIFY_F}°F soak in 26h`,
      `The DHW coil's potable slug hasn't held a pasteurizing soak (needs ≥${SANITIZE_VERIFY_F}°F for ${SANITIZE_DWELL_MIN} min; best in the window: ${Math.round(dwellMin)} min). Boost the tank to ${DEFAULT_OPTS.sanitizeF}°F for ~2h (Control → HBX card), or check why the planner's sanitize didn't run.`,
      "high",
    );
  } else if (satisfied && i8Alerted) {
    i8Alerted = false;
    await ntfy("I8 hygiene satisfied", `Tank held ≥${SANITIZE_VERIFY_F}°F for ${Math.round(dwellMin)} min — daily pasteurization met.`);
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
async function checkUnservedCall(reading: SlxReading): Promise<void> {
  if (!hub) return;
  const anyStageCall = reading.stagesCalled?.some(Boolean) === true;
  if (!anyStageCall) {
    unservedStreak = 0;
    if (unservedAlerted) {
      unservedAlerted = false;
      await store.closeUnservedEpisode().catch(() => {});
      await ntfy("Unserved call cleared", "The heat call ended or a pump is running again.");
    }
    return;
  }
  let running = false;
  try {
    const st = await hub.getState();
    running = st.pumps.some((p) => p.online && p.state === "heating");
  } catch {
    return; // hub unreachable — can't judge; don't false-alarm
  }
  if (running) {
    unservedStreak = 0;
    if (unservedAlerted) {
      unservedAlerted = false;
      await store.closeUnservedEpisode().catch(() => {});
      await ntfy("Unserved call cleared", "A pump is running against the call again.");
    }
    return;
  }
  unservedStreak++;
  if (unservedStreak >= 2 && !unservedAlerted) {
    unservedAlerted = true;
    const detail = `HBX stage call active ~${unservedStreak * 5} min with no pump running (tank ${reading.tankF ?? "?"}°F / target ${reading.tankTargetF ?? "?"}°F)`;
    await store.openUnservedEpisode(detail).catch(() => {});
    await ntfy(
      "⚠ Heat call active but NO pump is running",
      `${detail}. Causes: pump powered off, failure-to-start (the HP2 winter pattern), or a write-disabled/faulted unit. The tank is falling while HBX waits.`,
      "high",
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
    );
  } else if (called === false && backupWasCalled) {
    backupWasCalled = false;
    await ntfy("Backup element call ended", "HBX released the backup element.");
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
 *   (b) the divergence has persisted past ADOPTION_STALE_MS with no convergence — covers the RAISE
 *       case, where the device is satisfied at its old (lower) target and will never call on its
 *       own, so signal (a) can never arrive.
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
      await ntfy("HBX target adoption recovered", `Operative target now matches the commanded ${commanded.toFixed(1)}°F.`);
    }
    return;
  }

  // Diverged: track how long, and whether a reheat has had a chance to re-read the curve.
  if (adoptionOffSince == null) adoptionOffSince = Date.now();
  if (reading.stagesCalled?.some(Boolean) === true) adoptionReheatSeenWhileOff = true;
  const offForMs = Date.now() - adoptionOffSince;

  if ((adoptionReheatSeenWhileOff || offForMs > ADOPTION_STALE_MS) && !adoptionAlerted) {
    adoptionAlerted = true;
    const why = adoptionReheatSeenWhileOff
      ? "a reheat has run but the operative target never moved onto it"
      : `it has stayed diverged for ${Math.round(offForMs / 60000)} min with no adopting reheat`;
    console.warn(`ADOPTION FAILED: commanded ${commanded.toFixed(1)}°F, operative ${operative.toFixed(1)}°F — ${why}`);
    await ntfy(
      "HBX target not adopting",
      `Commanded ${commanded.toFixed(1)}°F but operative is ${operative.toFixed(1)}°F — ${why}. The cloud reset-curve write did not take effect on the device. Check the curve / re-command.`,
      "high",
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
    stormSynthetic = deriveSyntheticTriggers(await fetchStormForecast(LAT, LON));
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
      ceilingF = stormCeilingF(curve, STORM_CAP_F);
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
    );
  } else {
    await store.closeStormEvent().catch((e) => console.error("storm event close failed:", (e as Error).message));
    await ntfy(`Storm mode stand-down: ${transitions.join(", ")}`, "Storm window closed — back to the normal plan.");
  }
}

/** 5-min tick: OutageWatch (unreachable → null = NO signal) then one machine step. */
async function stormTick(): Promise<void> {
  const outage = await fetchOutageStatus(OUTAGEWATCH_URL); // never throws
  await stormEvaluate(outage ? outage.hasActiveOutage : null);
}

async function shadowOnce(): Promise<void> {
  const forecast = await fetchForecast(LAT, LON);
  const cfg = await store.latestConfig();

  // learned DHW windows once ≥5 days of tank history exist; fixed defaults until then
  let learned = null;
  try {
    learned = learnDhwWindows(await store.getTankHistory(14));
  } catch (e) {
    console.warn("dhw learner failed, using default windows:", (e as Error).message);
  }
  const opts = learned ? { ...DEFAULT_OPTS, dhwWindows: learned.windows } : DEFAULT_OPTS;

  // §6.9 demand floor: degraded feed → null floor → winter blocks keep the curve mimic.
  let demandFloor: DemandFloor | null = null;
  if (demandFeed) {
    await demandFeed.refresh(); // never throws
    const latest = await store.getLatestSlx().catch(() => null);
    const outdoorF = latest?.outdoorF ?? forecast[0]?.outdoorF ?? null;
    const floor = outdoorF != null ? demandFeed.proposeFloor(outdoorF) : null;
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
      }
    }
  }

  const plan = computeShadowPlan(forecast, cfg, opts, demandFloor);
  if (!plan.length) throw new Error("empty forecast");

  // §6.11 storm shaping — gated on the flag; notify-only mode leaves the plan untouched.
  // Only-raises rule: a storm never lowers a block below what the plan already wanted.
  if (STORM_MODE_ENABLED && (stormState.kind === "armed" || stormState.kind === "active")) {
    const storm = stormState;
    const startMs = storm.kind === "armed" ? Date.parse(storm.windowStart) : 0;
    const endMs = Date.parse(storm.windowEnd);
    for (const block of plan) {
      const tsMs = Date.parse(block.ts);
      if (!(tsMs >= startMs && tsMs <= endMs)) continue;
      const ceiling = Math.round(stormCeilingF(cfg ? curveTargetF(cfg, block.outdoor_f) : null, STORM_CAP_F));
      const raised = Math.max(block.tank_target_f, ceiling);
      if (raised === block.tank_target_f) continue;
      block.tank_target_f = raised;
      block.hp1_setpoint_f = Math.round(Math.min(Math.max(raised + opts.i1MarginF, opts.hpMinF), opts.hpMaxF));
      block.reason = `storm mode: banking heat (${storm.trigger})`;
    }
  }

  await store.insertShadowPlan(plan, {
    dhw_windows: opts.dhwWindows,
    windows_learned: !!learned,
    learn_days: learned?.days ?? 0,
    draw_events: learned?.drawEvents ?? 0,
  });
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
    const gap = a.targetF == null ? null : a.targetF - block.tank_target_f;
    await store.upsertPlanScore({
      hourTs: a.hour,
      shadowTargetF: block.tank_target_f,
      actualTargetF: a.targetF,
      actualTankF: a.tankF,
      gapF: gap,
      planComputedAt: plan.computedAt,
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
const writer = new HbxWriter(slx, store, hub, BUILDING_ID, SYNC_CODE, ntfy, AUTO_SANITIZE_ENABLED);
const autopilot = AUTOPILOT_ENABLED ? new AutoPilot(store, writer, AUTOPILOT_DRY_RUN, ntfy) : null;

async function pollOnce(): Promise<void> {
  const dev = await slx.getDevice(BUILDING_ID, SYNC_CODE);
  const reading = toReading(dev);
  await store.insertReading(reading);
  await checkI1(reading.tankTargetF);
  await checkBackupCalled(reading.backupCalled);
  await checkUnservedCall(reading).catch((e) => console.error("unserved-call check failed:", (e as Error).message));
  await writer.expireBoosts().catch((e) => console.error("boost expiry failed:", (e as Error).message));
  if (phaseB) await phaseB.runOnce().catch((e) => console.error("phase-b failed:", (e as Error).message));
  if (autopilot) await autopilot.applyLatestPlan().catch((e) => console.error("autopilot failed:", (e as Error).message));

  // Heartbeat the planner's ACTUAL controller flags so the dashboard shows ground truth (the
  // Plan page reads this row instead of hardcoded copy — a stale updated_at ⇒ planner down).
  await store.upsertControllerStatus({
    autopilotEnabled: AUTOPILOT_ENABLED,
    autopilotDryRun: AUTOPILOT_DRY_RUN,
    autopilotResult: autopilot ? autopilot.lastResult : null,
    autopilotTargetF: autopilot ? autopilot.lastTargetF : null,
    phasebEnabled: PHASE_B_ENABLED,
    phasebDryRun: PHASE_B_DRY_RUN,
    phasebResult: phaseB ? (Object.values(phaseB.lastResults).join(" · ") || null) : null,
  }).catch((e) => console.error("controller status heartbeat failed:", (e as Error).message));

  const config = extractConfig(dev);
  await checkAdoption(reading, config as Record<string, number>).catch((e) => console.error("adoption check failed:", (e as Error).message));
  const prev = await store.latestConfig();
  if (prev === null) {
    await store.insertConfigVersion(config, null);
    console.log("seeded initial hbx_config_versions row");
  } else {
    const changes = diffConfig(prev, config);
    if (changes) {
      await store.insertConfigVersion(config, changes);
      lastDriftAt = new Date().toISOString();
      const summary = Object.entries(changes)
        .map(([k, c]) => `${k}: ${c.old} -> ${c.new}`)
        .join("\n");
      console.warn(`HBX CONFIG DRIFT:\n${summary}`);
      await ntfy("HBX config changed", summary, "high");
    }
  }
}

async function loop(): Promise<void> {
  try {
    await pollOnce();
    lastPollAt = new Date().toISOString();
    if (consecutiveFailures >= OFFLINE_AFTER_FAILURES && offlineAlerted) {
      await ntfy("SensorLinx reader recovered", `polling resumed at ${lastPollAt}`);
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
      );
    }
  }

  // §6.11: the outage check + storm machine step ride the same 5-min cadence, outside
  // the poll try/catch so a SensorLinx failure never skips a storm evaluation.
  try {
    await stormTick();
  } catch (e) {
    console.error("storm tick failed:", (e as Error).message);
  }
}

async function main(): Promise<void> {
  await store.ensureSchema();

  if (process.env.POLL_ONCE === "1") {
    await pollOnce();
    await shadowOnce();
    await scoreOnce();
    await decayScanOnce(store);
    if (TEMPIQ_PUSH_ENABLED && TEMPIQ_SURFACE_TOKEN) await pushTankUa(store, TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN);
    if (tempiq) await tempiq.tick();
    if (tempiqRead) await tempiqRead.tick();
    console.log("POLL_ONCE ok");
    await store.close();
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
            i1: hub ? { violated: i1Violated, detail: i1Detail } : "disabled",
            tempiq_push: tempiq ? tempiq.status() : "disabled",
            tempiq_read: tempiqRead ? tempiqRead.status() : "disabled",
            phase_b: phaseB
              ? { mode: PHASE_B_DRY_RUN ? "dry-run" : "active", pumps: PHASE_B_PUMPS, lastRunAt: phaseB.lastRunAt, lastResults: phaseB.lastResults }
              : "disabled",
            winter_solver: demandFeed
              ? { mode: demandFeed.isHealthy() ? "shadow" : "degraded", ...demandFeed.status() }
              : "off",
            storm: {
              state: stormState.kind,
              trigger: stormState.kind === "idle" ? null : stormState.trigger,
              windowEnd: stormState.kind === "idle" ? null : stormState.windowEnd,
              enabled: STORM_MODE_ENABLED,
              lastTriggerPollAt: lastStormPollAt,
            },
          });
        }
        if (req.url === "/api/hbx/target" || req.url === "/api/hbx/restore" || req.url === "/api/hbx/boost") {
          if (!authed(req)) return json(res, 401, { error: "unauthorized" });
          if (req.url === "/api/hbx/target" && req.method === "GET") {
            return json(res, 200, await writer.status());
          }
          if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
          if (req.url === "/api/hbx/restore") {
            return json(res, 200, await writer.restore("dashboard"));
          }
          const body = JSON.parse((await readBody(req)) || "{}");
          if (req.url === "/api/hbx/boost") {
            return json(res, 200, await writer.boost(Number(body.target_f), Number(body.minutes), "dashboard"));
          }
          return json(res, 200, await writer.setTarget(Number(body.target_f), "dashboard"));
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

  await loop();
  setInterval(loop, POLL_SECONDS * 1000);
  if (tempiq) {
    void tempiq.tick();
    setInterval(() => void tempiq.tick(), TEMPIQ_PUSH_EVERY_MIN * 60 * 1000);
  }
  if (tempiqRead) {
    void tempiqRead.tick();
    setInterval(() => void tempiqRead.tick(), TEMPIQ_READ_EVERY_MIN * 60 * 1000);
  }
  const shadowLoop = () =>
    shadowOnce()
      .then(() => scoreOnce())
      .then(() => decayScanOnce(store).then(() => {}))
      .then(() => (TEMPIQ_PUSH_ENABLED && TEMPIQ_SURFACE_TOKEN
        ? pushTankUa(store, TEMPIQ_BASE_URL, TEMPIQ_SURFACE_TOKEN).then(() => {})
        : undefined))
      .then(() => checkI8())
      .catch((e) => console.error("shadow/score/decay/i8 failed:", (e as Error).message));
  await shadowLoop();
  setInterval(shadowLoop, SHADOW_EVERY_MIN * 60 * 1000);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
