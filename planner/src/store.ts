/**
 * @purpose Neon Postgres store for the planner. Two tables, additive (CREATE IF NOT
 * EXISTS) in the shared mirror DB: slx_readings (narrow 5-min HBX telemetry) and
 * hbx_config_versions (append-only config history; row 1 = first observation, every
 * later row = detected drift with the changed fields). Planner tables are tiny and
 * exempt from the mirror's 90-day trim (plan §4.1).
 */

import { Pool } from "pg";
import type { HbxConfig, FieldChange } from "./drift";

export interface SlxReading {
  ts: Date;
  tankF: number | null;
  tankTargetF: number | null;
  outdoorF: number | null;
  hdActive: boolean | null;
  cdActive: boolean | null;
  stagesCalled: boolean[] | null;
  backupCalled: boolean | null;
  relays: number | null;
  connected: boolean | null;
}

export class Store {
  private pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
    });
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS slx_readings (
        ts             timestamptz PRIMARY KEY,
        tank_f         real,
        tank_target_f  real,
        outdoor_f      real,
        hd_active      boolean,
        cd_active      boolean,
        stages_called  boolean[],
        backup_called  boolean,
        relays         integer,
        connected      boolean
      );
      CREATE TABLE IF NOT EXISTS hbx_config_versions (
        id             serial PRIMARY KEY,
        observed_at    timestamptz NOT NULL DEFAULT now(),
        changed_fields jsonb,
        config         jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS shadow_plans (
        id          serial PRIMARY KEY,
        computed_at timestamptz NOT NULL DEFAULT now(),
        plan        jsonb NOT NULL
      );
      ALTER TABLE shadow_plans ADD COLUMN IF NOT EXISTS meta jsonb;
      CREATE TABLE IF NOT EXISTS plan_scores (
        hour_ts          timestamptz PRIMARY KEY,
        shadow_target_f  real,
        actual_target_f  real,
        actual_tank_f    real,
        gap_f            real,
        plan_computed_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS hbx_writes (
        id         serial PRIMARY KEY,
        ts         timestamptz NOT NULL DEFAULT now(),
        source     text NOT NULL,
        action     text NOT NULL,
        requested  jsonb,
        result     text NOT NULL,
        detail     text
      );
      CREATE TABLE IF NOT EXISTS tank_decay_fits (
        window_start timestamptz PRIMARY KEY,
        window_end   timestamptz NOT NULL,
        t_start_f    real NOT NULL,
        t_end_f      real NOT NULL,
        hours        real NOT NULL,
        slope_f_per_h real NOT NULL
      );
      CREATE TABLE IF NOT EXISTS i1_episodes (
        id         serial PRIMARY KEY,
        started_at timestamptz NOT NULL DEFAULT now(),
        cleared_at timestamptz,
        detail     text
      );
    `);
  }

  /** Recent tank series with call flags — for quiet-window (decay) detection. */
  async getRecentSeries(hours: number): Promise<
    { ts: Date; tankF: number | null; anyCall: boolean }[]
  > {
    const res = await this.pool.query(
      `SELECT ts, tank_f,
              (backup_called OR EXISTS (SELECT 1 FROM unnest(stages_called) s WHERE s)) AS any_call
       FROM slx_readings
       WHERE ts >= now() - ($1 || ' hours')::interval
       ORDER BY ts ASC`,
      [hours],
    );
    return res.rows.map((r) => ({
      ts: new Date(r.ts),
      tankF: r.tank_f == null ? null : Number(r.tank_f),
      anyCall: r.any_call === true,
    }));
  }

  async upsertDecayFit(f: {
    windowStart: Date; windowEnd: Date; tStartF: number; tEndF: number;
    hours: number; slopeFPerH: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO tank_decay_fits (window_start, window_end, t_start_f, t_end_f, hours, slope_f_per_h)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (window_start) DO UPDATE SET
         window_end = EXCLUDED.window_end, t_end_f = EXCLUDED.t_end_f,
         hours = EXCLUDED.hours, slope_f_per_h = EXCLUDED.slope_f_per_h`,
      [f.windowStart, f.windowEnd, f.tStartF, f.tEndF, f.hours, f.slopeFPerH],
    );
  }

  async openI1Episode(detail: string): Promise<void> {
    await this.pool.query(`INSERT INTO i1_episodes (detail) VALUES ($1)`, [detail]);
  }

  async closeI1Episode(): Promise<void> {
    await this.pool.query(
      `UPDATE i1_episodes SET cleared_at = now()
       WHERE cleared_at IS NULL AND id = (SELECT max(id) FROM i1_episodes)`,
    );
  }

  /** Audit every write ATTEMPT — accepted or rejected — like the bridge does for reg 2003. */
  async insertHbxWrite(w: {
    source: string; action: string; requested: unknown; result: string; detail: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO hbx_writes (source, action, requested, result, detail) VALUES ($1,$2,$3,$4,$5)`,
      [w.source, w.action, JSON.stringify(w.requested), w.result, w.detail],
    );
  }

  /** Latest SensorLinx reading (for the envelope's outdoor input + current target). */
  async getLatestSlx(): Promise<{ ts: Date; tankF: number | null; targetF: number | null; outdoorF: number | null } | null> {
    const res = await this.pool.query(
      `SELECT ts, tank_f, tank_target_f, outdoor_f FROM slx_readings ORDER BY ts DESC LIMIT 1`,
    );
    if (!res.rowCount) return null;
    const r = res.rows[0];
    return {
      ts: new Date(r.ts),
      tankF: r.tank_f == null ? null : Number(r.tank_f),
      targetF: r.tank_target_f == null ? null : Number(r.tank_target_f),
      outdoorF: r.outdoor_f == null ? null : Number(r.outdoor_f),
    };
  }

  /** The as-found baseline = the seed config version (row 1, committed 2026-07-13). */
  async baselineConfig(): Promise<HbxConfig | null> {
    const res = await this.pool.query(
      `SELECT config FROM hbx_config_versions ORDER BY id ASC LIMIT 1`,
    );
    return res.rowCount ? (res.rows[0].config as HbxConfig) : null;
  }

  async insertShadowPlan(plan: unknown, meta: unknown): Promise<void> {
    await this.pool.query(`INSERT INTO shadow_plans (plan, meta) VALUES ($1, $2)`, [
      JSON.stringify(plan), JSON.stringify(meta),
    ]);
  }

  /** tank_f history for the DHW learner (ascending). */
  async getTankHistory(days: number): Promise<{ ts: Date; tankF: number }[]> {
    const res = await this.pool.query(
      `SELECT ts, tank_f FROM slx_readings
       WHERE ts >= now() - ($1 || ' days')::interval AND tank_f IS NOT NULL
       ORDER BY ts ASC`,
      [days],
    );
    return res.rows.map((r) => ({ ts: new Date(r.ts), tankF: Number(r.tank_f) }));
  }

  /** All shadow plans computed in the last N hours (ascending). */
  async recentPlans(hours: number): Promise<{ computedAt: Date; plan: any[] }[]> {
    const res = await this.pool.query(
      `SELECT computed_at, plan FROM shadow_plans
       WHERE computed_at >= now() - ($1 || ' hours')::interval
       ORDER BY computed_at ASC`,
      [hours],
    );
    return res.rows.map((r) => ({ computedAt: new Date(r.computed_at), plan: r.plan }));
  }

  /** Hourly averages of actual HBX target + tank for completed hours (ascending). */
  async hourlyActuals(hours: number): Promise<{ hour: Date; targetF: number | null; tankF: number | null }[]> {
    const res = await this.pool.query(
      `SELECT date_trunc('hour', ts) AS h, avg(tank_target_f) AS target_f, avg(tank_f) AS tank_f
       FROM slx_readings
       WHERE ts >= now() - ($1 || ' hours')::interval AND ts < date_trunc('hour', now())
       GROUP BY 1 ORDER BY 1 ASC`,
      [hours],
    );
    return res.rows.map((r) => ({
      hour: new Date(r.h),
      targetF: r.target_f == null ? null : Number(r.target_f),
      tankF: r.tank_f == null ? null : Number(r.tank_f),
    }));
  }

  async upsertPlanScore(s: {
    hourTs: Date; shadowTargetF: number; actualTargetF: number | null;
    actualTankF: number | null; gapF: number | null; planComputedAt: Date;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO plan_scores (hour_ts, shadow_target_f, actual_target_f, actual_tank_f, gap_f, plan_computed_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (hour_ts) DO UPDATE SET
         shadow_target_f = EXCLUDED.shadow_target_f,
         actual_target_f = EXCLUDED.actual_target_f,
         actual_tank_f   = EXCLUDED.actual_tank_f,
         gap_f           = EXCLUDED.gap_f,
         plan_computed_at = EXCLUDED.plan_computed_at`,
      [s.hourTs, s.shadowTargetF, s.actualTargetF, s.actualTankF, s.gapF, s.planComputedAt],
    );
  }

  async insertReading(r: SlxReading): Promise<void> {
    await this.pool.query(
      `INSERT INTO slx_readings
         (ts, tank_f, tank_target_f, outdoor_f, hd_active, cd_active,
          stages_called, backup_called, relays, connected)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (ts) DO NOTHING`,
      [r.ts, r.tankF, r.tankTargetF, r.outdoorF, r.hdActive, r.cdActive,
       r.stagesCalled, r.backupCalled, r.relays, r.connected],
    );
  }

  async latestConfig(): Promise<HbxConfig | null> {
    const res = await this.pool.query(
      `SELECT config FROM hbx_config_versions ORDER BY id DESC LIMIT 1`,
    );
    return res.rowCount ? (res.rows[0].config as HbxConfig) : null;
  }

  async insertConfigVersion(
    config: HbxConfig,
    changedFields: Record<string, FieldChange> | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO hbx_config_versions (changed_fields, config) VALUES ($1, $2)`,
      [changedFields === null ? null : JSON.stringify(changedFields), JSON.stringify(config)],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
