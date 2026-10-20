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
import { createDropoutTracker } from "./dropouts";
import { breakerAckTimeoutMs, bridgeSupportsBreaker, parseGraceMs, validateBreakerBody } from "./breaker";

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

// Env-overridable (like WATCHDOG_INTERVAL_MS) so the link e2e test can exercise the missed-pong
// path in seconds instead of a minute. Production never sets it. Validated: a malformed value
// ("", "abc", 0, 1e12) would otherwise become Node's 1 ms minimum and reap a healthy Pi every
// tick (Codex, PR #178) — anything not a finite number in [100 ms, 2^31-1] is the default.
const PI_PING_INTERVAL_MS = (() => {
  const raw = process.env.PI_PING_INTERVAL_MS;
  if (raw === undefined) return 30_000; // ping the Pi every ~30s
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 100 && n <= 2_147_483_647) return n;
  console.warn(`[hub] PI_PING_INTERVAL_MS=${JSON.stringify(raw)} is not a sane interval — using 30000`);
  return 30_000;
})();
const COMMAND_ACK_TIMEOUT_MS = 10_000; // await matching ack up to 10s
// Breaker actions answer after the panel read-back (and a power cycle after its >= 60 s hold),
// so they get off_s + this grace. Env-overridable only so the e2e test can time out quickly.
const BREAKER_ACK_GRACE_MS = parseGraceMs(process.env.BREAKER_ACK_GRACE_MS);

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

/** Flatten a fetch error to its real network story: unwrap undici's .cause and expand
 *  AggregateError (happy-eyeballs) into per-attempt `CODE addr:port` entries. */
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

// ── 6bb push (owner 2026-10-19) ─────────────────────────────────────────────────────────────────────────────
// ntfy had no subscriber (the owner never installed it — 2026-08-23: "emails are plenty"), so no A2W push ever
// reached a phone. PAGE-tier alerts and their all-clears go to the 6bb app's token-protected /api/external/alert,
// which pushes to the owner's devices. No-op unless both vars are set.
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

/** Fire-and-forget ntfy push. No-op when NTFY_TOPIC is unset; never throws.
 *  Retries over ~15s: #66 diagnosis showed Railway→ntfy.sh connectivity is INTERMITTENT —
 *  connect-level AggregateError on one boot, HTTP 200 minutes later — and dead-man pushes
 *  are rare and load-bearing, so a transient no-route must not eat one. A non-2xx HTTP
 *  response is NOT retried (the server answered; hammering a 429 makes it worse). */
async function notifyNtfy(title: string, message: string,
                          opts: { priority?: string; tags?: string } = {}): Promise<void> {
  if (!NTFY_TOPIC) return;
  // HTTP headers are ByteStrings (Latin-1) — strip anything above U+00FF so a stray emoji in
  // a title can never throw and silently kill the alert. Emoji belong in `tags`, which ntfy
  // renders (e.g. warning -> ⚠️); the message body (below) is UTF-8 and takes emoji fine.
  const headers: Record<string, string> = { Title: title.replace(/[^\x00-\xFF]/g, "").trim() };
  if (opts.priority) headers.Priority = opts.priority;
  if (opts.tags) headers.Tags = opts.tags;
  const delays = [0, 3_000, 12_000];
  for (let attempt = 1; attempt <= delays.length; attempt++) {
    if (delays[attempt - 1]) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    try {
      const res = await fetch(`${NTFY_SERVER.replace(/\/+$/, "")}/${NTFY_TOPIC}`, {
        method: "POST", headers, body: message, signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.warn(`[hub] ntfy push rejected: HTTP ${res.status}`);
      else if (attempt > 1) console.log(`[hub] ntfy push delivered on attempt ${attempt}`);
      return;
    } catch (err) {
      console.warn(`[hub] ntfy push attempt ${attempt}/${delays.length} failed: `
        + `${describeFetchError(err)} (node ${process.version})`);
    }
  }
}

/**
 * Owner alert policy (knowledge/reference/alert-policy.md, 2026-10-20) — the same tiers as planner/src/alertpolicy.ts:
 *   page       6bb phone push + email   the house is at risk, or a human must act soon
 *   attention  email only               worth a look this week
 *   record     ntfy log only            everything else
 * An all-clear carries the tier of the alert it resolves; only a page gets one. Subjects lead with the tier, because
 * the 2026-08-20 bridge-offline email read like the job-alert mail from the same Resend sender and was never opened.
 */
type Tier = "page" | "attention" | "record";

function tierSubject(title: string, tier: Tier, resolved: boolean): string {
  const t = title.trim();
  const core = t.replace(/^\s*A2W\s*[:—-]\s*/i, "").replace(/^[⚠✅🚨\uFE0F\s]+/u, "").trim() || t;
  if (resolved) return `✅ A2W RESOLVED — ${core}`;
  if (tier === "page") return `🚨 A2W — ${core}`;
  if (tier === "attention") return `A2W needs a look — ${core}`;
  return /^a2w\b/i.test(t) ? t : `A2W — ${t}`;
}

/** Fire-and-forget email via Resend. No-op when RESEND_API_KEY/RESEND_TO unset; never throws. */
async function notifyEmail(subject: string, body: string): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_TO) return;
  try {
    await fetch(RESEND_API_URL, {
      method: "POST",
      // Explicit UA: Cloudflare fronts Resend and 403s blocklisted/bare client signatures
      // (the bridge's urllib failed silently for weeks on this — 2026-08-06 lesson).
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json",
                 "User-Agent": "a2w-hub/1.0" },
      body: JSON.stringify({ from: RESEND_FROM, to: [RESEND_TO], subject, text: body }),
    });
  } catch (err) {
    console.warn(`[hub] resend email failed: ${(err as Error).message}`);
  }
}

/** Every hub notification goes through here: ntfy always (the log), then the owner channels its tier earns. */
function alert(tier: Tier, title: string, body: string,
               opts: { resolved?: boolean; tag: string; priority?: string; ntfyTags?: string }): void {
  const resolved = !!opts.resolved;
  void notifyNtfy(title, body, { priority: opts.priority ?? (resolved ? "default" : "high"), tags: opts.ntfyTags });
  const push = tier === "page";
  const email = resolved ? tier === "page" : tier !== "record";
  console.log(`[hub] alert ${tier}${resolved ? " resolved" : ""}: ${title} (push ${push}, email ${email})`);
  // the tag is per incident, so the all-clear replaces its alert on the phone
  if (push) void sixbbPush("a2w-hub", title, body, resolved ? "default" : "high", opts.tag);
  if (email) void notifyEmail(tierSubject(title, tier, resolved), body);
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
  /** Additive (bridges with SPAN breaker control): what the bridge can do, and the allowlisted
   *  circuits' live relay state. Absent from older bridges — both stay optional. */
  capabilities?: string[];
  span?: unknown;
}

interface AckMessage {
  type: "ack";
  command_id: string;
  ok: boolean;
  detail: string;
  setpoint_c: number | null;
  /** Breaker acks carry the bridge's read-back outcome; relayed to the dashboard verbatim. */
  result?: Record<string, unknown> | null;
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

/** Pi-link dropout episodes (#166): in-memory, rolling 24 h / 7 d, reset on every hub boot.
 * Fed from the SAME two transitions that log "Pi connected" / "Pi disconnected" — a
 * replacement socket never reaches `disconnected()` because `cleanup` only fires it for the
 * socket that is still `piSocket`, and the tracker ignores repeats in either direction. */
const piDropouts = createDropoutTracker();

/** The ONE place the Pi link goes down. Idempotent: only the socket that is still `piSocket`
 * can take the link down, so the terminate path, a CLOSING socket noticed by the ping timer or
 * the replacement check, and the eventual `close` event count at most once between them. */
function markDisconnected(sock: WebSocket): void {
  if (piSocket !== sock) return;
  piSocket = null;
  piDropouts.disconnected();
  console.log("[hub] Pi disconnected");
}

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

/** GET /health — OPEN (no auth).
 * The first three fields are a contract: scripts/deploy-gate.sh probe() and
 * scripts/drift-check.sh parse `ok`, `pi_connected`, `last_state_ts` — keep them first and
 * unchanged. The dropout fields (#166) are additive; drift-check [6] skips while
 * `pi_dropouts_24h` is absent and asserts ≤ 1 once it appears. */
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    pi_connected: piSocket !== null && piSocket.readyState === WebSocket.OPEN,
    last_state_ts: lastState ? lastState.ts : null,
    ...piDropouts.snapshot(),
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
    span: lastState?.span ?? null,
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

/**
 * POST /api/breaker — body {circuit, action: "power_cycle"|"close"|"open", off_s?, source?} (owner decision
 * 2026-10-18: remote SPAN breaker control through the panel's LOCAL API, because the SPAN app's
 * cloud path cannot switch circuits here). Gated exactly like /api/write-enable: the client
 * bearer AND X-Arm-Token (HUB_ARM_TOKEN), which the dashboard releases only after a fresh
 * password re-entry. The bridge applies every safety rule and answers with the panel READ-BACK;
 * this route waits off_s + grace for it (a power cycle holds >= 60 s before it can answer).
 *   200 {ok:true, detail, result}   verified outcome
 *   502 {ok:false, detail, result}  refused by a bridge guard, or switched but not verified
 *   501                             the connected bridge predates breaker control
 *   503 no Pi / arming not configured · 504 no ack in time (the action may still complete:
 *                                    the dashboard reads the live relay state from /api/state)
 */
app.post("/api/breaker", requireClientAuth, (req: Request, res: Response) => {
  const armToken = process.env.HUB_ARM_TOKEN ?? "";
  if (!armToken) {
    res.status(503).json({ ok: false, detail: "arming not configured (HUB_ARM_TOKEN unset)" });
    return;
  }
  if (!constantTimeEqual(String(req.header("x-arm-token") ?? ""), armToken)) {
    res.status(401).json({ ok: false, detail: "bad arm token" });
    return;
  }
  const v = validateBreakerBody(req.body);
  if (!v.ok) {
    res.status(400).json({ ok: false, detail: v.detail });
    return;
  }
  const sock = piSocket;
  if (!sock || sock.readyState !== WebSocket.OPEN) {
    res.status(503).json({ ok: false, detail: "no Pi connected" });
    return;
  }
  if (!bridgeSupportsBreaker(lastState)) {
    res.status(501).json({
      ok: false,
      detail: "the connected bridge does not support breaker control yet (or SPAN local is not "
        + "configured on it) — deploy the bridge release first",
    });
    return;
  }
  const cmd = v.cmd;
  const commandId = randomUUID();
  const timer = setTimeout(() => {
    if (pending.delete(commandId)) {
      res.status(504).json({
        ok: false,
        detail: "no answer from the bridge in time — the action may still complete; check the "
          + "live relay state before trying again",
      });
    }
  }, breakerAckTimeoutMs(cmd, BREAKER_ACK_GRACE_MS));
  pending.set(commandId, {
    timer,
    resolve: (ack: AckMessage) => {
      res.status(ack.ok ? 200 : 502).json({ ok: ack.ok, detail: ack.detail, result: ack.result ?? null });
    },
  });
  console.log(`[hub] breaker ${cmd.op} '${cmd.circuit}' relayed (command ${commandId})`);
  try {
    sock.send(JSON.stringify({
      type: "command" as const,
      command_id: commandId,
      action: "breaker" as const,
      circuit: cmd.circuit,
      op: cmd.op,
      off_s: cmd.off_s,
      source: cmd.source,
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
  // ntfy channel self-test on every boot (kanban #66: the dead-man's ntfy leg failed in
  // the 2026-08-06 drill with its cause swallowed; the email leg delivered). "min"
  // priority = silent app-list breadcrumb, record tier — it never reaches the owner's phone
  // or inbox; its presence after each deploy is the channel's health record.
  void notifyNtfy("A2W hub online", `hub started (node ${process.version}) — ntfy self-test`,
                  { priority: "min", tags: "white_check_mark" });
  // Comparative boot probe (#66): ntfy.sh unreachable while api.resend.com works from the
  // same container = host-specific blockage (e.g. ntfy.sh banning the shared egress IP),
  // not a Railway egress problem. GETs, no auth, logged either way.
  for (const url of ["https://ntfy.sh/v1/health", "https://api.resend.com"]) {
    void (async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        console.log(`[hub] boot probe ${url} -> HTTP ${r.status}`);
      } catch (err) {
        console.warn(`[hub] boot probe ${url} FAILED: ${describeFetchError(err)}`);
      }
    })();
  }
});

// Dead-man watchdog: record once when the Pi goes silent past the grace window, and once when
// it returns. Silence is measured from the last frame we heard (lastPiSeenAt), so a brief
// reconnect (WiFi blip / redeploy) inside the window never fires a false alarm.
// RECORD tier (alert-policy.md): the planner owns the one "Pi unreachable" page, at 2 h when it is freezing out and
// 12 h otherwise, because the HBX keeps heating without the Pi. If the planner is down too, its own dead-man below
// pages. This edge stays as the hub's log of every dropout (#166 dropouts.ts counts them for drift-check).
setInterval(() => {
  if (!everSeenPi) return;
  const silentMs = Date.now() - lastPiSeenAt;
  const silent = silentMs > PI_SILENCE_ALERT_MS;
  if (silent && !piSilenceAlerted) {
    piSilenceAlerted = true;
    const mins = Math.max(1, Math.round(silentMs / 60_000));
    // Title/Tags are HTTP headers → ASCII only; the `warning` tag renders as ⚠️ in ntfy.
    const title = "A2W: heat-pump bridge offline";
    const body = `The Pi hasn't checked in for ~${mins} min (power / WiFi / internet / bridge down). ` +
      "Heating still runs on the wall controllers + HBX; remote control is unavailable until it returns.";
    alert("record", title, body, { tag: "a2w-hub-pi-link", ntfyTags: "warning" });
  } else if (!silent && piSilenceAlerted) {
    piSilenceAlerted = false;
    alert("record", "A2W: heat-pump bridge back online", "The Pi is checking in with the hub again.",
          { resolved: true, tag: "a2w-hub-pi-link", ntfyTags: "white_check_mark" });
  }
}, WATCHDOG_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Planner dead-man — the gap that cost us four days
// ---------------------------------------------------------------------------
// On 2026-08-19 Neon's compute quota ran out, the planner crash-looped into a terminal
// Railway CRASHED state, and nobody found out until 2026-08-23. The Pi dead-man above
// worked perfectly the whole time — but nothing watched the PLANNER, and the planner is
// where its own monitors lived, so its death took the alarm with it.
//
// The hub is the right place for this: it stayed up throughout, it already owns the
// ntfy + email channels, and it has no dependency on Postgres, so a database outage
// cannot silence it. Deliberately the same shape as the Pi watchdog — a grace window
// measured from the last healthy observation, and alerts only on transitions.
//
// "Healthy" is more than HTTP 200: a planner that answers but has stopped polling is
// still not doing its job, so a stale lastPollAt counts as down.
const PLANNER_HEALTH_URL =
  process.env.PLANNER_HEALTH_URL ?? "https://a2w-planner-production.up.railway.app/health";
// 2 h (was 15 min): with the planner down the HBX and the wall controllers keep heating; what stops is optimization and
// monitoring. A redeploy or a short crash loop recovers well inside this (alert-policy.md).
const PLANNER_ALERT_AFTER_MS = Number(process.env.PLANNER_ALERT_AFTER_MS ?? 7_200_000);
const PLANNER_POLL_STALE_MS = Number(process.env.PLANNER_POLL_STALE_MS ?? 1_200_000); // 20 min = 4 missed polls
const PLANNER_WATCHDOG_INTERVAL_MS = Number(process.env.PLANNER_WATCHDOG_INTERVAL_MS ?? 60_000);

// Start the grace window at boot so a hub restart during a planner deploy stays quiet.
let lastPlannerOkAt = Date.now();
let plannerAlerted = false;
let lastPlannerDetail = "";

async function checkPlannerHealth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetch(PLANNER_HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
    const h = (await r.json()) as { ok?: boolean; lastPollAt?: string | null };
    if (h.ok === false) return { ok: false, detail: "reports ok:false" };
    if (!h.lastPollAt) return { ok: false, detail: "no lastPollAt" };
    const age = Date.now() - new Date(h.lastPollAt).getTime();
    if (age > PLANNER_POLL_STALE_MS) {
      return { ok: false, detail: `answering but last poll was ${Math.round(age / 60_000)} min ago` };
    }
    return { ok: true, detail: "ok" };
  } catch (err) {
    return { ok: false, detail: describeFetchError(err) };
  }
}

if (!PLANNER_HEALTH_URL) {
  console.warn("[hub] PLANNER_HEALTH_URL empty — planner dead-man alerts are disabled.");
}

setInterval(() => {
  // NOT gated on NTFY_TOPIC: the owner's channels are 6bb + email, and a dead-man must not go quiet with the log
  if (!PLANNER_HEALTH_URL) return;
  void checkPlannerHealth().then(({ ok, detail }) => {
    if (ok) lastPlannerOkAt = Date.now();
    else lastPlannerDetail = detail;

    const downMs = Date.now() - lastPlannerOkAt;
    const down = downMs > PLANNER_ALERT_AFTER_MS;

    if (down && !plannerAlerted) {
      plannerAlerted = true;
      const mins = Math.max(1, Math.round(downMs / 60_000));
      // Title/Tags are HTTP headers → ASCII only.
      const title = "A2W: planner DOWN - no optimization or monitoring";
      const body =
        `The planner has been unhealthy for ~${mins} min (${lastPlannerDetail}). ` +
        "While it is down there is no autopilot, no Phase B, no hygiene soak scheduling, " +
        "and no SPAN backup-element alarm. Heating still runs on the wall controllers + HBX. " +
        "Check: https://a2w-planner-production.up.railway.app/health";
      alert("page", title, body, { tag: "a2w-hub-planner-down", ntfyTags: "rotating_light" });
    } else if (!down && plannerAlerted) {
      plannerAlerted = false;
      alert("page", "A2W: planner back online", "The planner is healthy and polling again.",
            { resolved: true, tag: "a2w-hub-planner-down", ntfyTags: "white_check_mark" });
    }
  });
}, PLANNER_WATCHDOG_INTERVAL_MS);

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
    const old = piSocket;
    // #166: replacing a LIVE socket is not a dropout. But a socket already CLOSING/CLOSED (the
    // Pi sent its close frame; ws can hold the TCP teardown up to 30 s before emitting `close`)
    // is a dropout /health has been reporting (pi_connected:false) that the tracker has not
    // registered yet — and once this socket takes over, the old one's late `close` would be
    // ignored. Register it now so this connect closes it as a short episode (Codex, PR #178).
    if (old.readyState !== WebSocket.OPEN) markDisconnected(old);
    try {
      old.close(4000, "replaced by new Pi connection");
    } catch {
      /* ignore */
    }
  }
  piSocket = ws;
  lastPiSeenAt = Date.now();
  everSeenPi = true;
  console.log("[hub] Pi connected");
  // #166: if this connect ends a dropout, say how long it was — on one line, so a 3 h outage
  // no longer has to be reconstructed by diffing two timestamps two hours apart.
  const ended = piDropouts.connected();
  if (ended) {
    console.log(`[hub] Pi reconnected after ${ended.minutes} min (disconnected at ${ended.start})`);
  }

  // Liveness: mark alive on pong; drop on a missed ping->pong round.
  let isAlive = true;
  ws.on("pong", () => {
    isAlive = true;
    lastPiSeenAt = Date.now();
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      // CLOSING/CLOSED with no `close` event yet: /health already says pi_connected:false,
      // so the tracker must agree (idempotent; the eventual `close` is then a no-op).
      markDisconnected(ws);
      return;
    }
    if (!isAlive) {
      console.warn("[hub] Pi missed pong — terminating");
      // #166: from the hub's point of view the link is dead NOW, so the dropout starts here,
      // not when the destroyed socket's `close` event lands a tick later. That also closes a
      // race (Codex, PR #178): a replacement Pi connection arriving before that `close` would
      // make `cleanup` skip (piSocket !== ws) and the episode would never open. markDisconnected
      // is idempotent, so the terminate path still counts exactly once.
      markDisconnected(ws);
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
          lastState = {
            type: "state", ts: m.ts, pumps: m.pumps as PumpState[],
            capabilities: Array.isArray(m.capabilities)
              ? m.capabilities.filter((c): c is string => typeof c === "string") : undefined,
            span: m.span ?? undefined,
          };
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
            result: typeof m.result === "object" && m.result !== null && !Array.isArray(m.result)
              ? (m.result as Record<string, unknown>) : null,
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
    markDisconnected(ws);
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
