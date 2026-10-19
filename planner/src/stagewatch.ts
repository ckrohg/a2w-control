/**
 * @purpose #185 (incident 2026-10-16, P0): the per-stage unserved-call alarm. The existing all-idle check pages only
 * when NO pump is heating, so a one-unit failure while the other unit carries — or idles uncalled — is invisible: on
 * Oct 16 00:30–00:54 ET the HBX called stage 2 only, HP2 was FAULT (E21) and HP1 sat idle, because the HBX stages by
 * dry contact, does not know a unit is faulted, and with rotation ON waits lagT (180 min) before adding the lag stage.
 *
 * Two edges per stage, both persisted as episodes and paged HIGH (emails):
 *   stage_unserved — stage N called, its mapped pump not heating for STAGE_START_GRACE_MS of called time (the clock is
 *                    SUSPENDED while the pump defrosts, and never runs on unverifiable hub state);
 *   fault_called   — stage N called while its mapped pump reports an active fault: immediate.
 * Pure (no I/O): index.ts feeds it the poll's HBX stages, the hub's pump states (only when piStateUnverifiable says
 * they are live), fault codes from the mirror's pump_snapshots, and lagT from the HBX config.
 */

export const STAGE_START_GRACE_MS = 10 * 60 * 1000;
/**
 * A gap between steps longer than this credits no called time at all: the normal 5-min poll cadence plus jitter. A
 * skipped poll (10 min) may hide a heating or defrost spell, so it is never counted as unserved (codex pass 6).
 */
export const MAX_STEP_MS = 7.5 * 60 * 1000;
export const DEFAULT_STAGE_PUMP_MAP: Readonly<Record<string, string>> = { "1": "pump1", "2": "pump2" };

/**
 * STAGE_PUMP_MAP env → map of HBX stage number → hub pump id. It is the PHYSICAL stage-relay → heat-pump wiring
 * (planner/README.md says how to verify it at the panel). Invalid JSON or entries → the default, with the reason.
 */
export function parseStagePumpMap(raw: string | undefined): { map: Record<string, string>; error: string | null } {
  if (raw == null || raw.trim() === "") return { map: { ...DEFAULT_STAGE_PUMP_MAP }, error: null };
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    const out: Record<string, string> = {};
    for (const [k, id] of Object.entries(v as Record<string, unknown>)) {
      if (!/^[1-9]\d*$/.test(k) || typeof id !== "string" || !id.trim()) throw new Error(`bad entry ${JSON.stringify(k)}: ${JSON.stringify(id)}`);
      out[k] = id.trim();
    }
    // every physical stage 1..N must be mapped (N ≥ 2 — this plant has two units) to DISTINCT pumps: a partial map
    // silently leaves a stage unwatched, a duplicate makes one unit "serve" two stages (codex pass 2)
    const keys = Object.keys(out).map(Number).sort((a, b) => a - b);
    if (keys.length < 2) throw new Error("fewer than 2 stages mapped");
    if (keys.some((k, i) => k !== i + 1)) throw new Error(`stages must be 1..${keys.length} with no gaps`);
    if (new Set(Object.values(out)).size !== keys.length) throw new Error("two stages map to the same pump");
    return { map: out, error: null };
  } catch (e) {
    return { map: { ...DEFAULT_STAGE_PUMP_MAP }, error: `STAGE_PUMP_MAP ignored (${(e as Error).message}) — using the default` };
  }
}

export interface StagePump {
  id: string;
  name?: string | null;
  online: boolean;
  /** the bridge's derived state: heating | idle | off | defrost | fault | cooling | offline */
  state?: string | null;
  /** count of active faults (the hub's state frame) */
  active_faults?: number | null;
  /** codes from the mirror's pump_snapshots, when known */
  fault_codes?: string[];
}

export type StageEpisodeKind = "stage_unserved" | "fault_called";
export interface StageEvent {
  kind: "open" | "close";
  type: StageEpisodeKind;
  stage: string;
  pumpId: string;
  title: string;
  body: string;
  priority: "high" | "default";
}

interface StageState {
  calledMs: number;      // called-and-not-heating time accumulated (excluding defrost)
  /** the previous observation, when it was itself called-not-heating-not-defrost — only then does the next credit */
  lastStepMs: number | null;
  unservedOpen: boolean;
  faultOpen: boolean;
  lastPumpState: string | null;
}

const label = (p: StagePump | undefined, id: string) => p?.name?.trim() || id;
// The bridge's LIVE derived `fault` state is the only fault signal: it already excludes info-level protections (P17
// anti-freeze is NORMAL — poller.py _derive_state), while the hub's raw active_faults COUNT includes them (codex pass
// 1), and the mirror's pump_snapshots codes can be minutes stale (codex pass 2) — they only ANNOTATE a live fault.
const faulted = (p: StagePump | undefined) => !!p && p.online && p.state === "fault";
const describe = (p: StagePump | undefined, id: string): string => {
  if (!p) return `${id} is not in the hub's state (no data)`;
  const codes = p.fault_codes?.length ? `, ${p.fault_codes.join("/")}` : "";
  return `${label(p, id)} is ${p.online ? (p.state ?? "unknown") : "offline"}${codes}`;
};

export class StageWatch {
  private st: Record<string, StageState> = {};

  constructor(private readonly map: Record<string, string>, private readonly graceMs = STAGE_START_GRACE_MS) {
    for (const k of Object.keys(map)) this.st[k] = { calledMs: 0, lastStepMs: null, unservedOpen: false, faultOpen: false, lastPumpState: null };
  }

  /** Re-adopt episodes still open in the DB after a restart, so they close (not re-page) when the condition clears. */
  restore(open: { type: StageEpisodeKind; stage: string }[]): void {
    for (const o of open) {
      const s = this.st[o.stage];
      if (!s) continue;
      if (o.type === "stage_unserved") { s.unservedOpen = true; s.calledMs = this.graceMs; }
      else s.faultOpen = true;
    }
  }

  /**
   * One poll. `stagesCalled` = the HBX's stage relays (index 0 = stage 1), null when unknown; `pumps` = the hub's pump
   * states, or null when they cannot stand in for the live pumps (hub unreachable, Pi disconnected, stale frame) — then
   * nothing moves: no clock, no page, no close.
   */
  step(i: { nowMs: number; stagesCalled: boolean[] | null; pumps: StagePump[] | null; lagTMin: number | null }): StageEvent[] {
    const out: StageEvent[] = [];
    if (i.stagesCalled == null || i.pumps == null) {
      for (const s of Object.values(this.st)) s.lastStepMs = null; // a blind spell never counts as called time
      return out;
    }
    const lagT = i.lagTMin != null ? `${i.lagTMin} min` : "lagT";
    for (const [stage, pumpId] of Object.entries(this.map)) {
      const s = this.st[stage];
      const called = i.stagesCalled[Number(stage) - 1] === true;
      const pump = i.pumps.find((p) => p.id === pumpId);
      s.lastPumpState = pump ? (pump.online ? pump.state ?? null : "offline") : null;
      const others = Object.entries(this.map).filter(([k]) => k !== stage).map(([k, id]) => {
        const p = i.pumps!.find((x) => x.id === id);
        const c = i.stagesCalled![Number(k) - 1] === true;
        return c ? `Stage ${k} (${label(p, id)}) is called too — ${describe(p, id)}.`
          : `${label(p, id)} (stage ${k}) is not called — the HBX waits up to lagT (${lagT}) of continuous call before adding the lag stage.`;
      }).join(" ");

      if (!called) {
        if (s.unservedOpen) out.push(this.close(stage, pumpId, "stage_unserved", `Stage ${stage} is no longer called.`));
        if (s.faultOpen) out.push(this.close(stage, pumpId, "fault_called", `Stage ${stage} is no longer called.`));
        s.unservedOpen = false; s.faultOpen = false; s.calledMs = 0; s.lastStepMs = null;
        continue;
      }

      // fault while called: immediate, its own edge
      if (faulted(pump) && !s.faultOpen) {
        s.faultOpen = true;
        out.push({
          kind: "open", type: "fault_called", stage, pumpId, priority: "high",
          title: `⚠ Stage ${stage} called but ${label(pump, pumpId)} is FAULTED`,
          body: `The HBX is calling stage ${stage}, wired to ${label(pump, pumpId)}, which reports an active fault: ${describe(pump, pumpId)}. ` +
            `The HBX stages by dry contact and does not know the unit is faulted. ${others}`,
        });
      } else if (!faulted(pump) && s.faultOpen) {
        s.faultOpen = false;
        out.push(this.close(stage, pumpId, "fault_called", `${label(pump, pumpId)} no longer reports a fault.`));
      }

      const heating = !!pump && pump.online && pump.state === "heating";
      if (heating) {
        if (s.unservedOpen) out.push(this.close(stage, pumpId, "stage_unserved", `${label(pump, pumpId)} is heating again.`));
        s.unservedOpen = false; s.calledMs = 0; s.lastStepMs = null;
        continue;
      }
      const defrost = !!pump && pump.online && pump.state === "defrost";
      // Time is credited only BETWEEN two observations that were both called-not-heating-not-defrost (codex pass 5):
      // an interval that began heating or in defrost is not unserved time; a gap longer than MAX_STEP_MS (skipped
      // polls) credits nothing (pass 1). Defrost SUSPENDS the clock — it neither runs nor resets.
      if (defrost) { s.lastStepMs = null; }
      else {
        const gap = s.lastStepMs == null ? 0 : Math.max(0, i.nowMs - s.lastStepMs);
        s.calledMs += gap > MAX_STEP_MS ? 0 : gap;
        s.lastStepMs = i.nowMs;
      }
      if (!s.unservedOpen && s.calledMs >= this.graceMs) {
        s.unservedOpen = true;
        out.push({
          kind: "open", type: "stage_unserved", stage, pumpId, priority: "high",
          title: `⚠ Stage ${stage} called ${Math.round(s.calledMs / 60_000)} min but ${label(pump, pumpId)} is not heating`,
          body: `Stage ${stage} called for ${Math.round(s.calledMs / 60_000)} min but ${describe(pump, pumpId)} — not heating. ${others} ` +
            `The tank is falling while the HBX waits.`,
        });
      }
    }
    return out;
  }

  private close(stage: string, pumpId: string, type: StageEpisodeKind, why: string): StageEvent {
    return {
      kind: "close", type, stage, pumpId, priority: "default",
      title: type === "stage_unserved" ? `Stage ${stage} served again` : `Stage ${stage}: fault-while-called cleared`,
      body: why,
    };
  }

  status(): Record<string, { pump: string; called_not_heating_min: number; unserved_open: boolean; fault_open: boolean; pump_state: string | null }> {
    const out: ReturnType<StageWatch["status"]> = {};
    for (const [stage, pumpId] of Object.entries(this.map)) {
      const s = this.st[stage];
      out[stage] = { pump: pumpId, called_not_heating_min: Math.round(s.calledMs / 6_000) / 10, unserved_open: s.unservedOpen, fault_open: s.faultOpen, pump_state: s.lastPumpState };
    }
    return out;
  }
}

/**
 * Restore (codex pass 10): an open stage episode is re-adopted only if it is about the pump that stage maps to NOW. After
 * STAGE_PUMP_MAP was corrected, an episode for the old unit would otherwise suppress the right one's page — it is closed
 * instead. SPAN and other kinds pass through untouched.
 */
export function partitionRestore<T extends { kind: string; key: string; pumpId: string | null }>(
  open: T[], map: Record<string, string>,
): { keep: T[]; stale: T[] } {
  const isStage = (o: T) => o.kind === "stage_unserved" || o.kind === "fault_called";
  const stale = open.filter((o) => isStage(o) && map[o.key] !== o.pumpId);
  return { keep: open.filter((o) => !stale.includes(o)), stale };
}
