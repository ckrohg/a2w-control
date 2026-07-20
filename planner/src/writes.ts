/**
 * @purpose The guarded HBX write path (plan §5.2). Mechanism (CORRECTED 2026-07-16): a target
 * is commanded by PATCHing a VALID near-flat reset curve (dbt=T+2 / mbt=T-2 — a real curve,
 * dbt > mbt). The device latches its curve mid-reheat and re-reads the cloud curve at the START
 * of the next reheat cycle, so the buffer ADOPTS the new band on the next cycle (proven live;
 * see memory hbx-remote-target-uncontrollable). Adoption is asynchronous — we do NOT synchronously
 * verify the operative target (the old dbt==mbt flatten + 8 s temp1.target check was the bug: the
 * device ignores a degenerate curve and only recomputes on the next cycle anyway). Restore
 * re-applies the as-found endpoints from the seed config version.
 * Guardrails, in order: I4 envelope clamp (bandFor, outdoor-indexed) → I1 cross-check against live
 * pump setpoints from the hub → rate limit (restore exempt: reverting to baseline must never be
 * blocked) → PATCH with response-echo verify (proves the API accepted dbt/mbt) → self-recorded
 * config version (so the drift detector doesn't re-alert our own write) → audit row for EVERY
 * attempt, accepted or rejected → ntfy on success. Adoption then shows up in the 5-min poll loop
 * as temp1.target moves onto the new band; status() reports commanded-vs-operative.
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
    // Phase 3 v2: surfaced in status() so the Optimize UI knows whether the daily auto-sanitize is
    // live. Mutable so the dashboard toggle (controller_flags) keeps it live. Does NOT change any
    // write path — it only gates whether checkI8 auto-actuates the soak.
    private autoSanitizeEnabled = false,
    // #36 optional defense-in-depth (flag-gated by WRITER_LEASE_ENABLED). When set, patch()
    // refuses to write unless THIS instance holds a fresh single-writer lease, so a second
    // planner instance can't collide on the live plant. null = disabled (no-op) — the default.
    private readonly writerLease: { instanceId: string; staleMs: number } | null = null,
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
    const overridden = cfg != null && baseline != null &&
      (cfg.dbt !== baseline.dbt || cfg.mbt !== baseline.mbt);
    // Commanded target = midpoint of the current curve band we wrote; operative = temp1.target
    // the device is actually driving to. They differ during the adoption lag (until the next
    // reheat cycle) — surface both so the UI shows "commanded X, adopts next cycle" rather than
    // looking stuck.
    const commanded = cfg != null ? Math.round(((cfg.dbt as number) + (cfg.mbt as number)) / 2) : null;
    const operative = latest?.targetF ?? null;
    const adoptionPending = commanded != null && operative != null && Math.abs(commanded - operative) > 3;
    const boost = await this.store.activeBoost();
    return {
      tank_f: latest?.tankF ?? null,
      target_f: operative,
      commanded_target_f: commanded,
      adoption_pending: adoptionPending,
      outdoor_f: outdoor,
      band: band ? { lo: Math.round(band.lo), hi: Math.round(band.hi) } : null,
      curve_overridden: overridden,
      baseline: baseline ? { dbt: baseline.dbt, mbt: baseline.mbt } : null,
      last_write_at: this.lastWriteAt ? new Date(this.lastWriteAt).toISOString() : null,
      i1_margin_f: DEFAULT_OPTS.i1MarginF,
      active_boost: boost ? { target_f: boost.targetF, restore_at: boost.restoreAt.toISOString() } : null,
      auto_sanitize_enabled: this.autoSanitizeEnabled,
    };
  }

  /** Live-toggle auto-sanitize (dashboard switch → controller_flags → applied each poll). */
  setAutoSanitize(enabled: boolean): void {
    this.autoSanitizeEnabled = enabled;
  }

  // capF is the I4 upper ceiling for THIS write. Defaults to the everyday strictCap; the daily
  // sanitize passes DEFAULT_OPTS.sanitizeCapF so its 140°F soak isn't clamped to 135. This only
  // raises the envelope ceiling — the I1 cross-check below is unchanged, so a higher target still
  // requires the pump setpoints to cover it (setpoint ≥ target + margin) or the write is rejected.
  async setTarget(targetF: number, source: string, capF: number = DEFAULT_OPTS.strictCapF): Promise<Record<string, unknown>> {
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
    // A cap above the everyday strictCap marks a sanitize excursion, which is allowed above the
    // curve+3 comfort ceiling (bounded by capF); I1 below still requires setpoints to cover it.
    const sanitize = capF > DEFAULT_OPTS.strictCapF;
    const band = bandFor(latest!.outdoorF as number, cfg, capF, sanitize);
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

    // Write a VALID near-flat curve (dbt > mbt) centered on the target — NOT a degenerate
    // flatten (dbt == mbt), which the device silently ignores. The controller re-reads the
    // cloud curve at the START of the next reheat cycle and adopts it (proven live 2026-07-16;
    // see memory hbx-remote-target-uncontrollable + hbx-target-write-noop-diagnosis.md).
    // Adoption is ASYNCHRONOUS (minutes / next cycle), so we do NOT synchronously verify
    // temp1.target here — that was the old bug (an 8 s check that always failed because the
    // operative target only moves on the next cycle). The config-echo inside patch() proves the
    // API accepted the write; the 5-min poll loop then records the operative target as it lands
    // on the new band, and status() surfaces commanded-vs-operative so the UI shows the pending
    // adoption. CAVEAT for Phase C: any pump-setpoint reduction must gate on the OPERATIVE
    // target (temp1.target), never this commanded value, or the adoption lag can manufacture an
    // I1 stall (the 2026-07-15 incident).
    // Emulate a FIXED target with a valid near-flat reset curve, computed so the curve's OUTPUT
    // at the CURRENT outdoor equals targetF exactly. A naive dbt=T+2/mbt=T-2 centers the band on T
    // but the reset-curve output sits near mbt at warm outdoor (and near dbt when cold), so the
    // operative target reads ~1°F off. Solving for the outdoor removes that bias: with slope point
    // f = (outdoor-dot)/(wwsd-dot) and spread s, set mbt = T - s(1-f), dbt = T + s·f  ⇒
    // output(outdoor) = T, while dbt-mbt = s (a valid, non-degenerate curve; the device ignores
    // dbt==mbt). Drift as outdoor moves is bounded by s over the whole 5–125°F range (~±0.7°F/day).
    const cc = cfg as { dot?: number; wwsd?: number } | null;
    const dot = cc?.dot ?? 5;
    const wwsd = cc?.wwsd ?? 125;
    const f = Math.max(0, Math.min(1, ((latest!.outdoorF as number) - dot) / (wwsd - dot)));
    const SPREAD = 4;
    const dbt = Math.round(targetF + SPREAD * f);
    const mbt = Math.round(targetF - SPREAD * (1 - f));
    return this.patch(
      { dbt, mbt },
      source,
      "set_target",
      `target ${targetF}°F commanded (curve ${dbt}/${mbt} → ${targetF}°F output at ${Math.round(latest!.outdoorF as number)}°F outdoor; adopts on the next reheat cycle)`,
    );
  }

  /**
   * Timed boost with DURABLE auto-restore: set a fixed target now, and the poll loop
   * restores the as-found curve when restore_at passes — recorded in Neon, so a planner
   * restart mid-boost cannot strand the override (the Phase C write-safety primitive,
   * built early in human-triggered form). All setTarget guardrails apply to the boost;
   * the restore is exempt (reverting to baseline is never blocked).
   */
  async boost(targetF: number, minutes: number, source: string, capF: number = DEFAULT_OPTS.strictCapF): Promise<Record<string, unknown>> {
    if (!Number.isFinite(minutes) || minutes < 15 || minutes > 120) {
      await this.store.insertHbxWrite({ source, action: "boost", requested: { target_f: targetF, minutes }, result: "rejected", detail: "minutes must be 15–120" });
      throw new WriteError(422, "minutes must be 15–120");
    }
    const result = await this.setTarget(targetF, source, capF); // envelope (capF) + I1 + rate limit
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
    // Single-writer lease gate (flag-gated; null = disabled). If this instance does not hold a
    // fresh lease, another planner is the active writer — refuse BEFORE touching the device.
    // Gates EVERY write path (set_target / boost / restore all funnel through here). #36.
    if (this.writerLease) {
      const held = await this.store.holdsWriterLease(this.writerLease.instanceId, this.writerLease.staleMs);
      if (!held) {
        await this.store.insertHbxWrite({ source, action, requested: fields, result: "rejected", detail: "does not hold the single-writer lease — another planner instance is the active writer" });
        throw new WriteError(423, "refused: this instance does not hold the single-writer lease (another planner is the active writer). See README §Single-writer invariant, #36.");
      }
    }
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
