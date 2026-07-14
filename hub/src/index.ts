/**
 * a2w-hub — Railway hub.
 *
 * Relays between the Pi (WebSocket, dials OUT to /pi) and the optimizer/dashboard
 * (HTTP API). Follows CONTRACT — Pi bridge <-> Railway hub exactly.
 *
 * TRANSPORT: WebSocket. The Pi dials OUT to wss://<hub-host>/pi and holds the
 * connection. No inbound port on the Pi. Messages are JSON text frames.
 *
 * AUTH:
 *  - Pi -> hub WS handshake: header "Authorization: Bearer <HUB_PI_TOKEN>".
 *    Hub closes with WS code 4401 otherwise.
 *  - optimizer/dashboard -> hub HTTP: header "Authorization: Bearer <HUB_CLIENT_TOKEN>".
 *  - Secrets are env vars: HUB_PI_TOKEN, HUB_CLIENT_TOKEN, PORT. Constant-time compare.
 *
 * The hub holds AT MOST ONE Pi WS (new connection replaces old), buffers only the
 * latest state, pings the Pi every ~30s and drops it on a missed pong, and
 * correlates acks to pending commands by command_id (never resolving twice).
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "node:http";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 8080);
const HUB_PI_TOKEN = process.env.HUB_PI_TOKEN ?? "";
const HUB_CLIENT_TOKEN = process.env.HUB_CLIENT_TOKEN ?? "";

if (!HUB_PI_TOKEN) {
  console.warn("[hub] WARNING: HUB_PI_TOKEN is not set — all Pi handshakes will be rejected.");
}
if (!HUB_CLIENT_TOKEN) {
  console.warn("[hub] WARNING: HUB_CLIENT_TOKEN is not set — all HTTP client requests will be rejected.");
}

const PI_PING_INTERVAL_MS = 30_000; // ping the Pi every ~30s
const COMMAND_ACK_TIMEOUT_MS = 10_000; // await matching ack up to 10s

// Dead-man watchdog: the Pi checks in every ~15s, so if it goes silent past this threshold the
// hub pushes an ntfy alert. This is the external dead-man (a dead Pi can't alert about itself)
// running on infra we already own — no healthchecks.io. Fires only after we've seen the Pi at
// least once, and only on transitions (silent -> alert once, recovered -> notify once).
const NTFY_TOPIC = process.env.NTFY_TOPIC ?? "";
const NTFY_SERVER = process.env.NTFY_SERVER ?? "https://ntfy.sh";
const PI_SILENCE_ALERT_MS = Number(process.env.PI_SILENCE_ALERT_MS ?? 180_000); // 3 min grace
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS ?? 30_000);

// Optional email second channel (Resend) for the dead-man. RESEND_API_URL is overridable so
// tests can point it at a local catcher; without a verified sender domain Resend delivers only
// to your own account email (set RESEND_TO to that).
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_TO = process.env.RESEND_TO ?? "";
const RESEND_FROM = process.env.RESEND_FROM ?? "A2W Alerts <onboarding@resend.dev>";
const RESEND_API_URL = process.env.RESEND_API_URL ?? "https://api.resend.com/emails";

// ---------------------------------------------------------------------------
// Constant-time token comparison
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison. Hashes both sides to fixed-length buffers so
 * timingSafeEqual never throws on length mismatch and length is not leaked.
 * Returns false when the expected secret is empty (unconfigured).
 */
function constantTimeEqual(provided: string, expected: string): boolean {
  if (!expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Extract a bearer token from an Authorization header value, or "" if absent. */
function extractBearer(headerValue: string | undefined): string {
  if (!headerValue) return "";
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1].trim() : "";
}

/** Fire-and-forget ntfy push. No-op when NTFY_TOPIC is unset; never throws. */
async function notifyNtfy(title: string, message: string,
                          opts: { priority?: string; tags?: string } = {}): Promise<void> {
  if (!NTFY_TOPIC) return;
  try {
    // HTTP headers are ByteStrings (Latin-1) — strip anything above U+00FF so a stray emoji in
    // a title can never throw and silently kill the alert. Emoji belong in `tags`, which ntfy
    // renders (e.g. warning -> ⚠️); the message body (below) is UTF-8 and takes emoji fine.
    const headers: Record<string, string> = { Title: title.replace(/[^\x00-\xFF]/g, "").trim() };
    if (opts.priority) headers.Priority = opts.priority;
    if (opts.tags) headers.Tags = opts.tags;
    await fetch(`${NTFY_SERVER.replace(/\/+$/, "")}/${NTFY_TOPIC}`, {
      method: "POST", headers, body: message,
    });
  } catch (err) {
    console.warn(`[hub] ntfy push failed: ${(err as Error).message}`);
  }
}

/** Fire-and-forget email via Resend. No-op when RESEND_API_KEY/RESEND_TO unset; never throws.
 * Subject/body are JSON (UTF-8), so emoji are fine (unlike the ntfy header title). */
async function notifyEmail(subject: string, body: string): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_TO) return;
  try {
    await fetch(RESEND_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [RESEND_TO], subject, text: body }),
    });
  } catch (err) {
    console.warn(`[hub] resend email failed: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Message types (per CONTRACT)
// ---------------------------------------------------------------------------

interface PumpState {
  id: string;
  name: string;
  online: boolean;
  state: string;
  mode_kind: string;
  setpoint_c: number | null;
  inlet_c: number | null;
  outlet_c: number | null;
  ambient_c: number | null;
  power_w: number | null;
  active_faults: unknown;
  error_rate: number | null;
  remote_lease_until: number | null;
}

interface StateMessage {
  type: "state";
  ts: number;
  pumps: PumpState[];
}

interface AckMessage {
  type: "ack";
  command_id: string;
  ok: boolean;
  detail: string;
  setpoint_c: number | null;
}

// ---------------------------------------------------------------------------
// Hub state
// ---------------------------------------------------------------------------

/** The single active Pi socket, or null when no Pi is connected. */
let piSocket: WebSocket | null = null;

/** Latest state pushed by the Pi (only the latest is buffered). */
let lastState: StateMessage | null = null;

/** Dead-man state: when we last heard ANY frame from the Pi (server clock, not the Pi's),
 * whether we've ever seen it, and whether the silence alert already fired (transition de-dup). */
let lastPiSeenAt = 0;
let everSeenPi = false;
let piSilenceAlerted = false;

interface PendingCommand {
  resolve: (ack: AckMessage) => void;
  timer: NodeJS.Timeout;
}

/** command_id -> pending command awaiting its ack. */
const pending = new Map<string, PendingCommand>();

/**
 * Resolve a pending command exactly once. Clears its timeout and removes it from
 * the map so it can never be resolved twice.
 */
function settleCommand(commandId: string, ack: AckMessage): void {
  const entry = pending.get(commandId);
  if (!entry) return; // already settled (timeout or duplicate ack)
  pending.delete(commandId);
  clearTimeout(entry.timer);
  entry.resolve(ack);
}

// ---------------------------------------------------------------------------
// HTTP API (express)
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

/** GET /health — OPEN (no auth). */
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    pi_connected: piSocket !== null && piSocket.readyState === WebSocket.OPEN,
    last_state_ts: lastState ? lastState.ts : null,
  });
});

/** Middleware: require Bearer HUB_CLIENT_TOKEN (constant-time). */
function requireClientAuth(req: Request, res: Response, next: () => void): void {
  const token = extractBearer(req.header("authorization") ?? undefined);
  if (!constantTimeEqual(token, HUB_CLIENT_TOKEN)) {
    res.status(401).json({ ok: false, detail: "unauthorized" });
    return;
  }
  next();
}

/** GET /api/state — latest state the Pi pushed. */
app.get("/api/state", requireClientAuth, (_req: Request, res: Response) => {
  const connected = piSocket !== null && piSocket.readyState === WebSocket.OPEN;
  res.status(200).json({
    pi_connected: connected,
    ts: lastState ? lastState.ts : null,
    pumps: lastState ? lastState.pumps : [],
  });
});

/**
 * POST /api/command — body {pump_id, value_c, lease_minutes?, source?}.
 * Assigns command_id, relays to the Pi, awaits the matching ack (10s timeout).
 *   200 {ok:true, setpoint_c}  on ack ok
 *   502 {ok:false, detail}     on nack
 *   504                        on ack timeout
 *   503                        if no Pi connected
 */
app.post("/api/command", requireClientAuth, (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pumpId = body.pump_id;
  const valueC = body.value_c;

  if (typeof pumpId !== "string" || pumpId.length === 0) {
    res.status(400).json({ ok: false, detail: "pump_id is required (string)" });
    return;
  }
  if (typeof valueC !== "number" || !Number.isFinite(valueC)) {
    res.status(400).json({ ok: false, detail: "value_c is required (number)" });
    return;
  }

  let leaseMinutes: number | null = null;
  if (body.lease_minutes !== undefined && body.lease_minutes !== null) {
    if (typeof body.lease_minutes !== "number" || !Number.isFinite(body.lease_minutes)) {
      res.status(400).json({ ok: false, detail: "lease_minutes must be a number when provided" });
      return;
    }
    leaseMinutes = body.lease_minutes;
  }

  let source = "optimizer";
  if (body.source !== undefined && body.source !== null) {
    if (typeof body.source !== "string") {
      res.status(400).json({ ok: false, detail: "source must be a string when provided" });
      return;
    }
    source = body.source;
  }

  const sock = piSocket;
  if (!sock || sock.readyState !== WebSocket.OPEN) {
    res.status(503).json({ ok: false, detail: "no Pi connected" });
    return;
  }

  const commandId = randomUUID();
  const command = {
    type: "command" as const,
    command_id: commandId,
    action: "setpoint" as const,
    pump_id: pumpId,
    value_c: valueC,
    lease_minutes: leaseMinutes,
    source,
  };

  const timer = setTimeout(() => {
    // Timeout: settle as 504 and drop the pending entry so a late ack is ignored.
    if (pending.delete(commandId)) {
      res.status(504).json({ ok: false, detail: "ack timeout" });
    }
  }, COMMAND_ACK_TIMEOUT_MS);

  pending.set(commandId, {
    timer,
    resolve: (ack: AckMessage) => {
      if (ack.ok) {
        res.status(200).json({ ok: true, setpoint_c: ack.setpoint_c });
      } else {
        res.status(502).json({ ok: false, detail: ack.detail });
      }
    },
  });

  try {
    sock.send(JSON.stringify(command));
  } catch (err) {
    // Send failed synchronously — settle as 503 and clean up.
    if (pending.delete(commandId)) {
      clearTimeout(timer);
      res.status(503).json({ ok: false, detail: `relay failed: ${(err as Error).message}` });
    }
  }
});

/**
 * POST /api/write-enable — body {pump_id, enabled} (owner decision 2026-07-14: remote
 * arm/disarm of a pump's write path from the dashboard). DOUBLE-GATED: the client bearer
 * AND a SEPARATE X-Arm-Token header (HUB_ARM_TOKEN) which the dashboard's server releases
 * only after a fresh password re-entry — a stolen session or the ordinary client token
 * alone can never arm. Relays the write_enable action to the Pi (which applies its own
 * loud ceremony: audit event + high-priority push on enable) and awaits the ack.
 * 503 if HUB_ARM_TOKEN is unset (feature off), 401 on a bad arm token.
 */
app.post("/api/write-enable", requireClientAuth, (req: Request, res: Response) => {
  const armToken = process.env.HUB_ARM_TOKEN ?? "";
  if (!armToken) {
    res.status(503).json({ ok: false, detail: "arming not configured (HUB_ARM_TOKEN unset)" });
    return;
  }
  if (!constantTimeEqual(String(req.header("x-arm-token") ?? ""), armToken)) {
    res.status(401).json({ ok: false, detail: "bad arm token" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const pumpId = body.pump_id;
  const enabled = body.enabled;
  if (typeof pumpId !== "string" || pumpId.length === 0) {
    res.status(400).json({ ok: false, detail: "pump_id is required (string)" });
    return;
  }
  if (typeof enabled !== "boolean") {
    res.status(400).json({ ok: false, detail: "enabled is required (boolean)" });
    return;
  }
  const sock = piSocket;
  if (!sock || sock.readyState !== WebSocket.OPEN) {
    res.status(503).json({ ok: false, detail: "no Pi connected" });
    return;
  }
  const commandId = randomUUID();
  const timer = setTimeout(() => {
    if (pending.delete(commandId)) {
      res.status(504).json({ ok: false, detail: "ack timeout" });
    }
  }, COMMAND_ACK_TIMEOUT_MS);
  pending.set(commandId, {
    timer,
    resolve: (ack: AckMessage) => {
      if (ack.ok) {
        res.status(200).json({ ok: true, detail: ack.detail });
      } else {
        res.status(502).json({ ok: false, detail: ack.detail });
      }
    },
  });
  try {
    sock.send(JSON.stringify({
      type: "command" as const,
      command_id: commandId,
      action: "write_enable" as const,
      pump_id: pumpId,
      enabled,
      source: "armed-dashboard",
    }));
  } catch (err) {
    if (pending.delete(commandId)) {
      clearTimeout(timer);
      res.status(503).json({ ok: false, detail: `relay failed: ${(err as Error).message}` });
    }
  }
});

const server = app.listen(PORT, () => {
  console.log(`[hub] HTTP + WS listening on :${PORT}`);
});

if (!NTFY_TOPIC) {
  console.warn("[hub] NTFY_TOPIC not set — Pi-offline dead-man alerts are disabled.");
}

// Dead-man watchdog: alert once when the Pi goes silent past the grace window, and once when
// it returns. Silence is measured from the last frame we heard (lastPiSeenAt), so a brief
// reconnect (WiFi blip / redeploy) inside the window never fires a false alarm.
setInterval(() => {
  if (!everSeenPi || !NTFY_TOPIC) return;
  const silentMs = Date.now() - lastPiSeenAt;
  const silent = silentMs > PI_SILENCE_ALERT_MS;
  if (silent && !piSilenceAlerted) {
    piSilenceAlerted = true;
    const mins = Math.max(1, Math.round(silentMs / 60_000));
    // Title/Tags are HTTP headers → ASCII only; the `warning` tag renders as ⚠️ in ntfy.
    const title = "A2W: heat-pump bridge offline";
    const body = `The Pi hasn't checked in for ~${mins} min (power / WiFi / internet / bridge down). ` +
      "Heating still runs on the wall controllers + HBX; remote control is unavailable until it returns.";
    void notifyNtfy(title, body, { priority: "high", tags: "warning" });
    void notifyEmail(title, body);   // dead-man is rare + important → email too
  } else if (!silent && piSilenceAlerted) {
    piSilenceAlerted = false;
    const title = "A2W: heat-pump bridge back online";
    const body = "The Pi is checking in with the hub again.";
    void notifyNtfy(title, body, { priority: "default", tags: "white_check_mark" });
    void notifyEmail(title, body);   // closure for the offline email above
  }
}, WATCHDOG_INTERVAL_MS);

// ---------------------------------------------------------------------------
// WebSocket server (Pi bridge) — path /pi
// ---------------------------------------------------------------------------

// noServer so we can authenticate during the HTTP upgrade before accepting.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req: IncomingMessage, socket, head) => {
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "", "http://localhost").pathname;
  } catch {
    pathname = req.url ?? "";
  }

  if (pathname !== "/pi") {
    socket.destroy();
    return;
  }

  const token = extractBearer(req.headers["authorization"]);
  if (!constantTimeEqual(token, HUB_PI_TOKEN)) {
    // Reject the handshake, then close with the contract's 4401 code once open.
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.close(4401, "unauthorized");
    });
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws: WebSocket) => {
  // Hold AT MOST ONE Pi WS: a new connection replaces the old one.
  if (piSocket && piSocket !== ws) {
    try {
      piSocket.close(4000, "replaced by new Pi connection");
    } catch {
      /* ignore */
    }
  }
  piSocket = ws;
  lastPiSeenAt = Date.now();
  everSeenPi = true;
  console.log("[hub] Pi connected");

  // Liveness: mark alive on pong; drop on a missed ping->pong round.
  let isAlive = true;
  ws.on("pong", () => {
    isAlive = true;
    lastPiSeenAt = Date.now();
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!isAlive) {
      console.warn("[hub] Pi missed pong — terminating");
      ws.terminate();
      return;
    }
    isAlive = false;
    ws.ping();
    // Also send an application-level ping frame per CONTRACT (Pi replies {type:"pong"}).
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      /* ignore */
    }
  }, PI_PING_INTERVAL_MS);

  ws.on("message", (data: RawData) => {
    lastPiSeenAt = Date.now();
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn("[hub] dropping non-JSON frame from Pi");
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;

    switch (m.type) {
      case "state": {
        if (typeof m.ts === "number" && Array.isArray(m.pumps)) {
          lastState = { type: "state", ts: m.ts, pumps: m.pumps as PumpState[] };
        }
        break;
      }
      case "ack": {
        if (typeof m.command_id === "string" && typeof m.ok === "boolean") {
          const ack: AckMessage = {
            type: "ack",
            command_id: m.command_id,
            ok: m.ok,
            detail: typeof m.detail === "string" ? m.detail : "",
            setpoint_c: typeof m.setpoint_c === "number" ? m.setpoint_c : null,
          };
          settleCommand(ack.command_id, ack);
        }
        break;
      }
      case "pong": {
        isAlive = true;
        break;
      }
      default:
        // Unknown message types are ignored (forward-compatible).
        break;
    }
  });

  const cleanup = () => {
    clearInterval(pingTimer);
    if (piSocket === ws) {
      piSocket = null;
      console.log("[hub] Pi disconnected");
    }
  };

  ws.on("close", cleanup);
  ws.on("error", (err) => {
    console.warn(`[hub] Pi socket error: ${(err as Error).message}`);
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal: string): void {
  console.log(`[hub] ${signal} received — shutting down`);
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
  }
  try {
    piSocket?.close(1001, "hub shutting down");
  } catch {
    /* ignore */
  }
  wss.close();
  server.close(() => process.exit(0));
  // Failsafe if close hangs.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
