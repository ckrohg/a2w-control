/**
 * @purpose TempIQ external-readings pusher (plan §A-7 seam, TempIQ#1480 — SHIPPED
 * 2026-07-14 as TempIQv2 PR #1490). Every PUSH_EVERY_MIN the planner pushes each
 * online pump's setpoint_c / outlet_c (LWT) / inlet_c to TempIQ's
 * POST /api/insights/readings (surface-token bearer auth, °C with unit "C" —
 * TempIQ converts to °F at ingest and maps metric names to canonical signal keys:
 * heat_pump_setpoint / leaving_water_temperature / entering_water_temperature).
 * TempIQ's hydronic COP model prefers LWT as the condensing-side coordinate when
 * these readings exist (Carnot-fraction estimator, PR #1500) — this pusher is what
 * turns that path on. Re-pushing the same (equipment, metric, ts) dedupes server-side,
 * so retries are safe. Fail-soft: a push failure NEVER touches the control loop;
 * we log, count, and try again next tick. Flag-gated: inert unless
 * TEMPIQ_PUSH_ENABLED=1 and TEMPIQ_SURFACE_TOKEN is set.
 */

import type { HubClient, HubPump } from "./hub";

const STALE_STATE_MS = 15 * 60 * 1000; // never push telemetry older than 15 min

export interface TempiqPushStatus {
  enabled: boolean;
  lastPushAt: string | null;
  lastResult: string | null;
  consecutiveFailures: number;
}

export class TempiqPusher {
  private lastPushAt: string | null = null;
  private lastResult: string | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly hub: HubClient,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  status(): TempiqPushStatus {
    return {
      enabled: true,
      lastPushAt: this.lastPushAt,
      lastResult: this.lastResult,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /** One push tick: read the latest hub state, push per online pump. Never throws. */
  async tick(): Promise<void> {
    try {
      const state = await this.hub.getState();
      if (!state.pi_connected || state.ts == null) {
        this.lastResult = "skipped: pi offline / no state";
        return;
      }
      const tsMs = state.ts > 1e12 ? state.ts : state.ts * 1000;
      if (Date.now() - tsMs > STALE_STATE_MS) {
        this.lastResult = `skipped: state stale (${Math.round((Date.now() - tsMs) / 60000)} min)`;
        return;
      }
      const ts = new Date(tsMs).toISOString();

      let pushed = 0;
      const results: string[] = [];
      for (const pump of state.pumps) {
        if (!pump.online) continue;
        const metrics = this.metricsFor(pump, ts);
        if (metrics.length === 0) continue;
        const res = await fetch(`${this.baseUrl}/api/insights/readings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ equipment: `a2w-${pump.id}`, metrics }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`tempiq POST readings (${pump.id}): HTTP ${res.status}`);
        const body = (await res.json()) as { inserted?: number; deduped?: number };
        results.push(`${pump.id}: +${body.inserted ?? "?"}/${body.deduped ?? "?"}dup`);
        pushed++;
      }
      this.lastPushAt = new Date().toISOString();
      this.lastResult = pushed > 0 ? results.join(", ") : "skipped: no online pumps with data";
      this.consecutiveFailures = 0;
      if (pushed > 0) console.log(`[tempiq-push] ${this.lastResult}`);
    } catch (e) {
      this.consecutiveFailures++;
      this.lastResult = `error: ${e instanceof Error ? e.message : String(e)}`;
      // Log every failure but only loudly warn on streaks — transient Vercel/network
      // blips are expected and the next tick retries with server-side dedupe.
      if (this.consecutiveFailures === 1 || this.consecutiveFailures % 12 === 0) {
        console.error(`[tempiq-push] ${this.lastResult} (streak ${this.consecutiveFailures})`);
      }
    }
  }

  private metricsFor(
    pump: HubPump,
    ts: string,
  ): Array<{ metric: string; value: number; unit: string; ts: string }> {
    const metrics: Array<{ metric: string; value: number; unit: string; ts: string }> = [];
    if (pump.setpoint_c != null && Number.isFinite(pump.setpoint_c)) {
      metrics.push({ metric: "setpoint_c", value: pump.setpoint_c, unit: "C", ts });
    }
    if (pump.outlet_c != null && Number.isFinite(pump.outlet_c)) {
      metrics.push({ metric: "outlet_c", value: pump.outlet_c, unit: "C", ts });
    }
    if (pump.inlet_c != null && Number.isFinite(pump.inlet_c)) {
      metrics.push({ metric: "inlet_c", value: pump.inlet_c, unit: "C", ts });
    }
    return metrics;
  }
}
