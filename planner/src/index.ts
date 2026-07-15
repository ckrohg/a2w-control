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
import { computeShadowPlan, fetchForecast, DEFAULT_OPTS, DemandFloor } from "./shadow";
import { DemandFeed } from "./demand";
import { learnDhwWindows } from "./dhw";
import { HbxWriter, WriteError } from "./writes";
import { PhaseB } from "./phaseb";
import { decayScanOnce } from "./decay";

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

const slx = new SensorLinxClient(EMAIL, PASSWORD);
const store = new Store(DATABASE_URL);
const hub = HUB_URL && HUB_CLIENT_TOKEN ? new HubClient(HUB_URL, HUB_CLIENT_TOKEN) : null;
if (!hub) console.warn("HUB_URL/HUB_CLIENT_TOKEN not set — I1 monitor disabled");
if (!PLANNER_API_TOKEN) console.warn("PLANNER_API_TOKEN not set — write API disabled");

const PHASE_B_ENABLED = process.env.PHASE_B_ENABLED === "1";
const PHASE_B_DRY_RUN = process.env.PHASE_B_DRY_RUN === "1";
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

/** I8 thermal hygiene (plan §5.1): page if a rolling 26 h passes without the tank
 *  spending time ≥131 °F — the DHW coil's potable slug must get its daily hot soak.
 *  Checked hourly alongside the shadow loop; edge-alerted with a clear once satisfied.
 *  Trivially satisfied under as-found temps; load-bearing once optimized targets run. */
let i8Alerted = false;
async function checkI8(): Promise<void> {
  const res = await store.getRecentSeries(26);
  const hot = res.some((r) => r.tankF != null && r.tankF >= 131);
  if (!hot && !i8Alerted && res.length > 200) { // require a mostly-complete window
    i8Alerted = true;
    await ntfy(
      "I8 hygiene: no 131°F tank excursion in 26h",
      "The DHW coil's potable slug hasn't had its daily hot soak. Boost the tank target to 131°F+ for an hour (Control → HBX card), or check why the planner's sanitize boost didn't run.",
      "high",
    );
  } else if (hot && i8Alerted) {
    i8Alerted = false;
    await ntfy("I8 hygiene satisfied", "Tank reached ≥131°F — daily soak requirement met.");
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
    if (floor) {
      try {
        await store.insertZoneFloorSnapshot({
          ts: new Date(),
          zones: floor.perZone,
          bindingZone: floor.bindingZone,
          bindingAwtF: floor.bindingAwtF,
          tankTargetF: floor.tankTargetF,
          source: "insights",
        });
      } catch (e) {
        console.error("zone floor snapshot failed:", (e as Error).message);
      }
      if (floor.tankTargetF != null && floor.bindingZone != null && floor.bindingAwtF != null) {
        demandFloor = { tankTargetF: floor.tankTargetF, bindingZone: floor.bindingZone, awtF: floor.bindingAwtF };
      }
    }
  }

  const plan = computeShadowPlan(forecast, cfg, opts, demandFloor);
  if (!plan.length) throw new Error("empty forecast");
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
const writer = new HbxWriter(slx, store, hub, BUILDING_ID, SYNC_CODE, ntfy);

async function pollOnce(): Promise<void> {
  const dev = await slx.getDevice(BUILDING_ID, SYNC_CODE);
  const reading = toReading(dev);
  await store.insertReading(reading);
  await checkI1(reading.tankTargetF);
  await checkBackupCalled(reading.backupCalled);
  await writer.expireBoosts().catch((e) => console.error("boost expiry failed:", (e as Error).message));
  if (phaseB) await phaseB.runOnce().catch((e) => console.error("phase-b failed:", (e as Error).message));

  const config = extractConfig(dev);
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
}

async function main(): Promise<void> {
  await store.ensureSchema();

  if (process.env.POLL_ONCE === "1") {
    await pollOnce();
    await shadowOnce();
    await scoreOnce();
    await decayScanOnce(store);
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
        res.writeHead(404).end();
      } catch (e) {
        if (e instanceof WriteError) return json(res, e.status, { error: e.message });
        console.error("api error:", e);
        return json(res, 500, { error: "internal error" });
      }
    })
    .listen(PORT, () => console.log(`a2w-planner (A-2 reader + A-5 shadow + I1 monitor + write API) on :${PORT}, polling every ${POLL_SECONDS}s`));

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
      .then(() => checkI8())
      .catch((e) => console.error("shadow/score/decay/i8 failed:", (e as Error).message));
  await shadowLoop();
  setInterval(shadowLoop, SHADOW_EVERY_MIN * 60 * 1000);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
