/**
 * @purpose The DYNAMIC gate for the 16.5 kW backup element's SPAN breaker ("Buffer Tank"), owner rule 2026-10-19:
 * "Sometimes it's OK if the heat pumps are keeping up and there's just a massive load (and the tank isn't completely
 * freezing), but if a heat pump has failed or just totally cannot keep up, THEN we'd want it to kick on."
 *
 * The breaker is OPEN by default, and with HBX lagT 60 it is the ONLY thing keeping the element out of ordinary shower
 * sags (the HBX calls the backup together with the lag stage, ~60 min into a sustained call). CLOSING it only makes the
 * element available — the HBX still decides when it fires. The gate closes it when either:
 *   (a) failed_not_recovering — a pump has FAILED (offline in a live frame, the bridge's `fault` state, or its stage's
 *       stage_unserved / fault_called episode open) AND the HBX is calling AND the tank is ≥ DEFICIT_F below target AND
 *       not rising (< RISE_F over the last RISE_WINDOW), continuously for FAIL_HOLD (90 min: longer than lagT 60 + the
 *       lag pump's first visible lift, so the remaining unit always gets its chance first);
 *   (b) floor — the HBX is calling, every AVAILABLE pump is engaged (heating / defrost; vacuously true when none is
 *       available), and the tank is below FLOOR_F and not rising, continuously for FLOOR_HOLD ("totally cannot keep up").
 * and re-opens it (the `recovered` rule) once tank ≥ target − OPEN_MARGIN_F (or the HBX is satisfied: no stage called)
 * AND every pump is healthy, continuously for OPEN_HOLD — only a breaker the GATE closed, never sooner than MIN_DWELL
 * after its last action. Thresholds are MEASURED: knowledge/reference/backup-gate-thresholds.md.
 *
 * Clocks follow stagewatch.ts: time is credited only between two consecutive qualifying observations ≤ MAX_STEP apart;
 * a non-qualifying observation resets the clock; a BLIND observation (hub/Pi state unverifiable, SensorLinx field
 * missing, no tank sample RISE_WINDOW ago) neither credits nor resets. A RISE (≥ RISE_F over RISE_WINDOW) PAUSES the
 * clock rather than resetting it: in a real failure the surviving pump's defrost sawtooth (dip, recover, dip) must not
 * restart the 90 min every cycle, while a genuine recovery ends the call or closes the deficit — and that resets it.
 *
 * Pure (no I/O). index.ts feeds it every SensorLinx poll and executes what it decides: SHADOW (default) pages "would
 * close / would open" and switches nothing — the gate's state is then VIRTUAL; LIVE sends the close through the hub to
 * the Pi's guarded BreakerController and reports back with applied(). Re-opening a live breaker additionally needs
 * BACKUP_GATE_REOPEN=1 here AND span.backup_reopen on the Pi — both default OFF, owner OK required.
 */

export const BG = {
  DEFICIT_F: 10,
  RISE_F: 3,
  RISE_WINDOW_MS: 20 * 60_000,
  FAIL_HOLD_MS: 90 * 60_000,
  FLOOR_F: 100,
  FLOOR_HOLD_MS: 30 * 60_000,
  OPEN_MARGIN_F: 5,
  OPEN_HOLD_MS: 60 * 60_000,
  MIN_DWELL_MS: 120 * 60_000,
  /** a gap between observations longer than this credits nothing (5-min poll + jitter, as stagewatch) */
  MAX_STEP_MS: 7.5 * 60_000,
  /** live: a breaker someone else OPENED after the gate closed it is left alone this long */
  OVERRIDE_MS: 12 * 3600_000,
  /** live: a failed hub command is retried no sooner than this */
  RETRY_MS: 15 * 60_000,
} as const;

/** The knobs the owner sets (env, see parseGateConfig). Everything else is a constant above. */
export interface GateThresholds {
  floorF: number;
  floorHoldMs: number;
  deficitF: number;
  failHoldMs: number;
}
export const DEFAULT_THRESHOLDS: GateThresholds = {
  floorF: BG.FLOOR_F, floorHoldMs: BG.FLOOR_HOLD_MS, deficitF: BG.DEFICIT_F, failHoldMs: BG.FAIL_HOLD_MS,
};
export type GateMode = "off" | "shadow" | "live";

/**
 * BACKUP_GATE (off | shadow | live; default shadow), BACKUP_GATE_REOPEN (1 = a live gate may re-open; default off),
 * BACKUP_GATE_FLOOR_F (90–115, default 100), BACKUP_GATE_FLOOR_MIN (10–120, default 30), BACKUP_GATE_DEFICIT_F (4–20,
 * default 10), BACKUP_GATE_FAIL_HOLD_MIN (60–240, default 90). An invalid value falls back to its default, with the reason.
 * The floor may not go below 90 °F: that is the HBX's own bkTemp floor, where it fires the element itself.
 */
export function parseGateConfig(env: Record<string, string | undefined>): { mode: GateMode; reopen: boolean; t: GateThresholds; errors: string[] } {
  const errors: string[] = [];
  const raw = (env.BACKUP_GATE ?? "").trim().toLowerCase();
  let mode: GateMode = "shadow";
  if (raw === "off" || raw === "0") mode = "off";
  else if (raw === "live") mode = "live";
  else if (raw !== "" && raw !== "shadow") errors.push(`BACKUP_GATE=${JSON.stringify(env.BACKUP_GATE)} ignored — shadow`);
  const num = (key: string, dflt: number, lo: number, hi: number): number => {
    const v = env[key];
    if (v == null || v.trim() === "") return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) { errors.push(`${key}=${JSON.stringify(v)} ignored (must be ${lo}–${hi}) — ${dflt}`); return dflt; }
    return n;
  };
  const t: GateThresholds = {
    floorF: num("BACKUP_GATE_FLOOR_F", BG.FLOOR_F, 90, 115),
    floorHoldMs: num("BACKUP_GATE_FLOOR_MIN", BG.FLOOR_HOLD_MS / 60_000, 10, 120) * 60_000,
    deficitF: num("BACKUP_GATE_DEFICIT_F", BG.DEFICIT_F, 4, 20),
    failHoldMs: num("BACKUP_GATE_FAIL_HOLD_MIN", BG.FAIL_HOLD_MS / 60_000, 60, 240) * 60_000,
  };
  return { mode, reopen: env.BACKUP_GATE_REOPEN === "1", t, errors };
}

export interface GatePump {
  id: string;
  name?: string | null;
  online: boolean;
  /** the bridge's derived state: heating | idle | off | defrost | fault | cooling | offline */
  state?: string | null;
  /** stagewatch has stage_unserved or fault_called open for the stage wired to this pump */
  stageEpisode?: boolean;
}

export interface GateInput {
  nowMs: number;
  tankF: number | null;
  tankTargetF: number | null;
  /** the HBX stage relays (index 0 = stage 1), null when unknown */
  stagesCalled: boolean[] | null;
  /** live pump states, or null when they cannot stand in for the pumps (hub unreachable, Pi disconnected, stale) */
  pumps: GatePump[] | null;
  /** the REAL Buffer Tank relay from the Pi's SPAN snapshot, null when unknown */
  relay?: "OPEN" | "CLOSED" | null;
}

export type GateRule = "failed_not_recovering" | "floor" | "recovered";
export interface GateEvent {
  /** close / open = act (shadow: "would"; live: index.ts pages it only after the Pi verified the switch); reopen_blocked = live, re-open wanted but disabled; override = live, a human
   *  opened the breaker the gate closed — the gate stands down for OVERRIDE_MS */
  kind: "close" | "open" | "reopen_blocked" | "override" | "confirmed";
  /** kind "confirmed": a live command whose answer was lost (hub timeout) is now seen done on the relay */
  confirms?: "close" | "open";
  rule: GateRule | null;
  title: string;
  body: string;
  priority: "high" | "default";
}

interface Clock { ms: number; last: number | null }
const clock = (): Clock => ({ ms: 0, last: null });
/** stagewatch's crediting: null = blind (no credit, no reset), false = reset, true = credit the gap since the last true */
function tickClock(c: Clock, q: boolean | null, now: number): void {
  if (q === null) { c.last = null; return; }
  if (!q) { c.ms = 0; c.last = null; return; }
  if (c.last != null) { const gap = now - c.last; if (gap >= 0 && gap <= BG.MAX_STEP_MS) c.ms += gap; }
  c.last = now;
}

const label = (p: GatePump) => p.name?.trim() || p.id;
export const failedReason = (p: GatePump): string | null =>
  !p.online ? "offline" : p.state === "fault" ? "fault" : p.stageEpisode ? "called but not heating (stage episode open)" : null;
const engaged = (p: GatePump) => p.online && (p.state === "heating" || p.state === "defrost");
const r1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);

/** What one observation says — also /health's `conditions`. null fields = unknown. */
export interface GateConditions {
  called: boolean | null;
  tank_f: number | null;
  target_f: number | null;
  deficit_f: number | null;
  rise_f: number | null;
  /** rose ≥ RISE_F over RISE_WINDOW: the close clocks are PAUSED (not reset) */
  rising: boolean | null;
  failed: { id: string; why: string }[] | null;
  available: string[] | null;
  all_available_engaged: boolean | null;
  failed_not_recovering: boolean | null;
  floor: boolean | null;
  recovered: boolean | null;
}

export class BackupGate {
  private state: "open" | "closed" = "open";
  private byGate = false;
  private lastActionMs: number | null = null;
  private overrideUntilMs: number | null = null;
  private pending: { kind: "close" | "open"; rule: GateRule; atMs: number } | null = null;
  private retryAtMs: number | null = null;
  /** live: a refused command (a bridge guard said no) is not retried until its condition ends */
  private standDown: "close" | "open" | null = null;
  /** live: one failure page per episode */
  private failPaged = false;
  /** live: a command with no definite answer (timeout): it may still land — the relay read decides */
  private unconfirmed: { kind: "close" | "open"; atMs: number } | null = null;
  private reopenBlockedPaged = false;
  private readonly failC = clock();
  private readonly floorC = clock();
  private readonly openC = clock();
  private hist: { ms: number; f: number }[] = [];
  private last: GateConditions | null = null;
  private lastEvent: { at: string; kind: string; rule: GateRule | null; title: string } | null = null;
  private lastRelay: "OPEN" | "CLOSED" | null = null;

  constructor(
    readonly mode: GateMode = "shadow",
    readonly reopen = false,
    readonly t: GateThresholds = DEFAULT_THRESHOLDS,
  ) {}

  /** Re-adopt the gate's last transition after a restart (alert_episodes row open = it closed the breaker). The dwell
   *  restarts from `atMs` — conservative: a restart can only delay the next action, never hurry it. */
  restore(r: { closedByGate: boolean; atMs: number }): void {
    if (!r.closedByGate) return;
    this.state = "closed"; this.byGate = true; this.lastActionMs = r.atMs;
  }

  private riseOver(now: number): number | null {
    const want = now - BG.RISE_WINDOW_MS;
    let best: { ms: number; f: number } | null = null;
    for (const h of this.hist) {
      if (h.ms > now - BG.RISE_WINDOW_MS / 2) continue;            // at least 10 min back
      if (Math.abs(h.ms - want) > BG.MAX_STEP_MS) continue;          // and within 7.5 min of 20 min back
      if (!best || Math.abs(h.ms - want) < Math.abs(best.ms - want)) best = h;
    }
    const cur = this.hist[this.hist.length - 1];
    return best && cur && cur.ms === now ? cur.f - best.f : null;
  }

  /** Evaluate one observation (no state change). */
  conditions(i: GateInput): GateConditions {
    const called = i.stagesCalled == null ? null : i.stagesCalled.some(Boolean);
    const tank = i.tankF, tgt = i.tankTargetF;
    const deficit = tank != null && tgt != null ? tgt - tank : null;
    const rise = this.riseOver(i.nowMs);
    const failed = i.pumps ? i.pumps.map((p) => ({ id: p.id, why: failedReason(p) })).filter((x): x is { id: string; why: string } => x.why != null) : null;
    const avail = i.pumps ? i.pumps.filter((p) => failedReason(p) == null) : null;
    const allEngaged = avail ? avail.every(engaged) : null;
    // each rule is true (credit), false when a known input rules it out (reset), null when an input it needs is unknown
    // OR the tank is rising (pause — see the header)
    const rising = rise == null ? null : rise >= BG.RISE_F;
    const a = called === false ? false
      : called == null || failed == null ? null
      : !failed.length ? false
      : deficit == null ? null
      : deficit < this.t.deficitF ? false
      : rising == null || rising ? null
      : true;
    // "still below": a tank climbing back out of a deep hole (Oct 16 01:00, 77 → 97 °F in 35 min) is being kept up with
    const b = called === false ? false
      : called == null || tank == null || allEngaged == null ? null
      : !(tank < this.t.floorF && allEngaged) ? false
      : rising == null || rising ? null
      : true;
    const healthy = i.pumps == null ? null : i.pumps.length > 0 && i.pumps.every((p) => failedReason(p) == null);
    const satisfied = called === false ? true
      : called == null || tank == null || tgt == null ? null
      : tank >= tgt - BG.OPEN_MARGIN_F;
    const rec = healthy === false || satisfied === false ? false : healthy == null || satisfied == null ? null : true;
    return {
      called, tank_f: r1(tank), target_f: r1(tgt), deficit_f: r1(deficit), rise_f: r1(rise), rising,
      failed, available: avail ? avail.map((p) => p.id) : null, all_available_engaged: allEngaged,
      failed_not_recovering: a, floor: b, recovered: rec,
    };
  }

  step(i: GateInput): GateEvent[] {
    const now = i.nowMs;
    if (i.tankF != null) {
      this.hist.push({ ms: now, f: i.tankF });
      this.hist = this.hist.filter((h) => h.ms >= now - 2 * BG.RISE_WINDOW_MS);
    }
    const c = this.conditions(i);
    this.last = c;
    const out: GateEvent[] = [];
    const pumps = i.pumps ?? [];

    // LIVE: a command whose answer was lost and that the relay now shows done is the gate's own action
    if (this.mode === "live" && i.relay && !this.pending && this.unconfirmed) {
      const u = this.unconfirmed;
      if (now - u.atMs > 2 * BG.RETRY_MS) this.unconfirmed = null;
      else if ((u.kind === "close" && i.relay === "CLOSED" && this.state === "open")
        || (u.kind === "open" && i.relay === "OPEN" && this.state === "closed")) {
        this.unconfirmed = null;
        this.transition(u.atMs, u.kind);
        this.retryAtMs = null;
        out.push(this.ev(now, {
          kind: "confirmed", confirms: u.kind, rule: null, priority: "default",
          title: u.kind === "close" ? "A2W closed the backup element breaker (confirmed late)" : "A2W re-opened the backup element breaker (confirmed late)",
          body: `The hub did not answer in time, but the Buffer Tank breaker now reads ${i.relay} — A2W's ${u.kind} landed.`,
        }));
      }
    }
    // LIVE: the real relay is the truth. A breaker someone else switched is never fought.
    if (this.mode === "live" && i.relay && !this.pending) {
      if (i.relay === "CLOSED" && this.state === "open") { this.state = "closed"; this.byGate = false; } // owner / arm
      else if (i.relay === "OPEN" && this.state === "closed") {
        const wasGate = this.byGate;
        this.state = "open"; this.byGate = false;
        if (wasGate) {
          this.overrideUntilMs = now + BG.OVERRIDE_MS;
          out.push(this.ev(now, {
            kind: "override", rule: null, priority: "default",
            title: "Backup element breaker switched OFF by hand — A2W stands down",
            body: `The Buffer Tank breaker A2W closed now reads OPEN. A2W will not close it again for ${BG.OVERRIDE_MS / 3600_000} h ` +
              "(it never fights a human). The HBX cannot fire the element while it is off.",
          }));
        }
      }
    }
    if (i.relay) this.lastRelay = i.relay;

    tickClock(this.failC, c.failed_not_recovering, now);
    tickClock(this.floorC, c.floor, now);
    tickClock(this.openC, this.state === "closed" ? c.recovered : false, now);

    // an episode ends when its clock is back at zero: a stand-down and its one failure page end with it
    if (this.state === "open" && this.failC.ms === 0 && this.floorC.ms === 0 && this.failC.last == null && this.floorC.last == null) {
      if (this.standDown === "close") this.standDown = null;
      this.failPaged = false;
    }
    if (this.state === "closed" && this.openC.ms === 0 && this.openC.last == null) {
      if (this.standDown === "open") this.standDown = null;
      this.failPaged = false;
    }
    if (this.pending) return out; // live: a command is in flight — applied() resolves it
    if (this.retryAtMs != null && now < this.retryAtMs) return out;
    const dwellOk = this.lastActionMs == null || now - this.lastActionMs >= BG.MIN_DWELL_MS;
    const ctx = this.context(i, c);

    if (this.state === "open") {
      if (!dwellOk || this.standDown === "close" || (this.overrideUntilMs != null && now < this.overrideUntilMs)) return out;
      let rule: GateRule | null = null;
      if (this.failC.ms >= this.t.failHoldMs) rule = "failed_not_recovering";
      else if (this.floorC.ms >= this.t.floorHoldMs) rule = "floor";
      if (!rule) return out;
      const why = rule === "floor"
        ? `the tank has been below the ${this.t.floorF} °F floor for ${Math.round(this.floorC.ms / 60_000)} min while the HBX calls and ` +
          `${c.available?.length ? `every available pump (${c.available.join(", ")}) is running` : "no pump is available"} — the heat pumps cannot keep up.`
        : `${(c.failed ?? []).map((f) => `${label(pumps.find((p) => p.id === f.id) ?? { id: f.id, online: false })} is ${f.why}`).join("; ")}, ` +
          `and for ${Math.round(this.failC.ms / 60_000)} min the tank has sat ≥ ${this.t.deficitF} °F below target without recovering while the HBX calls.`;
      out.push(this.act(now, "close", rule, why, ctx));
    } else if (this.byGate && this.openC.ms >= BG.OPEN_HOLD_MS && dwellOk && this.standDown !== "open") {
      const why = `every pump has been healthy and the tank back within ${BG.OPEN_MARGIN_F} °F of target (or the HBX satisfied) for ` +
        `${Math.round(this.openC.ms / 60_000)} min.`;
      if (this.mode === "live" && !this.reopen) {
        if (!this.reopenBlockedPaged) {
          this.reopenBlockedPaged = true;
          out.push(this.ev(now, {
            kind: "reopen_blocked", rule: "recovered", priority: "default",
            title: "Backup element: recovered — breaker left ON (re-open disabled)",
            body: `${why} A2W would switch the Buffer Tank breaker back OFF now, but re-opening is disabled ` +
              "(BACKUP_GATE_REOPEN / span.backup_reopen, owner OK required). Switch it off yourself if you want the element " +
              `out of normal heavy loads again. ${ctx}`,
          }));
        }
      } else {
        out.push(this.act(now, "open", "recovered", why, ctx));
      }
    }
    if (this.state === "closed" && this.openC.ms === 0) this.reopenBlockedPaged = false;
    return out;
  }

  private context(i: GateInput, c: GateConditions): string {
    const ps = (i.pumps ?? []).map((p) => `${label(p)} ${p.online ? p.state ?? "?" : "offline"}${p.stageEpisode ? " (stage episode open)" : ""}`).join(", ");
    return `Tank ${c.tank_f ?? "?"} °F / target ${c.target_f ?? "?"} °F, rise ${c.rise_f ?? "?"} °F over 20 min, ` +
      `HBX ${c.called ? "calling" : c.called === false ? "not calling" : "call unknown"}; pumps: ${ps || "unknown"}; ` +
      `breaker ${this.lastRelay ?? "unknown"}.`;
  }

  private act(now: number, kind: "close" | "open", rule: GateRule, why: string, ctx: string): GateEvent {
    const shadow = this.mode !== "live";
    const e: GateEvent = kind === "close"
      ? {
          // shadow is never a phone push (#211 pushes high/urgent): default priority, one email per episode (index.ts)
          kind, rule, priority: shadow ? "default" : "high",
          title: shadow ? "Backup element gate (shadow): WOULD close the breaker" : "A2W closed the backup element breaker",
          body: `${shadow ? "SHADOW — nothing was switched. " : ""}Rule ${rule}: ${why} ` +
            `${shadow ? "Live, A2W would close" : "A2W closed (relay read-back verified)"} the Buffer Tank breaker so the HBX can fire the 16.5 kW element on its own backup call. ${ctx}`,
        }
      : {
          kind, rule, priority: "default",
          title: shadow ? "Backup element gate (shadow): WOULD re-open the breaker" : "A2W re-opened the backup element breaker",
          body: `${shadow ? "SHADOW — nothing was switched. " : ""}Rule ${rule}: ${why} ` +
            `${shadow ? "Live (with re-open enabled), A2W would switch" : "A2W switched (relay read-back verified)"} the Buffer Tank breaker back OFF. ${ctx}`,
        };
    if (shadow) this.transition(now, kind);
    else this.pending = { kind, rule, atMs: now };
    return this.ev(now, e);
  }

  /**
   * LIVE: the hub/Pi answer for the pending command. ok = the Pi verified the relay read-back. refused = a guard said no
   * (nothing was switched; retrying cannot help): the gate stands down until the condition ends. Otherwise (no Pi,
   * timeout) it retries after RETRY_MS and, should the command land late, the relay read confirms it. Returns whether
   * to page the failure — once per episode.
   */
  applied(ok: boolean, nowMs: number, refused = false): { page: boolean } {
    const p = this.pending;
    if (!p) return { page: false };
    this.pending = null;
    if (ok) { this.transition(nowMs, p.kind); this.retryAtMs = null; this.unconfirmed = null; return { page: false }; }
    if (refused) { this.standDown = p.kind; this.unconfirmed = null; }
    else { this.retryAtMs = nowMs + BG.RETRY_MS; this.unconfirmed = { kind: p.kind, atMs: nowMs }; }
    const page = !this.failPaged;
    this.failPaged = true;
    return { page };
  }

  private transition(now: number, kind: "close" | "open"): void {
    this.state = kind === "close" ? "closed" : "open";
    this.byGate = kind === "close";
    this.lastActionMs = now;
    this.failC.ms = 0; this.floorC.ms = 0; this.openC.ms = 0;
    this.failC.last = this.floorC.last = this.openC.last = null;
    this.reopenBlockedPaged = false;
    this.standDown = null;
    this.failPaged = false;
  }

  private ev(now: number, e: GateEvent): GateEvent {
    this.lastEvent = { at: new Date(now).toISOString(), kind: e.kind, rule: e.rule, title: e.title };
    return e;
  }

  get breakerState(): "open" | "closed" { return this.state; }
  get closedByGate(): boolean { return this.byGate; }
  get pendingAction(): "close" | "open" | null { return this.pending?.kind ?? null; }

  status(nowMs: number): Record<string, unknown> {
    const min = (ms: number) => Math.round(ms / 6_000) / 10;
    return {
      mode: this.mode,
      reopen_enabled: this.reopen,
      thresholds: {
        deficit_f: this.t.deficitF, rise_f: BG.RISE_F, rise_window_min: BG.RISE_WINDOW_MS / 60_000, fail_hold_min: this.t.failHoldMs / 60_000,
        floor_f: this.t.floorF, floor_hold_min: this.t.floorHoldMs / 60_000,
        open_margin_f: BG.OPEN_MARGIN_F, open_hold_min: BG.OPEN_HOLD_MS / 60_000, min_dwell_min: BG.MIN_DWELL_MS / 60_000,
      },
      // in shadow this is the VIRTUAL breaker: what the gate would have done so far, not the panel
      gate_state: this.state,
      gate_state_virtual: this.mode !== "live",
      closed_by_gate: this.byGate,
      relay: this.lastRelay,
      pending: this.pending?.kind ?? null,
      last_action_at: this.lastActionMs == null ? null : new Date(this.lastActionMs).toISOString(),
      retry_at: this.retryAtMs != null && this.retryAtMs > nowMs ? new Date(this.retryAtMs).toISOString() : null,
      stand_down: this.standDown,
      unconfirmed: this.unconfirmed ? { kind: this.unconfirmed.kind, at: new Date(this.unconfirmed.atMs).toISOString() } : null,
      override_until: this.overrideUntilMs != null && this.overrideUntilMs > nowMs ? new Date(this.overrideUntilMs).toISOString() : null,
      clocks: {
        failed_not_recovering_min: min(this.failC.ms), floor_min: min(this.floorC.ms), recovered_min: min(this.openC.ms),
      },
      conditions: this.last,
      last_event: this.lastEvent,
    };
  }
}
