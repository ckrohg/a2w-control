/**
 * @purpose Cold-day rehearsal: ONE fake HTTP server standing in for every upstream the real planner talks
 * to — SensorLinx (device read + PATCH echo), the Railway hub (state + command), TempIQ (zones, calls,
 * identification plan, posts), open-meteo (hourly forecast), NWS and OutageWatch — driven by a scenario
 * JSON. Every request is appended to a JSONL log so the assertions can prove what the planner DID, not
 * what it logged. Localhost only; never touches production. Run via scripts/rehearsal/run.sh.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.REHEARSAL_PORT ?? "9101");
const SCENARIO = process.env.REHEARSAL_SCENARIO ?? path.join(__dirname, "scenarios", "cold-morning.json");
const LOG = process.env.REHEARSAL_LOG ?? path.join(__dirname, "out", "requests.jsonl");

type Scenario = {
  name: string;
  outdoorF: number;
  /** Hourly outdoor °F starting at the current hour (48 values); missing tail repeats the last. */
  forecastF: number[];
  tank: { actualF: number; targetF: number };
  device: Record<string, unknown>;
  zones: Array<Record<string, unknown> & { zoneId: string; deliveryType: string }>;
  calling: string[];
  hub: { pi_connected: boolean; pumps: Array<Record<string, unknown> & { id: string }> ; leaseMinutes: number | null };
  plan: { magnitudeF: number; durationMin: number; baseboardBaseF: number; radiantBaseF: number; safe: boolean };
  /** gtm#1618: what TempIQ's probe-interlock answers (default: not armed). */
  interlock?: { source: string; blocked?: string[]; stepped?: string[] };
};

const scenario: Scenario = JSON.parse(fs.readFileSync(SCENARIO, "utf8"));
fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.writeFileSync(LOG, "");

// ---- mutable world -------------------------------------------------------------------------------
const device: Record<string, any> = {
  syncCode: process.env.SLX_SYNC_CODE ?? "FAKE-0001",
  connected: true,
  temps: { temp1: { actual: scenario.tank.actualF, target: scenario.tank.targetF }, temp3: { actual: scenario.outdoorF } },
  demands: [{ name: "hd", activated: scenario.calling.length > 0 }, { name: "cd", activated: false }],
  stages: [{ activated: scenario.calling.length > 0 }, { activated: false }],
  backup: { activated: false },
  relStat: [scenario.calling.length > 0 ? 1 : 0, 0, 0, 0, 0, 0, 0, 0],
  ...scenario.device,
};
const patches: Array<{ ts: string; body: Record<string, unknown> }> = [];
const commands: Array<{ ts: string; body: Record<string, unknown> }> = [];
const posts: Array<{ ts: string; path: string; body: unknown }> = [];
const pumps = scenario.hub.pumps.map((p) => ({
  name: p.id, online: true, setpoint_c: 52, inlet_c: 38, outlet_c: 44, state: scenario.calling.length ? "heating" : "idle",
  write_enabled: true,
  remote_lease_until: scenario.hub.leaseMinutes == null ? null : Math.floor((Date.now() + scenario.hub.leaseMinutes * 60_000) / 1000),
  ...p,
}));

/** The HBX curve output at the live outdoor — how the ECO-0600 derives its tank target. */
function curveTargetF(): number {
  const { dot, wwsd, dbt, mbt } = device;
  const o = device.temps.temp3.actual as number;
  if (![dot, wwsd, dbt, mbt].every((v) => typeof v === "number")) return device.temps.temp1.target;
  if (o <= dot) return dbt;
  if (o >= wwsd) return mbt;
  return mbt + ((wwsd - o) / (wwsd - dot)) * (dbt - mbt);
}

function log(entry: Record<string, unknown>) {
  fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
}

function hourly(): { time: string[]; temperature_2m: number[] } {
  const start = new Date(); start.setMinutes(0, 0, 0); start.setHours(start.getHours() - 1);
  const time: string[] = []; const temperature_2m: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t = new Date(start.getTime() + i * 3600_000);
    // open-meteo with timezone=auto returns LOCAL wall-clock ISO strings without an offset.
    const pad = (n: number) => String(n).padStart(2, "0");
    time.push(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:00`);
    const f = scenario.forecastF[Math.max(0, Math.min(scenario.forecastF.length - 1, i - 1))];
    temperature_2m.push(f);
  }
  return { time, temperature_2m };
}

const BANDS: Array<[number, number]> = [[-10, 5], [5, 15], [15, 25], [25, 35], [35, 45], [45, 60]];
function identificationPlan() {
  const cells: unknown[] = [];
  for (const z of scenario.zones) {
    const verified = z.deliveryTypeVerified === true;
    const baseboard = z.deliveryType === "baseboard";
    for (const band of BANDS) {
      cells.push({
        zoneId: z.zoneId, zoneName: z.zoneName ?? z.zoneId, deliveryType: z.deliveryType,
        deliveryTypeSource: verified ? "owner_verified" : "inferred",
        band, status: verified ? "unidentified" : "not_probeable",
        suggest: verified ? {
          direction: "up", magnitudeF: scenario.plan.magnitudeF, durationMin: scenario.plan.durationMin,
          assignmentProbability: 0.5, informationGain: 0.9,
          baseAwtF: baseboard ? scenario.plan.baseboardBaseF : scenario.plan.radiantBaseF,
          aboveEverydayCap: baseboard, forecastComplete: true,
          safeToProbe: scenario.plan.safe ? { ok: true, binding: null } : { ok: false, binding: "room_deficit" },
        } : null,
      });
    }
  }
  return { generatedAt: new Date().toISOString(), cells };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });
}
function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const p = url.pathname; const m = req.method ?? "GET";
  const raw = await readBody(req);
  let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  log({ method: m, path: p, query: Object.fromEntries(url.searchParams), body });

  // ---- SensorLinx --------------------------------------------------------------------------------
  if (m === "POST" && p === "/account/login") return send(res, 200, { token: "fake-jwt" });
  if (m === "GET" && /^\/buildings\/[^/]+\/devices$/.test(p)) return send(res, 200, [device]);
  if (m === "PATCH" && /^\/buildings\/[^/]+\/devices\/[^/]+$/.test(p)) {
    Object.assign(device, body ?? {});
    device.temps.temp1.target = Math.round(curveTargetF() * 10) / 10;
    patches.push({ ts: new Date().toISOString(), body });
    return send(res, 200, device);
  }
  // ---- hub ---------------------------------------------------------------------------------------
  if (m === "GET" && p === "/api/state") return send(res, 200, { pi_connected: scenario.hub.pi_connected, ts: Date.now(), pumps });
  if (m === "POST" && p === "/api/command") {
    commands.push({ ts: new Date().toISOString(), body });
    const pump = pumps.find((x) => x.id === body?.pump_id);
    if (pump && typeof body?.value_c === "number") pump.setpoint_c = body.value_c;
    return send(res, 200, { ok: true, detail: "ack (rehearsal)" });
  }
  // ---- TempIQ ------------------------------------------------------------------------------------
  if (m === "GET" && p === "/api/insights/zones") return send(res, 200, { zones: scenario.zones });
  if (m === "GET" && p === "/api/insights/calls") return send(res, 200, { zones: scenario.zones.map((z) => ({ zoneId: z.zoneId, hvacStatus: scenario.calling.includes(z.zoneId) ? "HEATING" : "OFF" })) });
  if (m === "GET" && p === "/api/insights/identification-plan") return send(res, 200, identificationPlan());
  if (m === "GET" && p === "/api/insights/probe-interlock") return send(res, 200, { asOf: new Date().toISOString(), horizonMin: Number(url.searchParams.get("horizonMin") ?? 155), source: scenario.interlock?.source ?? "not_armed", switchbackActiveHydronicZoneIds: scenario.interlock?.blocked ?? [], steppedThermostatZoneIds: scenario.interlock?.stepped ?? [] });
  if (m === "POST" && p === "/api/insights/experiment-windows") { posts.push({ ts: new Date().toISOString(), path: p, body }); return send(res, 200, { upserted: Array.isArray(body?.windows) ? body.windows.length : 1, rejected: [] }); }
  if (m === "POST" && p === "/api/insights/readings") { posts.push({ ts: new Date().toISOString(), path: p, body }); return send(res, 200, { inserted: Array.isArray(body?.metrics) ? body.metrics.length : 0, deduped: 0 }); }
  if (m === "POST" && (p === "/api/insights/tank-standby-ua" || p === "/api/insights/tank-reheat-rate")) { posts.push({ ts: new Date().toISOString(), path: p, body }); return send(res, 200, { ok: true }); }
  if (m === "GET" && p === "/api/insights/cop-measurements") return send(res, 200, []);
  if (m === "GET" && p === "/api/insights/zone-energy") return send(res, 200, { zones: [] });
  if (m === "GET" && p === "/api/insights/spatial-graph") return send(res, 200, { nodes: [], edges: [] });
  if (m === "GET" && p === "/api/insights/dhw-usage") return send(res, 200, {});
  if (m === "GET" && p === "/api/insights/zones/required-supply-forecast") return send(res, 200, { generatedAt: new Date().toISOString(), forecast: { newestVintage: null, oldestVintage: null, hoursAvailable: 0, degradeReason: "rehearsal" }, zones: [] });
  // ---- weather / outage --------------------------------------------------------------------------
  if (m === "GET" && p === "/v1/forecast") {
    const h = hourly();
    return send(res, 200, { hourly: { time: h.time, temperature_2m: h.temperature_2m, wind_gusts_10m: h.time.map(() => 8), snowfall: h.time.map(() => 0), weather_code: h.time.map(() => 3) }, hourly_units: { temperature_2m: "°F", wind_gusts_10m: "mp/h", snowfall: "inch" } });
  }
  if (m === "GET" && p === "/alerts/active") return send(res, 200, { features: [] });
  if (m === "GET" && p === "/api/status") return send(res, 200, { hasActiveOutage: false });
  // ---- rehearsal control ------------------------------------------------------------------------
  if (m === "GET" && p === "/__state") return send(res, 200, { scenario: scenario.name, device, pumps, patches, commands, posts });
  if (m === "POST" && p === "/__tank") { device.temps.temp1.actual = body.actualF; return send(res, 200, { ok: true }); }
  log({ unhandled: true, method: m, path: p });
  return send(res, 404, { error: `rehearsal fake: unhandled ${m} ${p}` });
});

server.listen(PORT, "127.0.0.1", () => console.log(`[rehearsal] fake upstreams on http://127.0.0.1:${PORT} — scenario "${scenario.name}", log ${LOG}`));
