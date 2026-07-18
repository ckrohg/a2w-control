/**
 * @purpose Neon Postgres store for the planner. Two tables, additive (CREATE IF NOT
 * EXISTS) in the shared mirror DB: slx_readings (narrow 5-min HBX telemetry) and
 * hbx_config_versions (append-only config history; row 1 = first observation, every
 * later row = detected drift with the changed fields), plus storm_events (storm-mode
 * episodes with trigger/ceiling, §6.11) and zone_floor_snapshots (hourly winter-solver
 * zone service floors, §6.9). Planner tables are tiny and exempt from the mirror's
 * 90-day trim (plan §4.1).
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
      CREATE TABLE IF NOT EXISTS autopilot_log (
        id        serial PRIMARY KEY,
        ts        timestamptz NOT NULL DEFAULT now(),
        target_f  real,
        reason    text,
        result    text NOT NULL,
        dry_run   boolean NOT NULL
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
      CREATE TABLE IF NOT EXISTS unserved_call_episodes (
        id         serial PRIMARY KEY,
        started_at timestamptz NOT NULL DEFAULT now(),
        cleared_at timestamptz,
        detail     text
      );
      CREATE TABLE IF NOT EXISTS hbx_boosts (
        id         serial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        target_f   real NOT NULL,
        restore_at timestamptz NOT NULL,
        restored   boolean NOT NULL DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS phase_b_log (
        id       serial PRIMARY KEY,
        ts       timestamptz NOT NULL DEFAULT now(),
        pump_id  text NOT NULL,
        mode     text NOT NULL,
        value_c  real,
        result   text
      );
      -- Single-row heartbeat of the planner's ACTUAL controller flags, upserted every poll.
      -- The dashboard reads this instead of hardcoding autonomy copy, so the page can never
      -- drift from reality. Distinct from autopilot_log/phase_b_log (decision history, dedup'd):
      -- updated_at IS a heartbeat (stale row ⇒ planner down ⇒ "not reporting").
      CREATE TABLE IF NOT EXISTS controller_status (
        id                 integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        updated_at         timestamptz NOT NULL DEFAULT now(),
        autopilot_enabled  boolean NOT NULL,
        autopilot_dry_run  boolean NOT NULL,
        autopilot_result   text,
        autopilot_target_f real,
        phaseb_enabled     boolean NOT NULL,
        phaseb_dry_run     boolean NOT NULL,
        phaseb_result      text
      );
      CREATE TABLE IF NOT EXISTS tempiq_zone_physics (
        zone_id            text PRIMARY KEY,
        name               text,
        ua_btu_hr_f        real,
        thermal_mass_btu_f real,
        emitter_type       text,
        confidence         real,
        source             text,
        fetched_at         timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tempiq_cop_points (
        measured_at    timestamptz NOT NULL,
        system         text NOT NULL,
        outdoor_temp_f real,
        sink_temp_f    real,
        cop            real,
        thermal_kwh    real,
        electrical_kwh real,
        quality        text,
        quality_score  real,
        PRIMARY KEY (measured_at, system)
      );
      CREATE TABLE IF NOT EXISTS tempiq_zone_energy (
        id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        fetched_at timestamptz NOT NULL,
        payload    jsonb NOT NULL
      );
      CREATE TABLE IF NOT EXISTS storm_events (
        id         serial PRIMARY KEY,
        started_at timestamptz NOT NULL DEFAULT now(),
        ended_at   timestamptz,
        trigger    text NOT NULL,
        detail     jsonb,
        ceiling_f  real
      );
      CREATE TABLE IF NOT EXISTS zone_floor_snapshots (
        ts             timestamptz PRIMARY KEY,
        zones          jsonb NOT NULL,
        binding_zone   text,
        binding_awt_f  real,
        tank_target_f  real,
        source         text
      );
      -- One row per live planner process (hostname:pid), heartbeated every poll. The
      -- single-writer guard (README §Single-writer invariant, #36) uses it to detect a SECOND
      -- planner running against the shared DB. Detection only — never gates a write.
      CREATE TABLE IF NOT EXISTS planner_instances (
        instance_id  text PRIMARY KEY,
        heartbeat_at timestamptz NOT NULL DEFAULT now()
      );
      -- Singleton single-writer LEASE (flag-gated by WRITER_LEASE_ENABLED). When enabled, only
      -- the instance holding a FRESH lease may write the HBX; a second instance is refused in
      -- writes.ts patch(). Takeover-on-stale lets a redeployed planner reclaim it. #36.
      CREATE TABLE IF NOT EXISTS hbx_writer_lease (
        id           integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        holder       text,
        heartbeat_at timestamptz NOT NULL DEFAULT now()
      );
      -- Single-row RUNTIME autonomy override (W2-A). Env flags (AUTOPILOT_DRY_RUN/PHASE_B_DRY_RUN)
      -- only SEED this on first boot; thereafter the dashboard's Off/Armed switch writes the row and
      -- the planner reads it at the top of every poll. Lets autonomy be flipped live with no redeploy.
      -- mode: 'off' (both shadow / dry-run) | 'arm' (both live). set/req are future modes (F/G).
      CREATE TABLE IF NOT EXISTS controller_flags (
        id                integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        mode              text NOT NULL,
        autopilot_dry_run boolean NOT NULL,
        phaseb_dry_run    boolean NOT NULL,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        text
      );
    `);
  }

  /** Seed the runtime autonomy row from the env defaults IF it doesn't exist yet (first boot only).
   *  After that the DB row is authoritative and env changes don't clobber a live choice. */
  async seedControllerFlags(seed: { mode: string; autopilotDryRun: boolean; phasebDryRun: boolean }): Promise<void> {
    await this.pool.query(
      `INSERT INTO controller_flags (id, mode, autopilot_dry_run, phaseb_dry_run, updated_by)
       VALUES (1, $1, $2, $3, 'env-seed')
       ON CONFLICT (id) DO NOTHING`,
      [seed.mode, seed.autopilotDryRun, seed.phasebDryRun],
    );
  }

  /** The current effective autonomy flags (runtime override). null before the row is seeded. */
  async getControllerFlags(): Promise<{ mode: string; autopilotDryRun: boolean; phasebDryRun: boolean } | null> {
    const r = await this.pool.query(
      `SELECT mode, autopilot_dry_run, phaseb_dry_run FROM controller_flags WHERE id = 1`,
    );
    if (!r.rowCount) return null;
    const x = r.rows[0];
    return { mode: x.mode, autopilotDryRun: x.autopilot_dry_run, phasebDryRun: x.phaseb_dry_run };
  }

  /** Set the runtime autonomy mode (dashboard Off/Armed switch). Returns the stored row. */
  async setControllerFlags(s: {
    mode: string; autopilotDryRun: boolean; phasebDryRun: boolean; updatedBy: string;
  }): Promise<{ mode: string; autopilotDryRun: boolean; phasebDryRun: boolean }> {
    await this.pool.query(
      `INSERT INTO controller_flags (id, mode, autopilot_dry_run, phaseb_dry_run, updated_at, updated_by)
       VALUES (1, $1, $2, $3, now(), $4)
       ON CONFLICT (id) DO UPDATE SET
         mode = EXCLUDED.mode,
         autopilot_dry_run = EXCLUDED.autopilot_dry_run,
         phaseb_dry_run = EXCLUDED.phaseb_dry_run,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by`,
      [s.mode, s.autopilotDryRun, s.phasebDryRun, s.updatedBy],
    );
    return { mode: s.mode, autopilotDryRun: s.autopilotDryRun, phasebDryRun: s.phasebDryRun };
  }

  async insertBoost(targetF: number, restoreAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO hbx_boosts (target_f, restore_at) VALUES ($1, $2)`,
      [targetF, restoreAt],
    );
  }

  /** Boosts whose restore is due (survives planner restarts — durability is the point). */
  async dueBoosts(): Promise<{ id: number; targetF: number }[]> {
    const res = await this.pool.query(
      `SELECT id, target_f FROM hbx_boosts WHERE NOT restored AND restore_at <= now() ORDER BY id`,
    );
    return res.rows.map((r) => ({ id: r.id, targetF: Number(r.target_f) }));
  }

  async activeBoost(): Promise<{ targetF: number; restoreAt: Date } | null> {
    const res = await this.pool.query(
      `SELECT target_f, restore_at FROM hbx_boosts
       WHERE NOT restored AND restore_at > now() ORDER BY id DESC LIMIT 1`,
    );
    return res.rowCount
      ? { targetF: Number(res.rows[0].target_f), restoreAt: new Date(res.rows[0].restore_at) }
      : null;
  }

  async markBoostsRestored(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await this.pool.query(`UPDATE hbx_boosts SET restored = true WHERE id = ANY($1)`, [ids]);
  }

  async insertPhaseBLog(l: { pumpId: string; mode: string; valueC: number | null; result: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO phase_b_log (pump_id, mode, value_c, result) VALUES ($1,$2,$3,$4)`,
      [l.pumpId, l.mode, l.valueC, l.result],
    );
  }

  async insertAutopilotLog(l: { targetF: number | null; reason: string; result: string; dryRun: boolean }): Promise<void> {
    await this.pool.query(
      `INSERT INTO autopilot_log (target_f, reason, result, dry_run) VALUES ($1,$2,$3,$4)`,
      [l.targetF, l.reason, l.result, l.dryRun],
    );
  }

  async latestAutopilotLog(): Promise<{ ts: Date; targetF: number | null; reason: string; result: string; dryRun: boolean } | null> {
    const r = await this.pool.query(
      `SELECT ts, target_f, reason, result, dry_run FROM autopilot_log ORDER BY id DESC LIMIT 1`,
    );
    if (!r.rowCount) return null;
    const x = r.rows[0];
    return { ts: new Date(x.ts), targetF: x.target_f, reason: x.reason, result: x.result, dryRun: x.dry_run };
  }

  /** Heartbeat the planner's real controller flags each poll so the dashboard shows ground truth. */
  async upsertControllerStatus(s: {
    autopilotEnabled: boolean; autopilotDryRun: boolean; autopilotResult: string | null; autopilotTargetF: number | null;
    phasebEnabled: boolean; phasebDryRun: boolean; phasebResult: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO controller_status
         (id, updated_at, autopilot_enabled, autopilot_dry_run, autopilot_result, autopilot_target_f,
          phaseb_enabled, phaseb_dry_run, phaseb_result)
       VALUES (1, now(), $1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         updated_at = now(),
         autopilot_enabled = EXCLUDED.autopilot_enabled,
         autopilot_dry_run = EXCLUDED.autopilot_dry_run,
         autopilot_result = EXCLUDED.autopilot_result,
         autopilot_target_f = EXCLUDED.autopilot_target_f,
         phaseb_enabled = EXCLUDED.phaseb_enabled,
         phaseb_dry_run = EXCLUDED.phaseb_dry_run,
         phaseb_result = EXCLUDED.phaseb_result`,
      [s.autopilotEnabled, s.autopilotDryRun, s.autopilotResult, s.autopilotTargetF,
       s.phasebEnabled, s.phasebDryRun, s.phasebResult],
    );
  }

  /** Latest learned per-zone physics from TempIQ (§6.7: consumed, never re-derived). */
  async upsertTempiqZonePhysics(zonesIn: Array<{
    zoneId: string; name: string | null; uaBtuHrF: number | null;
    thermalMassBtuF: number | null; emitterType: string | null;
    confidence: number | null; source: string | null;
  }>): Promise<void> {
    for (const z of zonesIn) {
      await this.pool.query(
        `INSERT INTO tempiq_zone_physics
           (zone_id, name, ua_btu_hr_f, thermal_mass_btu_f, emitter_type, confidence, source, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (zone_id) DO UPDATE SET
           name = EXCLUDED.name, ua_btu_hr_f = EXCLUDED.ua_btu_hr_f,
           thermal_mass_btu_f = EXCLUDED.thermal_mass_btu_f,
           emitter_type = EXCLUDED.emitter_type, confidence = EXCLUDED.confidence,
           source = EXCLUDED.source, fetched_at = EXCLUDED.fetched_at`,
        [z.zoneId, z.name, z.uaBtuHrF, z.thermalMassBtuF, z.emitterType, z.confidence, z.source],
      );
    }
  }

  /** Newest stored COP point — the reader's incremental ?since cursor. */
  async latestTempiqCopAt(): Promise<Date | null> {
    const res = await this.pool.query(`SELECT max(measured_at) AS m FROM tempiq_cop_points`);
    return res.rows[0]?.m ? new Date(res.rows[0].m) : null;
  }

  /** Insert-only COP points, deduped on (measured_at, system). Returns rows actually inserted. */
  async insertTempiqCopPoints(points: Array<{
    measuredAt: Date; system: string; outdoorTempF: number | null; sinkTempF: number | null;
    cop: number | null; thermalKwh: number | null; electricalKwh: number | null;
    quality: string | null; qualityScore: number | null;
  }>): Promise<number> {
    let inserted = 0;
    for (const p of points) {
      const res = await this.pool.query(
        `INSERT INTO tempiq_cop_points
           (measured_at, system, outdoor_temp_f, sink_temp_f, cop, thermal_kwh, electrical_kwh, quality, quality_score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (measured_at, system) DO NOTHING`,
        [p.measuredAt, p.system, p.outdoorTempF, p.sinkTempF, p.cop,
         p.thermalKwh, p.electricalKwh, p.quality, p.qualityScore],
      );
      inserted += res.rowCount ?? 0;
    }
    return inserted;
  }

  /** Latest TempIQ zone-energy snapshot (single-row upsert; shadow model picks fields). */
  async upsertTempiqZoneEnergy(payload: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO tempiq_zone_energy (id, fetched_at, payload) VALUES (1, now(), $1)
       ON CONFLICT (id) DO UPDATE SET
         fetched_at = EXCLUDED.fetched_at, payload = EXCLUDED.payload`,
      [JSON.stringify(payload)],
    );
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

  /** gtm#1328: recent quiet-window decay fits, for aggregating the standby UA we push to TempIQ. */
  async getRecentDecayFits(hours: number): Promise<
    { windowStart: Date; windowEnd: Date; tStartF: number; tEndF: number; hours: number; slopeFPerH: number }[]
  > {
    const res = await this.pool.query(
      `SELECT window_start, window_end, t_start_f, t_end_f, hours, slope_f_per_h
       FROM tank_decay_fits
       WHERE window_end >= now() - ($1 || ' hours')::interval
       ORDER BY window_end ASC`,
      [hours],
    );
    return res.rows.map((r) => ({
      windowStart: new Date(r.window_start),
      windowEnd: new Date(r.window_end),
      tStartF: Number(r.t_start_f),
      tEndF: Number(r.t_end_f),
      hours: Number(r.hours),
      slopeFPerH: Number(r.slope_f_per_h),
    }));
  }

  async openUnservedEpisode(detail: string): Promise<void> {
    await this.pool.query(`INSERT INTO unserved_call_episodes (detail) VALUES ($1)`, [detail]);
  }

  async closeUnservedEpisode(): Promise<void> {
    await this.pool.query(
      `UPDATE unserved_call_episodes SET cleared_at = now()
       WHERE cleared_at IS NULL AND id = (SELECT max(id) FROM unserved_call_episodes)`,
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

  async insertStormEvent(trigger: string, detail: unknown, ceilingF: number | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO storm_events (trigger, detail, ceiling_f) VALUES ($1, $2, $3)`,
      [trigger, JSON.stringify(detail), ceilingF],
    );
  }

  async closeStormEvent(): Promise<void> {
    await this.pool.query(
      `UPDATE storm_events SET ended_at = now()
       WHERE ended_at IS NULL AND id = (SELECT max(id) FROM storm_events)`,
    );
  }

  async activeStormEvent(): Promise<{ id: number; startedAt: Date; trigger: string; ceilingF: number | null } | null> {
    const res = await this.pool.query(
      `SELECT id, started_at, trigger, ceiling_f FROM storm_events
       WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`,
    );
    if (!res.rowCount) return null;
    const r = res.rows[0];
    return {
      id: Number(r.id),
      startedAt: new Date(r.started_at),
      trigger: r.trigger,
      ceilingF: r.ceiling_f == null ? null : Number(r.ceiling_f),
    };
  }

  async insertZoneFloorSnapshot(s: {
    ts: Date; zones: unknown; bindingZone: string | null; bindingAwtF: number | null;
    tankTargetF: number | null; source: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO zone_floor_snapshots (ts, zones, binding_zone, binding_awt_f, tank_target_f, source)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (ts) DO NOTHING`,
      [s.ts, JSON.stringify(s.zones), s.bindingZone, s.bindingAwtF, s.tankTargetF, s.source],
    );
  }

  async latestZoneFloorSnapshot(): Promise<{ ts: Date; bindingZone: string | null; bindingAwtF: number | null; tankTargetF: number | null } | null> {
    const res = await this.pool.query(
      `SELECT ts, binding_zone, binding_awt_f, tank_target_f
       FROM zone_floor_snapshots ORDER BY ts DESC LIMIT 1`,
    );
    if (!res.rowCount) return null;
    const r = res.rows[0];
    return {
      ts: new Date(r.ts),
      bindingZone: r.binding_zone == null ? null : String(r.binding_zone),
      bindingAwtF: r.binding_awt_f == null ? null : Number(r.binding_awt_f),
      tankTargetF: r.tank_target_f == null ? null : Number(r.tank_target_f),
    };
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

  /**
   * Heartbeat THIS planner instance and return the ids of OTHER instances seen alive within
   * freshMs. Non-blocking single-writer guard (#36): a non-empty result means a second planner
   * is running against the shared DB and could collide on writes. Prunes rows dead > 1 h so the
   * table can't grow across redeploys.
   */
  async heartbeatInstance(instanceId: string, freshMs: number): Promise<string[]> {
    await this.pool.query(
      `INSERT INTO planner_instances (instance_id, heartbeat_at) VALUES ($1, now())
       ON CONFLICT (instance_id) DO UPDATE SET heartbeat_at = now()`,
      [instanceId],
    );
    await this.pool.query(`DELETE FROM planner_instances WHERE heartbeat_at < now() - interval '1 hour'`);
    const res = await this.pool.query(
      `SELECT instance_id FROM planner_instances WHERE instance_id <> $1 AND heartbeat_at > $2`,
      [instanceId, new Date(Date.now() - freshMs)],
    );
    return res.rows.map((r) => r.instance_id as string);
  }

  /**
   * Renew the single-writer lease if this instance holds it, or CLAIM it if it's unheld or
   * stale (takeover after a crash/redeploy). Atomic via ON CONFLICT ... WHERE; all times come
   * from the DB clock, so there is no client-clock dependency. Returns whether this instance now
   * holds it. Flag-gated caller (WRITER_LEASE_ENABLED); #36 optional defense-in-depth.
   */
  async renewOrClaimLease(instanceId: string, staleMs: number): Promise<{ held: boolean; holder: string | null }> {
    await this.pool.query(
      `INSERT INTO hbx_writer_lease (id, holder, heartbeat_at) VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, heartbeat_at = now()
         WHERE hbx_writer_lease.holder = $1
            OR hbx_writer_lease.holder IS NULL
            OR hbx_writer_lease.heartbeat_at < now() - ($2 * interval '1 millisecond')`,
      [instanceId, staleMs],
    );
    const res = await this.pool.query(`SELECT holder FROM hbx_writer_lease WHERE id = 1`);
    const holder = res.rowCount ? (res.rows[0].holder as string | null) : null;
    return { held: holder === instanceId, holder };
  }

  /** True iff this instance currently holds a FRESH single-writer lease (the write-path gate). */
  async holdsWriterLease(instanceId: string, staleMs: number): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM hbx_writer_lease
       WHERE id = 1 AND holder = $1 AND heartbeat_at > now() - ($2 * interval '1 millisecond')`,
      [instanceId, staleMs],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
