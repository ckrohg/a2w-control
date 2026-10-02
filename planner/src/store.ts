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
import type { PendingCurveWrite, WindowStats, WindowPost } from "./tempiq-windows";
import type { IdentWindow } from "./identify";
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
      -- The last GOOD open-meteo forecast. An hourly step that cannot fetch (HTTP 429 after a deploy
      -- burst, 2026-09-29: four deploys in two hours, then "shadow failed" and a degraded demand feed
      -- for the hour) reuses this instead of skipping the plan + demand-floor refresh.
      CREATE TABLE IF NOT EXISTS forecast_cache (
        id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        fetched_at  timestamptz NOT NULL,
        hours       jsonb NOT NULL
      );
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
        phaseb_result      text,
        auto_sanitize      boolean NOT NULL DEFAULT false
      );
      ALTER TABLE controller_status ADD COLUMN IF NOT EXISTS auto_sanitize boolean NOT NULL DEFAULT false;
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
      -- gtm#1431: latest DHW-vs-space-ISOLATED usage aggregate from TempIQ (/api/insights/dhw-usage).
      -- Enrichment ONLY — winter DHW-vs-space load separation + observability; never gates control.
      CREATE TABLE IF NOT EXISTS tempiq_dhw_usage (
        id         integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        fetched_at timestamptz NOT NULL,
        payload    jsonb NOT NULL
      );
      -- wave plan 2026-10-01 B2b: latest winter scoreboard from TempIQ (/api/insights/winter-scoreboard) — this
      -- winter's kWh per HDD65 vs last winter, same weeks, with the comfort share. Enrichment ONLY (digest +
      -- observability); never gates control. Single row: the payload carries every week of both seasons.
      CREATE TABLE IF NOT EXISTS tempiq_winter_scoreboard (
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
        auto_sanitize     boolean NOT NULL DEFAULT false,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        text
      );
      -- I8 auto-sanitize toggle (Optimize-page switch). INDEPENDENT of mode; env AUTO_SANITIZE_ENABLED
      -- seeds it once, thereafter the switch owns it. ALTER backfills the pre-existing prod row (false).
      ALTER TABLE controller_flags ADD COLUMN IF NOT EXISTS auto_sanitize boolean NOT NULL DEFAULT false;
      -- Per-day REALIZED savings ledger (realized.ts engine). One row per operating day since the
      -- cutover: the measured counterfactual (as-found regime vs actual metered energy). The dashboard
      -- reads + cumulatively charts this instead of the old three-constant static guess.
      CREATE TABLE IF NOT EXISTS realized_savings (
        day                date PRIMARY KEY,
        actual_elec_kwh    real,
        cf_elec_kwh        real,
        cf_fixed_elec_kwh  real,
        saved_usd          real,
        fixed_saved_usd    real,
        smart_premium_usd  real,
        cop_usd            real,
        standby_usd        real,
        element_credit_usd real,
        avg_outdoor_f      real,
        cop_now            real,
        cop_old            real,
        old_buffer_f       real,
        standby_kwh        real,
        sessions           integer,
        confidence         text,
        computed_at        timestamptz NOT NULL DEFAULT now()
      );
      -- v2 columns (fixed-cool + smart-premium) for tables created before they existed.
      ALTER TABLE realized_savings ADD COLUMN IF NOT EXISTS cf_fixed_elec_kwh real;
      ALTER TABLE realized_savings ADD COLUMN IF NOT EXISTS fixed_saved_usd   real;
      ALTER TABLE realized_savings ADD COLUMN IF NOT EXISTS smart_premium_usd real;
      ALTER TABLE realized_savings ADD COLUMN IF NOT EXISTS energy_metered    boolean;
      -- Per-hour metered pump electricity from SPAN (Air-Water 1 + 2 circuits), accumulated by the
      -- spanwatch poll. Lets the realized engine use REAL daily energy instead of the SPAN daily avg.
      -- Value is the hour's cumulative kWh (SPAN resets it each hour) — we keep the max seen per hour.
      CREATE TABLE IF NOT EXISTS span_energy (
        hour timestamptz PRIMARY KEY,
        kwh  real NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      -- a2w#137: which accepted curve writes have been posted to TempIQ as perturbation windows
      -- (tempiq-windows.ts). closed_at NULL = the window is still OPEN on TempIQ's side and will be
      -- re-posted with its closing fields once a later write or a foreign curve change ends it.
      -- last_error records a per-window validation rejection (deterministic — not retried).
      -- identify.ts: every randomised AWT identification window, persisted so a planner restart resumes
      -- or closes it and so the dashboard can show what was drawn. posted_* = TempIQ has the window.
      CREATE TABLE IF NOT EXISTS identification_windows (
        id               serial PRIMARY KEY,
        created_at       timestamptz NOT NULL DEFAULT now(),
        state            text NOT NULL,
        arm              text NOT NULL,
        direction        text NOT NULL,
        zone_ids         text[] NOT NULL,
        band_lo          real NOT NULL,
        band_hi          real NOT NULL,
        magnitude_f      real NOT NULL,
        base_f           real NOT NULL,
        target_f         real NOT NULL,
        cap_f            real NOT NULL,
        draw_probability real NOT NULL,
        draw_seed        text NOT NULL,
        started_at       timestamptz,
        ended_at         timestamptz,
        end_reason       text,
        duration_min     integer NOT NULL,
        write_id         integer,
        dry_run          boolean NOT NULL DEFAULT false,
        posted_open      boolean NOT NULL DEFAULT false,
        posted_closed    boolean NOT NULL DEFAULT false,
        cell             jsonb,
        safe_to_probe    jsonb,
        arming_ticks     integer NOT NULL DEFAULT 0,
        write_attempts   integer NOT NULL DEFAULT 0,
        cleanup_state    text NOT NULL DEFAULT 'none',
        cleanup_detail   text,
        cleanup_attempts integer NOT NULL DEFAULT 0,
        write_accepted   boolean NOT NULL DEFAULT false
      );
      -- Columns added after the table's first cut (codex pass 3: CREATE TABLE IF NOT EXISTS never
      -- alters an existing table). Idempotent; the backfill marks any already-written probe as
      -- accepted so its cleanup is not skipped on upgrade.
      ALTER TABLE identification_windows ADD COLUMN IF NOT EXISTS cleanup_state    text NOT NULL DEFAULT 'none';
      ALTER TABLE identification_windows ADD COLUMN IF NOT EXISTS cleanup_detail   text;
      ALTER TABLE identification_windows ADD COLUMN IF NOT EXISTS cleanup_attempts integer NOT NULL DEFAULT 0;
      ALTER TABLE identification_windows ADD COLUMN IF NOT EXISTS write_accepted   boolean NOT NULL DEFAULT false;
      -- #152: where cleanup returns the plant after plan_moved — the plan's NEW target, persisted so a retried
      -- cleanup never falls back to the obsolete base (codex pass 3).
      ALTER TABLE identification_windows ADD COLUMN IF NOT EXISTS handoff_target_f real;
      UPDATE identification_windows SET write_accepted = true WHERE write_id IS NOT NULL AND NOT write_accepted;
      -- …and the NEWEST already-ended live probe that predates cleanup tracking enters the cleanup queue
      -- (codex pass 4: a backfilled write_accepted row with cleanup_state 'none' was never cleaned). Only
      -- the newest can still be operative; cleanup() itself checks the device and is a no-op when the
      -- plant has since moved on.
      -- ONE-TIME in effect (codex pass 5): every legacy candidate leaves 'none' in the same statement — the
      -- newest becomes 'pending', all older ones become 'done' (superseded) — so a later restart finds no
      -- candidate and can never replay a stale historical probe over current intent.
      UPDATE identification_windows
        SET cleanup_state = CASE WHEN id = (SELECT max(id) FROM identification_windows
                                            WHERE state = 'ended' AND arm = 'probe' AND NOT dry_run AND write_id IS NOT NULL AND cleanup_state = 'none')
                                 THEN 'pending' ELSE 'done' END,
            cleanup_detail = CASE WHEN id = (SELECT max(id) FROM identification_windows
                                             WHERE state = 'ended' AND arm = 'probe' AND NOT dry_run AND write_id IS NOT NULL AND cleanup_state = 'none')
                                  THEN cleanup_detail ELSE 'superseded by a later window (legacy backfill)' END
        WHERE state = 'ended' AND arm = 'probe' AND NOT dry_run AND write_id IS NOT NULL AND cleanup_state = 'none';
      ALTER TABLE controller_flags  ADD COLUMN IF NOT EXISTS identification_mode text NOT NULL DEFAULT 'off';
      ALTER TABLE controller_status ADD COLUMN IF NOT EXISTS identification_mode text;
      ALTER TABLE controller_status ADD COLUMN IF NOT EXISTS identification_result text;
      CREATE TABLE IF NOT EXISTS tempiq_window_posts (
        write_id    integer PRIMARY KEY,
        external_id text NOT NULL,
        kind        text NOT NULL,
        posted_at   timestamptz NOT NULL DEFAULT now(),
        closed_at   timestamptz,
        last_error  text
      );
    `);
  }

  /**
   * Retrying wrapper around ensureSchema() for the long-running service path.
   *
   * The planner is unattended, so a database that is briefly unreachable must not be
   * fatal. It used to be: ensureSchema() threw, main() rejected, and the top-level
   * catch called process.exit(1). Railway gives up after 10 restart attempts and marks
   * the deployment CRASHED — at which point the planner stays dead even after the
   * database recovers. That is exactly how 2026-08-19 played out when Neon's compute
   * quota ran out: a recoverable outage became a four-day silent one.
   *
   * Retry forever with capped backoff instead. Staying alive is what lets the process
   * heal itself the moment the database answers again.
   */
  async ensureSchemaWithRetry(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.ensureSchema();
        if (attempt > 1) console.log(`[store] schema ready after ${attempt} attempts`);
        return;
      } catch (e) {
        // 1s, 2s, 4s … capped at 30s. Never gives up: an unreachable database is a
        // condition to wait out, not a reason to die.
        const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
        console.error(
          `[store] schema not ready (attempt ${attempt}): ${(e as Error).message} — retrying in ${delayMs / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  /** Upsert the pump-circuit energy for the current hour, keeping the MAX seen (SPAN's per-hour
   *  value grows monotonically within the hour, then resets — so the max is the hour's total). */
  async upsertSpanEnergyHour(hour: Date, kwh: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO span_energy (hour, kwh, updated_at) VALUES (date_trunc('hour', $1::timestamptz), $2, now())
       ON CONFLICT (hour) DO UPDATE SET kwh = GREATEST(span_energy.kwh, EXCLUDED.kwh), updated_at = now()`,
      [hour, kwh],
    );
  }

  /** Per-day inputs for the realized-savings engine: real outdoor + current buffer target from
   *  slx_readings, joined to quality-filtered measured COP sessions from tempiq_cop_points. One row
   *  per operating day from the cutover forward (or the lookback window, whichever is later). */
  async getRealizedDayInputs(cutover: string, lookbackDays: number): Promise<{
    day: string; avgOutdoorF: number; nowBufferF: number; coverage: number; spanKwh: number | null;
    measured: { elecKwh: number; thermalKwh: number; cop: number; sinkF: number; sessions: number } | null;
  }[]> {
    const res = await this.pool.query(
      `WITH days AS (
         SELECT to_char(date_trunc('day', ts AT TIME ZONE 'America/New_York'), 'YYYY-MM-DD') AS day,
                avg(outdoor_f) AS out_f, avg(tank_target_f) AS now_buf, count(*) AS n
         FROM slx_readings
         WHERE ts >= GREATEST($1::timestamptz, now() - ($2 || ' days')::interval)
         GROUP BY 1
       ),
       cop AS (
         -- energy-weighted day COP (sum thermal / sum electrical) — more robust than avg-of-sessions,
         -- and makes eActual·copNow == measured thermal exactly.
         SELECT to_char(date_trunc('day', measured_at AT TIME ZONE 'America/New_York'), 'YYYY-MM-DD') AS day,
                sum(electrical_kwh) AS e, sum(thermal_kwh) AS q,
                sum(thermal_kwh) / NULLIF(sum(electrical_kwh), 0) AS cop, avg(sink_temp_f) AS sink, count(*) AS sess
         FROM tempiq_cop_points
         WHERE measured_at >= GREATEST($1::timestamptz, now() - ($2 || ' days')::interval)
           AND cop BETWEEN 1 AND 6 AND thermal_kwh > 0 AND electrical_kwh > 0
           AND sink_temp_f BETWEEN 110 AND 175 AND outdoor_temp_f IS NOT NULL
           AND outdoor_temp_f < sink_temp_f - 20
           AND (quality_score IS NULL OR quality_score >= 0.3)
         GROUP BY 1
       ),
       span AS (
         -- REAL metered pump electricity per day (SPAN Air-Water circuits), summed from the hourly rows.
         SELECT to_char(date_trunc('day', hour AT TIME ZONE 'America/New_York'), 'YYYY-MM-DD') AS day,
                sum(kwh) AS span_kwh
         FROM span_energy
         WHERE hour >= GREATEST($1::timestamptz, now() - ($2 || ' days')::interval)
         GROUP BY 1
       )
       SELECT d.day, d.out_f, d.now_buf, d.n, c.e, c.q, c.cop, c.sink, c.sess, s.span_kwh
       FROM days d LEFT JOIN cop c USING (day) LEFT JOIN span s USING (day)
       WHERE d.out_f IS NOT NULL AND d.now_buf IS NOT NULL
       ORDER BY d.day`,
      [cutover, lookbackDays],
    );
    return res.rows.map((r) => ({
      day: r.day,
      avgOutdoorF: Number(r.out_f),
      nowBufferF: Number(r.now_buf),
      coverage: Math.min(1, Number(r.n) / 288),
      spanKwh: r.span_kwh != null ? Number(r.span_kwh) : null,
      measured: r.sess && Number(r.sess) > 0
        ? { elecKwh: Number(r.e), thermalKwh: Number(r.q), cop: Number(r.cop), sinkF: Number(r.sink), sessions: Number(r.sess) }
        : null,
    }));
  }

  async upsertRealizedDay(r: {
    day: string; actualElecKwh: number; cfElecKwh: number; fixedElecKwh: number; savedUsd: number;
    fixedSavedUsd: number; smartPremiumUsd: number; copUsd: number; standbyUsd: number;
    elementCreditUsd: number; avgOutdoorF: number; copNow: number; copOld: number;
    oldBufferF: number; standbyKwh: number; sessions: number; confidence: string; energyMetered: boolean;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO realized_savings
         (day, actual_elec_kwh, cf_elec_kwh, cf_fixed_elec_kwh, saved_usd, fixed_saved_usd,
          smart_premium_usd, cop_usd, standby_usd, element_credit_usd, avg_outdoor_f, cop_now, cop_old,
          old_buffer_f, standby_kwh, sessions, confidence, energy_metered, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       ON CONFLICT (day) DO UPDATE SET
         actual_elec_kwh = EXCLUDED.actual_elec_kwh, cf_elec_kwh = EXCLUDED.cf_elec_kwh,
         cf_fixed_elec_kwh = EXCLUDED.cf_fixed_elec_kwh, saved_usd = EXCLUDED.saved_usd,
         fixed_saved_usd = EXCLUDED.fixed_saved_usd, smart_premium_usd = EXCLUDED.smart_premium_usd,
         cop_usd = EXCLUDED.cop_usd, standby_usd = EXCLUDED.standby_usd,
         element_credit_usd = EXCLUDED.element_credit_usd, avg_outdoor_f = EXCLUDED.avg_outdoor_f,
         cop_now = EXCLUDED.cop_now, cop_old = EXCLUDED.cop_old, old_buffer_f = EXCLUDED.old_buffer_f,
         standby_kwh = EXCLUDED.standby_kwh, sessions = EXCLUDED.sessions,
         confidence = EXCLUDED.confidence, energy_metered = EXCLUDED.energy_metered, computed_at = now()`,
      [r.day, r.actualElecKwh, r.cfElecKwh, r.fixedElecKwh, r.savedUsd, r.fixedSavedUsd,
       r.smartPremiumUsd, r.copUsd, r.standbyUsd, r.elementCreditUsd, r.avgOutdoorF, r.copNow, r.copOld,
       r.oldBufferF, r.standbyKwh, r.sessions, r.confidence, r.energyMetered],
    );
  }


  /** Seed the runtime autonomy row from the env defaults IF it doesn't exist yet (first boot only).
   *  After that the DB row is authoritative and env changes don't clobber a live choice. */
  async seedControllerFlags(seed: { mode: string; autopilotDryRun: boolean; phasebDryRun: boolean; autoSanitize: boolean; identificationMode?: string }): Promise<void> {
    await this.pool.query(
      `INSERT INTO controller_flags (id, mode, autopilot_dry_run, phaseb_dry_run, auto_sanitize, identification_mode, updated_by)
       VALUES (1, $1, $2, $3, $4, $5, 'env-seed')
       ON CONFLICT (id) DO NOTHING`,
      [seed.mode, seed.autopilotDryRun, seed.phasebDryRun, seed.autoSanitize, seed.identificationMode ?? "off"],
    );
  }

  /** The current effective autonomy flags (runtime override). null before the row is seeded. */
  async getControllerFlags(): Promise<{ mode: string; autopilotDryRun: boolean; phasebDryRun: boolean; autoSanitize: boolean; identificationMode: string } | null> {
    const r = await this.pool.query(
      `SELECT mode, autopilot_dry_run, phaseb_dry_run, auto_sanitize, identification_mode FROM controller_flags WHERE id = 1`,
    );
    if (!r.rowCount) return null;
    const x = r.rows[0];
    return { mode: x.mode, autopilotDryRun: x.autopilot_dry_run, phasebDryRun: x.phaseb_dry_run, autoSanitize: x.auto_sanitize, identificationMode: x.identification_mode ?? "off" };
  }

  /** identify.ts: the runtime identification mode (off | shadow | armed), independent of the autonomy switch. */
  async setIdentificationMode(mode: string, updatedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE controller_flags SET identification_mode = $1, updated_at = now(), updated_by = $2 WHERE id = 1`,
      [mode, updatedBy],
    );
  }

  /** Set the runtime autonomy mode (dashboard Off/Armed switch). Returns the stored row. */
  async setControllerFlags(s: {
    mode: string; autopilotDryRun: boolean; phasebDryRun: boolean; autoSanitize: boolean; updatedBy: string;
  }): Promise<{ mode: string; autopilotDryRun: boolean; phasebDryRun: boolean; autoSanitize: boolean }> {
    await this.pool.query(
      `INSERT INTO controller_flags (id, mode, autopilot_dry_run, phaseb_dry_run, auto_sanitize, updated_at, updated_by)
       VALUES (1, $1, $2, $3, $4, now(), $5)
       ON CONFLICT (id) DO UPDATE SET
         mode = EXCLUDED.mode,
         autopilot_dry_run = EXCLUDED.autopilot_dry_run,
         phaseb_dry_run = EXCLUDED.phaseb_dry_run,
         auto_sanitize = EXCLUDED.auto_sanitize,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by`,
      [s.mode, s.autopilotDryRun, s.phasebDryRun, s.autoSanitize, s.updatedBy],
    );
    return { mode: s.mode, autopilotDryRun: s.autopilotDryRun, phasebDryRun: s.phasebDryRun, autoSanitize: s.autoSanitize };
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
    phasebEnabled: boolean; phasebDryRun: boolean; phasebResult: string | null; autoSanitize: boolean;
    identificationMode?: string | null; identificationResult?: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO controller_status
         (id, updated_at, autopilot_enabled, autopilot_dry_run, autopilot_result, autopilot_target_f,
          phaseb_enabled, phaseb_dry_run, phaseb_result, auto_sanitize, identification_mode, identification_result)
       VALUES (1, now(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         updated_at = now(),
         autopilot_enabled = EXCLUDED.autopilot_enabled,
         autopilot_dry_run = EXCLUDED.autopilot_dry_run,
         autopilot_result = EXCLUDED.autopilot_result,
         autopilot_target_f = EXCLUDED.autopilot_target_f,
         phaseb_enabled = EXCLUDED.phaseb_enabled,
         phaseb_dry_run = EXCLUDED.phaseb_dry_run,
         phaseb_result = EXCLUDED.phaseb_result,
         auto_sanitize = EXCLUDED.auto_sanitize,
         identification_mode = EXCLUDED.identification_mode,
         identification_result = EXCLUDED.identification_result`,
      [s.autopilotEnabled, s.autopilotDryRun, s.autopilotResult, s.autopilotTargetF,
       s.phasebEnabled, s.phasebDryRun, s.phasebResult, s.autoSanitize,
       s.identificationMode ?? null, s.identificationResult ?? null],
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

  /** Latest DHW-vs-space-isolated usage aggregate (gtm#1431) → tempiq_dhw_usage row 1. */
  async upsertTempiqDhwUsage(payload: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO tempiq_dhw_usage (id, fetched_at, payload) VALUES (1, now(), $1)
       ON CONFLICT (id) DO UPDATE SET
         fetched_at = EXCLUDED.fetched_at, payload = EXCLUDED.payload`,
      [JSON.stringify(payload)],
    );
  }

  /** Latest winter scoreboard (wave plan B2b) → tempiq_winter_scoreboard row 1. */
  async upsertTempiqWinterScoreboard(payload: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO tempiq_winter_scoreboard (id, fetched_at, payload) VALUES (1, now(), $1)
       ON CONFLICT (id) DO UPDATE SET
         fetched_at = EXCLUDED.fetched_at, payload = EXCLUDED.payload`,
      [JSON.stringify(payload)],
    );
  }

  /** Recent tank series with call flags — for quiet-window (decay) detection. */
  /** gtm#1616: tank + outdoor series for the reheat-rate scan (tank-reheat-push.ts). */
  async getRecentTankSeries(hours: number): Promise<{ ts: Date; tankF: number | null; outdoorF: number | null }[]> {
    const res = await this.pool.query(
      `SELECT ts, tank_f, outdoor_f FROM slx_readings
       WHERE ts >= now() - ($1 || ' hours')::interval
       ORDER BY ts ASC`,
      [hours],
    );
    return res.rows.map((r) => ({
      ts: new Date(r.ts),
      tankF: r.tank_f == null ? null : Number(r.tank_f),
      outdoorF: r.outdoor_f == null ? null : Number(r.outdoor_f),
    }));
  }
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

  /** #59: energy-weighted COP anchor over quality-filtered points — the same data hygiene as
   *  getRealizedDayInputs (COP bounds, sane sink−outdoor gap, quality_score). null under 5
   *  sessions: the winter DP then falls back to its Carnot-fraction model. */
  async getCopAnchor(days: number): Promise<{ cop: number; sinkF: number; outdoorF: number; sessions: number } | null> {
    const res = await this.pool.query(
      `SELECT sum(thermal_kwh)/NULLIF(sum(electrical_kwh),0) AS cop,
              avg(sink_temp_f) AS sink, avg(outdoor_temp_f) AS outdoor, count(*) AS n
       FROM tempiq_cop_points
       WHERE measured_at >= now() - ($1 || ' days')::interval
         AND cop BETWEEN 1 AND 6 AND thermal_kwh > 0 AND electrical_kwh > 0
         AND sink_temp_f BETWEEN 110 AND 175 AND outdoor_temp_f IS NOT NULL
         AND outdoor_temp_f < sink_temp_f - 20
         AND (quality_score IS NULL OR quality_score >= 0.3)`,
      [days],
    );
    const r = res.rows[0];
    if (!r || r.cop == null || Number(r.n) < 5) return null;
    return { cop: Number(r.cop), sinkF: Number(r.sink), outdoorF: Number(r.outdoor), sessions: Number(r.n) };
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

  /**
   * a2w#137: accepted curve writes that still need a TempIQ post — never posted, or posted OPEN and
   * now closable. Each row carries its closer (the next accepted set_target/restore, or the next
   * FOREIGN dbt/mbt change the drift detector recorded — a config version without `_source`) and
   * the correlates the classifier needs. Only the newest accepted write can lack a closer, so a
   * posted-open row without one is at most a single row and is filtered out here, not re-posted.
   */
  async pendingCurveWrites(limit: number): Promise<PendingCurveWrite[]> {
    const res = await this.pool.query(
      `WITH w AS (
         SELECT h.id, h.ts, h.source, h.action, h.requested, h.detail, p.write_id AS posted_id,
                NULLIF(substring(h.detail from '^target (-?[0-9]+)'), '')::real AS commanded_f,
                LEAST(
                  (SELECT s.ts FROM hbx_writes s
                     WHERE s.id > h.id AND s.result = 'accepted' AND s.action IN ('set_target','restore')
                     ORDER BY s.id LIMIT 1),
                  (SELECT v.observed_at FROM hbx_config_versions v
                     WHERE v.observed_at > h.ts
                       AND (v.changed_fields ? 'dbt' OR v.changed_fields ? 'mbt')
                       AND NOT (v.changed_fields ? '_source')
                     ORDER BY v.observed_at LIMIT 1)
                ) AS closed_at
         FROM hbx_writes h
         LEFT JOIN tempiq_window_posts p ON p.write_id = h.id
         WHERE h.result = 'accepted' AND h.action IN ('set_target','restore')
           AND (p.write_id IS NULL OR p.closed_at IS NULL)
       )
       SELECT w.*,
              (SELECT a.reason FROM autopilot_log a
                 WHERE a.result = 'set'
                   AND a.ts BETWEEN w.ts - interval '24 hours' AND w.ts + interval '10 seconds'
                   AND (w.commanded_f IS NULL OR a.target_f IS NULL OR abs(a.target_f - w.commanded_f) <= 0.5)
                 ORDER BY a.ts DESC LIMIT 1) AS reason,
              EXISTS (SELECT 1 FROM storm_events e
                        WHERE e.started_at <= w.ts AND (e.ended_at IS NULL OR e.ended_at >= w.ts)) AS storm_active,
              EXISTS (SELECT 1 FROM hbx_boosts b
                        WHERE b.created_at BETWEEN w.ts - interval '5 seconds' AND w.ts + interval '60 seconds'
                          AND (w.commanded_f IS NULL OR abs(b.target_f - w.commanded_f) <= 0.5)) AS boost_matched
       FROM w
       WHERE w.posted_id IS NULL OR w.closed_at IS NOT NULL
       ORDER BY w.id
       LIMIT $1`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      ts: new Date(r.ts),
      source: String(r.source),
      action: r.action === "restore" ? "restore" : "set_target",
      requested: r.requested ?? null,
      detail: r.detail == null ? null : String(r.detail),
      commandedTargetF: r.commanded_f == null ? null : Number(r.commanded_f),
      closedAt: r.closed_at == null ? null : new Date(r.closed_at),
      reason: r.reason == null ? null : String(r.reason),
      stormActive: r.storm_active === true,
      boostMatched: r.boost_matched === true,
    }));
  }

  /** a2w#137: the dose actually delivered over a window — mean tank temp, adoption compliance
   *  (operative target within 3 °F of the commanded one), outdoor band. `to` null = until now. */
  async windowStats(from: Date, to: Date | null, commandedTargetF: number | null): Promise<WindowStats> {
    const res = await this.pool.query(
      `SELECT avg(tank_f)::float8 AS achieved_awt_f,
              min(outdoor_f)::float8 AS outdoor_low_f,
              max(outdoor_f)::float8 AS outdoor_high_f,
              CASE WHEN $3::real IS NULL THEN NULL
                   ELSE avg(CASE WHEN tank_target_f IS NULL THEN NULL
                                 WHEN abs(tank_target_f - $3::real) <= 3 THEN 1.0 ELSE 0.0 END)::float8 END AS compliance,
              count(*)::int AS samples
       FROM slx_readings
       WHERE ts >= $1 AND ts < COALESCE($2::timestamptz, now())`,
      [from, to, commandedTargetF],
    );
    const r = res.rows[0] ?? {};
    const num = (v: unknown): number | null => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
    return {
      achievedAwtF: num(r.achieved_awt_f),
      compliance: num(r.compliance),
      outdoorLowF: num(r.outdoor_low_f),
      outdoorHighF: num(r.outdoor_high_f),
      samples: Number(r.samples ?? 0),
    };
  }

  /** a2w#137: the floor snapshot nearest a write (±15 min) — its `zones` jsonb names who was calling. */
  async zoneFloorSnapshotNear(ts: Date): Promise<unknown | null> {
    const res = await this.pool.query(
      `SELECT zones FROM zone_floor_snapshots
       WHERE ts BETWEEN $1::timestamptz - interval '15 minutes' AND $1::timestamptz + interval '15 minutes'
       ORDER BY abs(extract(epoch from (ts - $1::timestamptz))) LIMIT 1`,
      [ts],
    );
    return res.rowCount ? res.rows[0].zones ?? null : null;
  }

  // ── identify.ts: identification windows ──
  private rowToIdentWindow(r: any): IdentWindow {
    const num = (v: unknown) => (v == null ? null : Number(v));
    return {
      id: Number(r.id), createdAt: new Date(r.created_at), state: r.state, arm: r.arm, direction: r.direction,
      zoneIds: Array.isArray(r.zone_ids) ? r.zone_ids.map(String) : [],
      bandLo: Number(r.band_lo), bandHi: Number(r.band_hi), magnitudeF: Number(r.magnitude_f), baseF: Number(r.base_f),
      targetF: Number(r.target_f), capF: Number(r.cap_f), drawProbability: Number(r.draw_probability), drawSeed: String(r.draw_seed),
      startedAt: r.started_at ? new Date(r.started_at) : null, endedAt: r.ended_at ? new Date(r.ended_at) : null,
      endReason: r.end_reason == null ? null : String(r.end_reason), durationMin: Number(r.duration_min),
      writeId: num(r.write_id), writeAccepted: r.write_accepted === true, dryRun: r.dry_run === true, postedOpen: r.posted_open === true, postedClosed: r.posted_closed === true,
      cell: r.cell ?? null, safeToProbe: r.safe_to_probe ?? null, armingTicks: Number(r.arming_ticks ?? 0), writeAttempts: Number(r.write_attempts ?? 0),
      cleanupState: (r.cleanup_state ?? "none") as IdentWindow["cleanupState"], cleanupDetail: r.cleanup_detail == null ? null : String(r.cleanup_detail),
      cleanupAttempts: Number(r.cleanup_attempts ?? 0),
      handoffTargetF: r.handoff_target_f == null ? null : Number(r.handoff_target_f),
    };
  }
  async openIdentificationWindow(): Promise<IdentWindow | null> {
    const r = await this.pool.query(`SELECT * FROM identification_windows WHERE state IN ('arming','pending_write','active') ORDER BY id DESC LIMIT 1`);
    return r.rowCount ? this.rowToIdentWindow(r.rows[0]) : null;
  }
  async lastIdentificationWindowEnd(includeDryRun = false): Promise<Date | null> {
    // Only windows that HAPPENED start the cooldown: a hold arm, a probe whose write was accepted, or (in shadow)
    // a shadow window — never a row the interlock refused before anything was commanded (codex on #153: one
    // transient 503 after an arming delay would otherwise silence draws for an hour while the same failure at
    // draw time costs nothing).
    const r = await this.pool.query(
      `SELECT max(ended_at) AS t FROM identification_windows
       WHERE state = 'ended' AND ended_at IS NOT NULL AND (NOT dry_run OR $1)
         AND coalesce(end_reason, '') NOT LIKE 'interlock:%'
         AND (dry_run OR arm = 'hold' OR write_accepted)`,
      [includeDryRun],
    );
    return r.rows[0]?.t ? new Date(r.rows[0].t) : null;
  }
  async insertIdentificationWindow(w: Omit<IdentWindow, "id">): Promise<number> {
    const r = await this.pool.query(
      `INSERT INTO identification_windows
         (created_at, state, arm, direction, zone_ids, band_lo, band_hi, magnitude_f, base_f, target_f, cap_f, draw_probability, draw_seed,
          started_at, ended_at, end_reason, duration_min, write_id, dry_run, posted_open, posted_closed, cell, safe_to_probe, arming_ticks, write_attempts,
          cleanup_state, cleanup_detail, cleanup_attempts, write_accepted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING id`,
      [w.createdAt ?? new Date(), w.state, w.arm, w.direction, w.zoneIds, w.bandLo, w.bandHi, w.magnitudeF, w.baseF, w.targetF, w.capF, w.drawProbability, w.drawSeed,
       w.startedAt, w.endedAt, w.endReason, w.durationMin, w.writeId, w.dryRun, w.postedOpen, w.postedClosed,
       JSON.stringify(w.cell ?? null), JSON.stringify(w.safeToProbe ?? null), w.armingTicks, w.writeAttempts,
       w.cleanupState ?? "none", w.cleanupDetail ?? null, w.cleanupAttempts ?? 0, w.writeAccepted === true],
    );
    return Number(r.rows[0].id);
  }
  async updateIdentificationWindow(id: number, patch: Partial<Omit<IdentWindow, "id">>): Promise<void> {
    const cols: Record<string, string> = {
      state: "state", endedAt: "ended_at", endReason: "end_reason", startedAt: "started_at", writeId: "write_id",
      postedOpen: "posted_open", postedClosed: "posted_closed", armingTicks: "arming_ticks", writeAttempts: "write_attempts",
      cleanupState: "cleanup_state", cleanupDetail: "cleanup_detail", cleanupAttempts: "cleanup_attempts", writeAccepted: "write_accepted",
      handoffTargetF: "handoff_target_f",
    };
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k]; if (!col) continue;
      vals.push(v); sets.push(`${col} = $${vals.length}`);
    }
    if (!sets.length) return;
    vals.push(id);
    await this.pool.query(`UPDATE identification_windows SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
  }
  async unpostedIdentificationWindows(): Promise<IdentWindow[]> {
    const r = await this.pool.query(
      `SELECT * FROM identification_windows
       WHERE NOT dry_run AND ((state = 'ended' AND NOT posted_closed) OR (state = 'active' AND NOT posted_open))
       ORDER BY id LIMIT 20`,
    );
    return r.rows.map((x) => this.rowToIdentWindow(x));
  }
  /** Ended LIVE probes whose plant has not been confirmed back at base (identify.ts cleanup retry). */
  async cleanupPendingIdentificationWindows(): Promise<IdentWindow[]> {
    const r = await this.pool.query(`SELECT * FROM identification_windows WHERE state = 'ended' AND cleanup_state = 'pending' ORDER BY id LIMIT 20`);
    return r.rows.map((x) => this.rowToIdentWindow(x));
  }
  async recentIdentificationWindows(n: number): Promise<IdentWindow[]> {
    const r = await this.pool.query(`SELECT * FROM identification_windows ORDER BY id DESC LIMIT $1`, [n]);
    return r.rows.map((x) => this.rowToIdentWindow(x));
  }
  /** identify.ts: the ACCEPTED audit row for one window's probe write, by its per-window source token (exact). */
  async acceptedWriteFor(source: string): Promise<{ id: number; ts: Date; targetF: number | null } | null> {
    const r = await this.pool.query(
      `SELECT id, ts, detail FROM hbx_writes
       WHERE source = $1 AND action = 'set_target' AND result = 'accepted'
       ORDER BY id DESC LIMIT 1`,
      [source],
    );
    if (!r.rowCount) return null;
    const m = String(r.rows[0].detail ?? "").match(/^target (-?\d+(?:\.\d+)?)°F commanded/);
    return { id: Number(r.rows[0].id), ts: new Date(r.rows[0].ts), targetF: m ? Number(m[1]) : null };
  }
  async latestAcceptedWriteId(source: string): Promise<number | null> {
    const r = await this.pool.query(`SELECT id FROM hbx_writes WHERE source = $1 AND result = 'accepted' ORDER BY id DESC LIMIT 1`, [source]);
    return r.rowCount ? Number(r.rows[0].id) : null;
  }

  /** a2w#137: record what was posted (upsert — a close re-posts the same write_id). */
  async markWindowPosts(posts: WindowPost[]): Promise<void> {
    if (!posts.length) return;
    await this.pool.query(
      `INSERT INTO tempiq_window_posts (write_id, external_id, kind, posted_at, closed_at, last_error)
       SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::text[])
       ON CONFLICT (write_id) DO UPDATE
         SET posted_at = EXCLUDED.posted_at, closed_at = EXCLUDED.closed_at, last_error = EXCLUDED.last_error`,
      [
        posts.map((p) => p.writeId),
        posts.map((p) => p.externalId),
        posts.map((p) => p.kind),
        posts.map(() => new Date()),
        posts.map((p) => p.closedAt),
        posts.map((p) => p.lastError),
      ],
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

  /**
   * Persist the last good forecast (single row) so an hourly fetch failure can fall back to it.
   * Bounded SERVER-SIDE (SET LOCAL statement_timeout / lock_timeout on a dedicated client): a row lock
   * or a slow server ends the statement in Postgres, so the pooled connection is released and the
   * planner's other queries are never starved by a stuck cache write (codex, #147 pass 2). The caller
   * does not await this on the live path; a failure here only warns.
   */
  async saveForecast(hours: { ts: Date; outdoorF: number }[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query(
        `INSERT INTO forecast_cache (id, fetched_at, hours) VALUES (1, now(), $1)
         ON CONFLICT (id) DO UPDATE SET fetched_at = EXCLUDED.fetched_at, hours = EXCLUDED.hours`,
        [JSON.stringify(hours.map((h) => ({ ts: h.ts.toISOString(), outdoorF: h.outdoorF })))],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async loadForecast(): Promise<{ fetchedAt: Date; hours: { ts: Date; outdoorF: number }[] } | null> {
    const res = await this.pool.query(`SELECT fetched_at, hours FROM forecast_cache WHERE id = 1`);
    if (!res.rowCount) return null;
    const raw = res.rows[0].hours as { ts: string; outdoorF: number }[];
    return {
      fetchedAt: new Date(res.rows[0].fetched_at),
      hours: raw.map((h) => ({ ts: new Date(h.ts), outdoorF: Number(h.outdoorF) })).filter((h) => Number.isFinite(h.ts.getTime()) && Number.isFinite(h.outdoorF)),
    };
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

  /**
   * #136: raise ONE block of the LATEST shadow plan in place (the block with this `ts`), so every
   * reader of the plan — auto-pilot, Phase B lead, the poster, /health — sees the same raised target.
   *
   * ATOMIC and RAISES-ONLY by construction: a single conditional UPDATE whose WHERE (the stored block is
   * still below `tank_target_f`) and SET (rebuilt from the row's own `plan`) are both evaluated on the
   * row version the UPDATE locks — under READ COMMITTED a concurrent raise that committed first makes
   * this one re-evaluate against the new version and no-op if it is no longer a raise. Two overlapping
   * raises therefore leave the MAXIMUM, never a stale lower copy (codex, #149). If the hourly replan
   * inserted a newer plan between our "latest" read and the update, the raise is re-applied to that
   * plan under the same condition (it may already carry the floor from its own sample, in which case
   * it is a no-op). A bank / pre-boost the floor overtakes loses its flag (one identity per block, #148).
   */
  async raiseLatestPlanBlock(
    ts: string,
    patch: { tank_target_f: number; hp1_setpoint_f: number; reason: string },
    note: Record<string, unknown>,
  ): Promise<{ applied: boolean; planId: number | null; movedToNewerPlan: boolean }> {
    const patchJson = JSON.stringify({ tank_target_f: patch.tank_target_f, hp1_setpoint_f: patch.hp1_setpoint_f, reason: patch.reason });
    // `from` is filled in SQL from the row's own block (the value the raise actually replaced), not from the caller.
    const noteJson = JSON.stringify({ ts, to: patch.tank_target_f, ...note });
    let movedToNewerPlan = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await this.pool.query(`SELECT id FROM shadow_plans ORDER BY computed_at DESC LIMIT 1`);
      if (!latest.rowCount) return { applied: false, planId: null, movedToNewerPlan };
      const id = latest.rows[0].id as number;
      const res = await this.pool.query(
        `UPDATE shadow_plans p SET
           plan = (SELECT jsonb_agg(CASE WHEN e->>'ts' = $1 THEN ((e - 'bank' - 'boost') || $2::jsonb) ELSE e END ORDER BY o)
                   FROM jsonb_array_elements(p.plan) WITH ORDINALITY AS t(e, o)),
           meta = coalesce(p.meta, '{}'::jsonb)
                  || jsonb_build_object('floor_raises', coalesce(p.meta->'floor_raises', '[]'::jsonb)
                       || ($3::jsonb || jsonb_build_object('from', (SELECT (e->>'tank_target_f')::float8 FROM jsonb_array_elements(p.plan) e WHERE e->>'ts' = $1 LIMIT 1))))
         WHERE p.id = $4
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.plan) e
                       WHERE e->>'ts' = $1 AND (e->>'tank_target_f')::float8 < $5)
         RETURNING p.id`,
        [ts, patchJson, noteJson, id, patch.tank_target_f],
      );
      const applied = (res.rowCount ?? 0) > 0;
      // Still the latest plan? If the hourly replan slipped a newer one in, apply there too.
      const again = await this.pool.query(`SELECT id FROM shadow_plans ORDER BY computed_at DESC LIMIT 1`);
      if (again.rows[0]?.id === id) return { applied, planId: id, movedToNewerPlan };
      movedToNewerPlan = true;
    }
    return { applied: false, planId: null, movedToNewerPlan };
  }

  /**
   * #136: the floor raises recorded in plan meta over the last `hours` — the PERSISTED history behind
   * /health.demand_floor_cadence, so it survives a redeploy and expires without a later raise (codex).
   */
  async recentFloorRaises(hours: number): Promise<{ at: string; ts: string; from: number; to: number }[]> {
    // The time filter on `at` is done here, not in SQL: a malformed `at` must drop that entry, never
    // fail the whole read (a ::timestamptz cast would). Plans older than the window + 1 h cannot hold
    // a raise inside it, so the row scan is bounded by computed_at.
    const res = await this.pool.query(
      `SELECT r AS raise
       FROM shadow_plans p, jsonb_array_elements(coalesce(p.meta->'floor_raises', '[]'::jsonb)) AS r
       WHERE p.computed_at >= now() - ($1 || ' hours')::interval - interval '1 hour'
         AND jsonb_typeof(coalesce(p.meta->'floor_raises', '[]'::jsonb)) = 'array'`,
      [hours],
    );
    const since = Date.now() - hours * 3600_000;
    return res.rows
      .map((row) => row.raise as { at?: unknown; ts?: unknown; from?: unknown; to?: unknown })
      .filter((r) => r && typeof r.at === "string" && Number.isFinite(Date.parse(r.at)) && Date.parse(r.at) >= since && typeof r.ts === "string")
      .map((r) => ({ at: String(r.at), ts: String(r.ts), from: Number(r.from), to: Number(r.to) }))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
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

  /**
   * Release the single-writer lease ONLY if this instance still holds it — a departing or stale holder must never
   * clear a successor's lease (the WHERE makes a late release harmless). The successor's claim path already honours
   * an unheld row immediately (`holder IS NULL`), so a clean exit hands over in seconds instead of the 12-min
   * staleness wait (handovers measured 649–981 s on 2026-10-01). Returns whether a row was released.
   */
  async releaseWriterLease(instanceId: string): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE hbx_writer_lease SET holder = NULL, heartbeat_at = now() WHERE id = 1 AND holder = $1`,
      [instanceId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Forget this instance's heartbeat row on a clean exit so the successor's peer check is not fooled for an hour. */
  async dropInstance(instanceId: string): Promise<void> {
    await this.pool.query(`DELETE FROM planner_instances WHERE instance_id = $1`, [instanceId]);
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
