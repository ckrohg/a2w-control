/**
 * @purpose The guarded HBX write path (plan §5.2) — HUMAN-TRIGGERED ONLY in this phase
 * (source=dashboard via the mirror's server-side proxy; Phase C autonomy is a separate,
 * gated decision). Mechanism: with outdoor reset ON, a fixed target is commanded by
 * flattening the curve (PATCH dbt=mbt=T — both fields verified writable in the A-3
 * capture); restore re-applies the as-found endpoints from the seed config version.
 * Guardrails, in order: I4 envelope clamp (bandFor, outdoor-indexed) → I1 cross-check
 * against live pump setpoints from the hub → rate limit (restore exempt: reverting to
 * baseline must never be blocked) → PATCH with response-echo verify → self-recorded
 * config version (so the drift detector doesn't re-alert our own write) → audit row for
 * EVERY attempt, accepted or rejected → ntfy on success.
 */

import { SensorLinxClient } from "./sensorlinx";
import { Store } from "./store";
import { HubClient } from "./hub";
import { bandFor, DEFAULT_OPTS } from "./shadow";
import { extractConfig, diffConfig } from "./drift";

const WRITE_MIN_INTERVAL_MS = 15 * 60 * 1000;
const SLX_FRESH_MS = 20 * 60 * 1000;

const cToF = (c: number) => (c * 9) / 5 + 32;

export class WriteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class HbxWriter {
  private lastWriteAt = 0;

  constructor(
    private readonly slx: SensorLinxClient,
    private readonly store: Store,
    private readonly hub: HubClient | null,
    private readonly buildingId: string,
    private readonly syncCode: string,
    private readonly notify: (title: string, body: string, priority?: string) => Promise<void>,
    // Phase 3 v2: surfaced in status() so the Optimize UI knows whether the daily
    // auto-sanitize is live (gates the deeper 120°F cut). Does NOT change any write path.
    private readonly autoSanitizeEnabled = false,
  ) {}

  /** Current status for the dashboard card: live target, envelope, write state. */
  async status(): Promise<Record<string, unknown>> {
    const [latest, cfg, baseline] = await Promise.all([
      this.store.getLatestSlx(),
      this.store.latestConfig(),
      this.store.baselineConfig(),
    ]);
    const outdoor = latest?.outdoorF ?? null;
    const band = outdoor != null ? bandFor(outdoor, cfg, DEFAULT_OPTS.strictCapF) : null;
    const flattened = cfg != null && baseline != null &&
      (cfg.dbt !== baseline.dbt || cfg.mbt !== baseline.mbt);
    const boost = await this.store.activeBoost();
    return {
      tank_f: latest?.tankF ?? null,
      target_f: latest?.targetF ?? null,
      outdoor_f: outdoor,
      band: band ? { lo: Math.round(band.lo), hi: Math.round(band.hi) } : null,
      curve_overridden: flattened,
      baseline: baseline ? { dbt: baseline.dbt, mbt: baseline.mbt } : null,
      last_write_at: this.lastWriteAt ? new Date(this.lastWriteAt).toISOString() : null,
      i1_margin_f: DEFAULT_OPTS.i1MarginF,
      active_boost: boost ? { target_f: boost.targetF, restore_at: boost.restoreAt.toISOString() } : null,
      auto_sanitize_enabled: this.autoSanitizeEnabled,
    };
  }

  async setTarget(targetF: number, source: string): Promise<Record<string, unknown>> {
    const reject = async (status: number, detail: string) => {
      await this.store.insertHbxWrite({ source, action: "set_target", requested: { target_f: targetF }, result: "rejected", detail });
      throw new WriteError(status, detail);
    };

    if (!Number.isFinite(targetF)) await reject(422, "target_f must be a number");
    targetF = Math.round(targetF);

    const latest = await this.store.getLatestSlx();
    if (!latest || Date.now() - latest.ts.getTime() > SLX_FRESH_MS || latest.outdoorF == null) {
      await reject(503, "no fresh SensorLinx reading — cannot evaluate the outdoor-indexed envelope");
    }
    const cfg = await this.store.latestConfig();
    const band = bandFor(latest!.outdoorF as number, cfg, DEFAULT_OPTS.strictCapF);
    if (targetF < band.lo || targetF > band.hi) {
      await reject(422, `target ${targetF}°F outside the I4 envelope [${Math.round(band.lo)}–${Math.round(band.hi)}]°F at ${latest!.outdoorF}°F outdoor`);
    }

    // I1 cross-check: every online pump must clear target + margin, or this write
    // manufactures the calls-forever deadlock.
    if (this.hub) {
      try {
        const state = await this.hub.getState();
        const required = targetF + DEFAULT_OPTS.i1MarginF;
        const offenders = state.pumps
          .filter((p) => p.online && p.setpoint_c != null && cToF(p.setpoint_c) < required)
          .map((p) => `${p.id} at ${cToF(p.setpoint_c as number).toFixed(1)}°F < ${required}°F`);
        if (offenders.length) {
          await reject(409, `I1 conflict: ${offenders.join("; ")} — raise pump setpoint(s) first or pick a lower target`);
        }
      } catch (e) {
        if (e instanceof WriteError) throw e;
        await reject(503, `hub unreachable — cannot verify I1: ${(e as Error).message}`);
      }
    }

    if (Date.now() - this.lastWriteAt < WRITE_MIN_INTERVAL_MS) {
      await reject(429, `rate limited: one HBX write per ${WRITE_MIN_INTERVAL_MS / 60000} min (restore is always allowed)`);
    }

    return this.patch({ dbt: targetF, mbt: targetF }, source, "set_target",
      `target fixed at ${targetF}°F (curve flattened)`);
  }

  /**
   * Timed boost with DURABLE auto-restore: set a fixed target now, and the poll loop
   * restores the as-found curve when restore_at passes — recorded in Neon, so a planner
   * restart mid-boost cannot strand the override (the Phase C write-safety primitive,
   * built early in human-triggered form). All setTarget guardrails apply to the boost;
   * the restore is exempt (reverting to baseline is never blocked).
   */
  async boost(targetF: number, minutes: number, source: string): Promise<Record<string, unknown>> {
    if (!Number.isFinite(minutes) || minutes < 15 || minutes > 120) {
      await this.store.insertHbxWrite({ source, action: "boost", requested: { target_f: targetF, minutes }, result: "rejected", detail: "minutes must be 15–120" });
      throw new WriteError(422, "minutes must be 15–120");
    }
    const result = await this.setTarget(targetF, source); // envelope + I1 + rate limit
    const restoreAt = new Date(Date.now() + minutes * 60_000);
    await this.store.insertBoost(targetF, restoreAt);
    return { ...result, boost_restore_at: restoreAt.toISOString() };
  }

  /** Called every poll: restore any boost whose timer has passed (durable expiry). */
  async expireBoosts(): Promise<void> {
    const due = await this.store.dueBoosts();
    if (!due.length) return;
    await this.restore("boost-expiry");
    await this.store.markBoostsRestored(due.map((d) => d.id));
  }

  /** Re-apply the as-found curve endpoints. Never rate-limited, never envelope-checked. */
  async restore(source: string): Promise<Record<string, unknown>> {
    const baseline = await this.store.baselineConfig();
    if (!baseline || typeof baseline.dbt !== "number" || typeof baseline.mbt !== "number") {
      await this.store.insertHbxWrite({ source, action: "restore", requested: null, result: "rejected", detail: "no baseline config version" });
      throw new WriteError(500, "no baseline config version");
    }
    return this.patch({ dbt: baseline.dbt as number, mbt: baseline.mbt as number }, source, "restore",
      `as-found curve restored (${baseline.dbt}/${baseline.mbt}°F)`);
  }

  private async patch(
    fields: Record<string, number>,
    source: string,
    action: string,
    summary: string,
  ): Promise<Record<string, unknown>> {
    let dev: Record<string, any>;
    try {
      dev = await this.slx.patchDevice(this.buildingId, this.syncCode, fields);
    } catch (e) {
      await this.store.insertHbxWrite({ source, action, requested: fields, result: "failed", detail: (e as Error).message });
      throw new WriteError(502, `SensorLinx write failed: ${(e as Error).message}`);
    }

    const mismatches = Object.entries(fields).filter(([k, v]) => dev[k] !== v);
    if (mismatches.length) {
      const detail = `read-back mismatch: ${mismatches.map(([k, v]) => `${k} wanted ${v} got ${dev[k]}`).join("; ")}`;
      await this.store.insertHbxWrite({ source, action, requested: fields, result: "verify_mismatch", detail });
      throw new WriteError(502, detail);
    }

    // Record the new config ourselves so the 5-min drift detector doesn't page about
    // our own audited write.
    const newCfg = extractConfig(dev);
    const prev = await this.store.latestConfig();
    const changes = prev ? diffConfig(prev, newCfg) : null;
    if (changes) {
      (changes as Record<string, unknown>)["_source"] = `${source}:${action}`;
      await this.store.insertConfigVersion(newCfg, changes);
    }

    this.lastWriteAt = Date.now();
    await this.store.insertHbxWrite({ source, action, requested: fields, result: "accepted", detail: summary });
    await this.notify(`HBX ${action} (${source})`, summary);
    return { ok: true, ...fields, detail: summary };
  }
}
