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

const slx = new SensorLinxClient(EMAIL, PASSWORD);
const store = new Store(DATABASE_URL);

let lastPollAt: string | null = null;
let lastDriftAt: string | null = null;
let consecutiveFailures = 0;
let offlineAlerted = false;

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

async function pollOnce(): Promise<void> {
  const dev = await slx.getDevice(BUILDING_ID, SYNC_CODE);
  await store.insertReading(toReading(dev));

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
    console.log("POLL_ONCE ok");
    await store.close();
    return;
  }

  http
    .createServer((req, res) => {
      if (req.url === "/health") {
        const ok = consecutiveFailures < OFFLINE_AFTER_FAILURES;
        res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok, lastPollAt, lastDriftAt, consecutiveFailures }));
      } else {
        res.writeHead(404).end();
      }
    })
    .listen(PORT, () => console.log(`a2w-planner (A-2 reader) health on :${PORT}, polling every ${POLL_SECONDS}s`));

  await loop();
  setInterval(loop, POLL_SECONDS * 1000);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
