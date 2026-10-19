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
import type { HbxConfig, FieldChange, PlannerWrite, CurveDiagnosis, ConfigVersionRecord } from "./drift";
import type { PiLinkInputs } from "./pilink";

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

/** Bounds for queries run under the device lock (see Store.locked). */
export const LOCKED_TIMEOUTS_MS = { connect: 10_000, statement: 10_000, query: 15_000 };

export class Store {
  private pool: Pool;
  /**
   * #177 (codex pass 2): the queries that run while the device lock is held (writes.ts withDeviceLock — the writer's
   * self-record, the drift detector's confirmation record) go through this small pool with a SERVER-side
   * statement_timeout below a CLIENT-side query_timeout, and a bounded connect/checkout: a stalled connection fails in bounded time and releases the
   * lock instead of queueing every later PATCH (a restore included) behind it, and any statement the server did
   * run has finished or been cancelled before the client gives up — so a timed-out insert cannot land after a later
   * write's. All of them are single-row reads/inserts; the main pool keeps no timeout, as before.
   */
  private locked: Pool;

  constructor(databaseUrl: string, lockedTimeoutsMs: typeof LOCKED_TIMEOUTS_MS = LOCKED_TIMEOUTS_MS) {
    const ssl = /localhost|127\.0\.0\.1/.test(databaseUrl) ? undefined : { rejectUnauthorized: false };
    this.pool = new Pool({ connectionString: databaseUrl, max: 3, ssl });
    // connectionTimeoutMillis bounds checkout + connection startup (TLS/auth) too (codex pass 3)
    this.locked = new Pool({
      connectionString: databaseUrl, max: 2, ssl,
      connectionTimeoutMillis: lockedTimeoutsMs.connect,
      statement_timeout: lockedTimeoutsMs.statement,
      query_timeout: lockedTimeoutsMs.query,
    });
    // an idle client dropped by the server must not crash the process (the query path already reports its own errors)
    this.locked.on("error", (e) => console.error("store (locked pool) idle client error:", e.message));
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
      -- #177: the drift row must explain itself. raw = the full SensorLinx device object the row was read from
      -- (changeSource / updatedAt / connectedAt kept whole); on a curve diff, reread_raw = the confirmation read
      -- ~30 s later, verdict = echo_suspected | foreign | reverted, diagnosis = the planner's last write, the
      -- writes the echo test used, both read times. Additive; rows before this migration have them NULL.
      ALTER TABLE hbx_config_versions ADD COLUMN IF NOT EXISTS raw        jsonb;
      ALTER TABLE hbx_config_versions ADD COLUMN IF NOT EXISTS reread_raw jsonb;
      ALTER TABLE hbx_config_versions ADD COLUMN IF NOT EXISTS verdict    text;
      ALTER TABLE hbx_config_versions ADD COLUMN IF NOT EXISTS diagnosis  jsonb;
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
      -- #177: the PATCH response echo (written fields + curve + device provenance) — what the device/cloud SAID it
      -- now holds, beside what we asked for. NULL on rejected attempts and on rows before this migration.
      ALTER TABLE hbx_writes ADD COLUMN IF NOT EXISTS response jsonb;
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
      -- #185 / #187: edge-triggered alert episodes with a delivery OUTBOX. kind = stage_unserved | fault_called (key =
      -- the HBX stage) | span_local_stale (key = 'span'). notified_at stays NULL until a channel ACKNOWLEDGED the page
      -- (index.ts ntfyDelivered); every poll re-sends the open, unnotified ones — so a page that failed to deliver is
      -- never silently "already alerted", and a restart re-adopts open episodes instead of re-paging them.
      CREATE TABLE IF NOT EXISTS alert_episodes (
        id          serial PRIMARY KEY,
        uid         text UNIQUE,                 -- client-generated: an insert retried after a lost reply is idempotent
        kind        text NOT NULL,
        key         text NOT NULL,
        pump_id     text,
        started_at  timestamptz NOT NULL DEFAULT now(),
        cleared_at  timestamptz,
        title       text NOT NULL,
        detail      text,
        notified_at timestamptz
      );
      ALTER TABLE alert_episodes ADD COLUMN IF NOT EXISTS uid text UNIQUE;
      CREATE TABLE IF NOT EXISTS hbx_boosts (
        id         serial PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now(),
        target_f   real NOT NULL,
        restore_at timestamptz NOT NULL,
        restored   boolean NOT NULL DEFAULT false
      );
      -- #165: the Pi clock as the PLANNER measures it — planner now − the hub frame's Pi time, recorded each poll
      -- while the Pi is connected (a frame is ≤ ~15 s old). The only planner-clock evidence of the Pi clock over time:
      -- /health.pi trusts a dropout verdict only when aligned observations bracket the window (pilink.ts clockGate).
      CREATE TABLE IF NOT EXISTS pi_clock_observations (
        at       timestamptz PRIMARY KEY DEFAULT now(),
        offset_s real NOT NULL
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

  /**
   * A new boost SUPERSEDES every open one: its write replaced theirs on the device, and its own restore_at now owns
   * the return to the as-found curve. Without this a 15-min boost tapped over a 2-h one expired while the older row
   * still read as active, and the auto-pilot's boost hold kept the shorter boost's target in force for the longer
   * one's whole timer. One statement, so no reader sees both or neither. `restored` is reused for "retired" (no schema
   * change): nothing reads a superseded row's flag except dueBoosts/activeBoost, which must both skip it.
   */
  async insertBoost(targetF: number, restoreAt: Date): Promise<number> {
    const r = await this.pool.query(
      `WITH retired AS (UPDATE hbx_boosts SET restored = true WHERE NOT restored)
       INSERT INTO hbx_boosts (target_f, restore_at) VALUES ($1, $2) RETURNING id`,
      [targetF, restoreAt],
    );
    return Number(r.rows[0].id);
  }

  /** Retire ONE boost row — a boost whose write a restore overtook before its row was recorded (writes.ts boost()). */
  async retireBoost(id: number): Promise<void> {
    await this.pool.query(`UPDATE hbx_boosts SET restored = true WHERE id = $1`, [id]);
  }

  /**
   * A human write replaced the boost (dashboard restore / set target): retire the open rows created BEFORE that write
   * landed — nothing is left to restore for them. Scoped by time, not "every open row", so a delayed retry (the DB was
   * down) cannot retire a newer boost started afterwards, e.g. by a successor planner instance (codex pass 5).
   */
  async retireOpenBoosts(createdBefore: Date): Promise<void> {
    await this.pool.query(`UPDATE hbx_boosts SET restored = true WHERE NOT restored AND created_at <= $1`, [createdBefore]);
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

  // (all alert_episodes queries run on the BOUNDED pool — connect / statement / query timeouts — so persistence can
  // never block paging indefinitely; codex pass 10 on the incident-fixes PR)
  /** #185 / #187: open an alert episode; returns its id (the outbox row). */
  async openAlertEpisode(uid: string, kind: string, key: string, pumpId: string | null, title: string, detail: string): Promise<number> {
    // idempotent on uid (codex pass 8): a retry after a commit whose reply was lost returns the SAME row
    const r = await this.locked.query(
      `INSERT INTO alert_episodes (uid, kind, key, pump_id, title, detail) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (uid) DO UPDATE SET uid = EXCLUDED.uid RETURNING id`,
      [uid, kind, key, pumpId, title, detail]);
    return Number(r.rows[0].id);
  }

  /** Close episodes by their client uid — for an insert whose outcome was never learned. */
  async closeAlertEpisodeUids(uids: string[]): Promise<void> {
    if (!uids.length) return;
    await this.locked.query(`UPDATE alert_episodes SET cleared_at = now() WHERE cleared_at IS NULL AND uid = ANY($1::text[])`, [uids]);
  }

  /** The page for this episode was acknowledged by a channel. */
  async markAlertNotified(id: number): Promise<void> {
    await this.locked.query(`UPDATE alert_episodes SET notified_at = now() WHERE id = $1`, [id]);
  }

  /** Close exactly these episodes (alerts.ts tracks the IDs open for each kind/key — a recurrence is a new ID). */
  async closeAlertEpisodeIds(ids: number[]): Promise<void> {
    if (!ids.length) return;
    await this.locked.query(`UPDATE alert_episodes SET cleared_at = now() WHERE cleared_at IS NULL AND id = ANY($1::int[])`, [ids]);
  }

  /** Episodes still open (a restart re-adopts them so they close instead of re-paging). */
  async openAlertEpisodes(): Promise<{ id: number; uid: string | null; kind: string; key: string; pumpId: string | null }[]> {
    const r = await this.locked.query(`SELECT id, uid, kind, key, pump_id FROM alert_episodes WHERE cleared_at IS NULL ORDER BY id`);
    return r.rows.map((x: any) => ({ id: Number(x.id), uid: x.uid == null ? null : String(x.uid), kind: String(x.kind), key: String(x.key), pumpId: x.pump_id == null ? null : String(x.pump_id) }));
  }

  /** Open episodes whose page no channel has acknowledged yet — re-sent every poll. */
  async undeliveredAlertEpisodes(): Promise<{ id: number; uid: string | null; kind: string; title: string; detail: string | null }[]> {
    const r = await this.locked.query(
      `SELECT id, uid, kind, title, detail FROM alert_episodes WHERE cleared_at IS NULL AND notified_at IS NULL ORDER BY id LIMIT 20`);
    return r.rows.map((x: any) => ({ id: Number(x.id), uid: x.uid == null ? null : String(x.uid), kind: String(x.kind), title: String(x.title), detail: x.detail == null ? null : String(x.detail) }));
  }

  /** Episodes opened in the last 24 h, by kind (/health.unserved). */
  async alertEpisodes24h(): Promise<Record<string, number>> {
    const r = await this.locked.query(
      `SELECT kind, count(*)::int AS n FROM alert_episodes WHERE started_at > now() - interval '24 hours' GROUP BY kind`);
    return Object.fromEntries(r.rows.map((x: any) => [String(x.kind), Number(x.n)]));
  }

  /**
   * #185: active fault CODES per pump from the mirror's pump_snapshots (the Pi attaches each pump's full snapshot every
   * ~5 min, including active_faults [{code, message, severity, since}]). The hub's state frame carries only a COUNT.
   * Non-info severities only. Read-only; an absent table (rehearsal DB) → {}.
   */
  async pumpFaultCodes(): Promise<Record<string, { codes: string[]; ts: number }>> {
    try {
      const r = await this.locked.query(
        `SELECT pump_id, ts::float8 AS ts, snapshot->'active_faults' AS faults FROM pump_snapshots`);
      const out: Record<string, { codes: string[]; ts: number }> = {};
      for (const row of r.rows) {
        const faults = Array.isArray(row.faults) ? row.faults : [];
        const codes: string[] = faults.filter((f: any) => f && typeof f.code === "string" && f.severity !== "info").map((f: any) => String(f.code));
        out[String(row.pump_id)] = { codes: [...new Set(codes)], ts: Number(row.ts) };
      }
      return out;
    } catch (e) {
      if ((e as { code?: string }).code === "42P01") return {};
      throw e;
    }
  }

  /**
   * #187: the newest SPAN LOCAL sample per circuit name (the mirror's span_readings, fed by the Pi's LAN poller; Pi
   * epoch seconds) at ANY age — a planner started during a multi-day outage must still see that reporting stopped
   * (codex pass 1). A loose index scan over (name, ts): one index probe per distinct name, never a table scan. Samples
   * stamped > 2 min ahead of our clock are ignored. null when the table is absent (rehearsal DB).
   */
  async spanLocalLatest(nowS: number): Promise<Record<string, number> | null> {
    try {
      const r = await this.locked.query(
        `WITH RECURSIVE n AS (
           (SELECT name FROM span_readings ORDER BY name LIMIT 1)
           UNION ALL
           SELECT (SELECT s.name FROM span_readings s WHERE s.name > n.name ORDER BY s.name LIMIT 1) FROM n WHERE n.name IS NOT NULL
         )
         SELECT n.name, (SELECT max(s.ts) FROM span_readings s WHERE s.name = n.name AND s.ts <= $1)::float8 AS ts
         FROM n WHERE n.name IS NOT NULL`, [nowS + 120]);
      return Object.fromEntries(r.rows.filter((x: any) => x.ts != null).map((x: any) => [String(x.name), Number(x.ts)]));
    } catch (e) {
      if ((e as { code?: string }).code === "42P01") return null;
      throw e;
    }
  }

  /**
   * #183: close EVERY open storm_events row, not just max(id). Each armed/active transition inserts a row and the
   * state machine is in memory, so restarts while armed (17 deploys Sep 27–Oct 1) left rows open for weeks and the
   * mirror's banner said "armed since 08:33 AM" while /health.storm was idle. A row ends at now() — or, for an orphan
   * whose own window had already ended, at that windowEnd, so the TempIQ window classifier's storm_active lookup
   * (pendingCurveWrites) does not stretch it over the weeks it sat open. `note` lands in detail.closed. Returns the
   * number closed.
   */
  async closeStormEvents(note: string, startedBefore?: Date, endedAt?: Date, clampToWindowEnd = false): Promise<number> {
    // startedBefore scopes the STARTUP sweep / a retried stand-down to rows that existed then: a retry must never close
    // a storm armed meanwhile (codex pass 4). endedAt is the real moment (the stand-down, or the process start for an
    // orphan) — a close retried later still ends the row then (codex passes 6, 8). clampToWindowEnd is for ORPHANS
    // only: an orphan ends at its stored windowEnd if that came first; the CURRENT episode ends at its real stand-down
    // even if an outage extended its window in memory past the stored one (codex pass 8).
    const r = await this.locked.query(
      `UPDATE storm_events SET
         ended_at = GREATEST(started_at, CASE WHEN $4::boolean THEN LEAST(COALESCE($3::timestamptz, now()),
           CASE WHEN detail->>'windowEnd' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (detail->>'windowEnd')::timestamptz ELSE now() END)
           ELSE COALESCE($3::timestamptz, now()) END),
         detail = COALESCE(detail, '{}'::jsonb) || jsonb_build_object('closed', $1::text)
       WHERE ended_at IS NULL AND ($2::timestamptz IS NULL OR started_at < $2::timestamptz)`,
      [note, startedBefore ?? null, endedAt ?? null, clampToWindowEnd],
    );
    return r.rowCount ?? 0;
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
    /** #177: the PATCH response echo (drift.ts patchEcho) — accepted / verify_mismatch only. */
    response?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.locked.query(
      `INSERT INTO hbx_writes (source, action, requested, result, detail, response) VALUES ($1,$2,$3,$4,$5,$6)`,
      [w.source, w.action, JSON.stringify(w.requested), w.result, w.detail, w.response == null ? null : JSON.stringify(w.response)],
    );
  }

  /**
   * #177: the planner's device writes for the foreign-curve verdict — accepted ones and acknowledged verify_mismatch
   * ones — the newest (whenever it was) and every one since `since`, newest first. `requested` is exactly what patch()
   * sent the device.
   */
  async plannerWrites(since: Date): Promise<{ last: PlannerWrite | null; recent: PlannerWrite[] }> {
    const toWrite = (r: any): PlannerWrite => ({
      at: new Date(r.ts).toISOString(), source: String(r.source), action: String(r.action),
      requested: r.requested && typeof r.requested === "object" ? r.requested : null,
      echo: r.response && typeof r.response === "object" ? r.response : null,
      result: String(r.result),
    });
    // verify_mismatch = the PATCH reached the device and was acknowledged with a different echo — still our write
    const [last, recent] = await Promise.all([
      this.locked.query(`SELECT ts, source, action, requested, response, result FROM hbx_writes WHERE result IN ('accepted', 'verify_mismatch') ORDER BY id DESC LIMIT 1`),
      this.locked.query(
        `SELECT ts, source, action, requested, response, result FROM hbx_writes
         WHERE result IN ('accepted', 'verify_mismatch') AND ts >= $1 ORDER BY id DESC LIMIT 50`, [since]),
    ]);
    return { last: last.rowCount ? toWrite(last.rows[0]) : null, recent: recent.rows.map(toWrite) };
  }

  /**
   * #177 (codex passes 4, 11): the newest `unconfirmed` observation not yet settled (no resolved_at). resolved_at is the
   * ONLY settlement signal — PendingTracker stamps it after an acknowledged notice or a DELIVERED confirmed page; a
   * later confirmed row whose page reached nobody must not hide it. index.ts reloads it at boot so a restart between
   * the evidence row and the next poll does not lose the follow-up notice.
   */
  async pendingUnconfirmed(): Promise<CurveDiagnosis | null> {
    const r = await this.pool.query(
      `SELECT diagnosis FROM hbx_config_versions
       WHERE verdict = 'unconfirmed' AND diagnosis IS NOT NULL AND diagnosis->>'resolved_at' IS NULL
       ORDER BY id DESC LIMIT 1`,
    );
    return r.rowCount ? (r.rows[0].diagnosis as CurveDiagnosis) : null;
  }

  /** #177: mark every open `unconfirmed` observation settled (its notice went out, or a confirmed event superseded it). */
  async resolveUnconfirmed(): Promise<void> {
    await this.pool.query(
      `UPDATE hbx_config_versions SET diagnosis = diagnosis || jsonb_build_object('resolved_at', now())
       WHERE verdict = 'unconfirmed' AND diagnosis IS NOT NULL AND diagnosis->>'resolved_at' IS NULL`,
    );
  }

  /**
   * #165: record one Pi-clock observation at its MEASUREMENT time (a delayed write cannot move clock evidence later).
   * Runs on the bounded pool (connect / statement / query timeouts): it is diagnostic and must never hold anything up
   * (codex pass 19). `prune` drops rows older than 9 days.
   */
  async insertPiClockObservation(at: Date, offsetS: number, prune = false): Promise<void> {
    await this.locked.query(`INSERT INTO pi_clock_observations (at, offset_s) VALUES ($1, $2) ON CONFLICT (at) DO NOTHING`, [at, offsetS]);
    if (prune) await this.locked.query(`DELETE FROM pi_clock_observations WHERE at < now() - interval '9 days'`);
  }

  /**
   * #165: what the analytics mirror's own tables say about the Pi link, for pilink.ts. READ-ONLY, on the planner's own
   * connection (no laptop query against production — CLAUDE.md). The mirror owns `readings` and `system_stats` (Pi
   * epoch seconds, ~1 row/min); either may be absent in a DB the mirror never wrote (the rehearsal) → null, never an
   * error. The two heavy reductions run in SQL so the planner only ships a handful of rows: readings gaps (> gapS
   * between consecutive pushes) and reboots (the boot time ts − uptime_s jumping forward by > bootJumpS, with uptime
   * evidence), each with its table's coverage over the range.
   */
  async piLinkInputs(nowMs: number, o: { gapS: number; bootJumpS: number; clockStepS: number; windowS: number; lookbackS: number; futureS: number; settleS: number }): Promise<PiLinkInputs> {
    // the analysis range starts a day before the 7-d window (runs straddling the edge keep their real start) plus an
    // hour of context for the first gap / boot
    const nowS = nowMs / 1000;
    const fromS = nowS - o.windowS - o.lookbackS;
    const absent = (e: unknown) => (e as { code?: string }).code === "42P01"; // undefined_table
    let lastByPump: PiLinkInputs["lastByPump"] = null;
    let readings: PiLinkInputs["readings"] = null;
    let contaminated: { start: number; end: number }[] = [];
    let futureRows = false; // any mirror row stamped ahead of our clock = the Pi clock runs fast NOW
    try {
      // the newest reading per pump over the WHOLE table: a silence longer than the analysis range must keep an
      // honest, growing age rather than drop to null (codex pass 1 on #193); index (pump_id, ts)
      // (future-dated rows — a Pi clock ahead of ours — are left out here too; they are flagged via system_stats)
      const last = await this.pool.query(`SELECT pump_id, max(ts)::float8 AS ts FROM readings WHERE ts <= $1 GROUP BY pump_id`, [nowS + o.futureS]);
      const span = await this.pool.query(
        `SELECT min(ts)::float8 AS first, max(ts)::float8 AS last FROM readings WHERE ts >= $1 AND ts <= $2`, [fromS - 3_600, nowS + o.futureS]);
      const gaps = await this.pool.query(
        `SELECT prev_ts::float8 AS start, ts::float8 AS "end" FROM (
           SELECT ts, lag(ts) OVER (ORDER BY ts) AS prev_ts FROM (SELECT DISTINCT ts FROM readings WHERE ts >= $1 AND ts <= $3) d
         ) g WHERE ts - prev_ts > $2 ORDER BY ts`, [fromS - 3_600, o.gapS, nowS + o.futureS]);
      // readings.id is the mirror's INGESTION order — real arrival time — which system_stats lacks (codex pass 8 on
      // #193). A backward Pi-clock step shows here unambiguously: ts FALLS between consecutive rows of a pump in id
      // order. The span it re-stamps, (new ts, old ts], is clock-contaminated: rows there were stamped twice.
      // The span starts where the clock LEFT real time, not where it returned (codex pass 12 on #193): for a flick
      // (forward jump, then this backward step) that is the last row stamped before the return time — the row just
      // before the forward jump — so the skipped stretch between the two is contaminated too.
      const back = await this.pool.query(
        `SELECT COALESCE((SELECT max(r2.ts) FROM readings r2
                          WHERE r2.pump_id = x.pump_id AND r2.id < x.id AND r2.ts < x.ts), x.ts)::float8 AS start,
                x.prev_ts::float8 AS "end"
         FROM (SELECT id, pump_id, ts, lag(ts) OVER (PARTITION BY pump_id ORDER BY id) AS prev_ts FROM readings WHERE ts >= $1) x
         WHERE x.prev_ts - x.ts > $2 ORDER BY x.ts`, [fromS - 3_600, o.clockStepS]);
      contaminated = back.rows.map((r: any) => ({ start: Number(r.start), end: Number(r.end) }));
      const rf = await this.pool.query(`SELECT EXISTS (SELECT 1 FROM readings WHERE ts > $1) AS f`, [nowS + o.futureS]);
      futureRows ||= rf.rows[0]?.f === true;
      lastByPump = Object.fromEntries(last.rows.map((r: any) => [String(r.pump_id), Number(r.ts)]));
      readings = {
        gaps: gaps.rows.map((r: any) => ({ start: Number(r.start), end: Number(r.end) })),
        firstTs: span.rows[0]?.first == null ? null : Number(span.rows[0].first),
        lastTs: span.rows[0]?.last == null ? null : Number(span.rows[0].last),
        // carried with READINGS, so the evidence holds even when system_stats is absent (codex pass 9 on #193)
        clockIntervals: contaminated,
      };
    } catch (e) { if (!absent(e)) throw e; }
    let latestStat: PiLinkInputs["latestStat"] = null;
    let stats: PiLinkInputs["stats"] = null;
    try {
      const latest = await this.pool.query(`SELECT ts::float8 AS ts, uptime_s::float8 AS uptime_s FROM system_stats WHERE ts <= $1 ORDER BY ts DESC LIMIT 1`, [nowS + o.futureS]);
      const span = await this.pool.query(
        `SELECT min(ts)::float8 AS first, max(ts)::float8 AS last FROM system_stats WHERE ts >= $1 AND ts <= $2 AND uptime_s IS NOT NULL`, [fromS - 3_600, nowS + o.futureS]);
      // a reboot needs UPTIME evidence (pilink.ts BOOT_JUMP_S): certain when uptime fell; ambiguous when the boot time
      // jumped while uptime kept rising but is shorter than the time since the previous sample (a fresh Pi's clock step
      // looks the same) — an NTP step on a long-running Pi is neither
      // A NEW boot must also be later than EVERY boot time seen before it (codex pass 3 on #193): a backward clock
      // step re-orders samples by ts so uptime seems to fall, but the "new" boot time is one already seen.
      // …and no LATER sample may return to a boot track seen BEFORE it (codex pass 5 on #193): a brief forward clock flick
      // displaces a few samples onto a "new" track whose uptime seems to fall, then the old track resumes — that is
      // a clock artefact, kept as ambiguous, never a certain reboot.
      // Samples stamped AHEAD of our clock are quarantined (codex pass 7 on #193): during a forward flick's catch-up
      // they sort after the resumed samples and fake a reboot; and a reboot is certain only once SETTLE_S of later
      // history has stayed on its track — until then it is ambiguous (the window reads unknown, the count lags).
      const b = await this.pool.query(
        `SELECT boot_at::float8 AS at, ts::float8 AS sample_ts, (max_prev_boot + uptime_s)::float8 AS origin,
                (uptime_s < prev_up - 5 AND (min_next_boot IS NULL OR min_next_boot > max_prev_boot + $2)
                 AND last_ts >= ts + $4) AS certain FROM (
           -- every frame is EXPANDING (incremental in Postgres — codex pass 11 on #193: a suffix frame
           -- ROWS 1 FOLLOWING..UNBOUNDED re-scans the rest of the series per row, quadratic): the suffix minimum is an
           -- expanding frame over DESCENDING ts, and the latest ts is one value for the whole set
           SELECT ts, uptime_s, ts - uptime_s AS boot_at,
                  lag(ts) OVER w AS prev_ts, lag(uptime_s) OVER w AS prev_up,
                  max(ts - uptime_s) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS max_prev_boot,
                  min(ts - uptime_s) OVER (ORDER BY ts DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS min_next_boot,
                  max(ts) OVER () AS last_ts
           FROM system_stats WHERE ts >= $1 AND ts <= $3 AND uptime_s IS NOT NULL WINDOW w AS (ORDER BY ts ASC)
         ) s WHERE prev_ts IS NOT NULL AND boot_at > max_prev_boot + $2
             AND (uptime_s < prev_up - 5 OR uptime_s < ts - prev_ts)
         ORDER BY boot_at`, [fromS - 3_600, o.bootJumpS, nowS + o.futureS, o.settleS]);
      const future = await this.pool.query(`SELECT count(*)::int AS n FROM system_stats WHERE ts > $1`, [nowS + o.futureS]);
      // gradual clock movement (codex pass 20): within each boot track (a new track starts where uptime falls), the
      // running sum of SUB-threshold ts-vs-uptime increments is the clock's slew; hourly min/max of it per track let
      // pilink.ts see a bracket the clock moved through by more than CLOCK_STEP_S without any single step. Expanding
      // frames only (incremental).
      const drift = await this.pool.query(
        `WITH s AS (
           SELECT ts, uptime_s, lag(ts) OVER w AS prev_ts, lag(uptime_s) OVER w AS prev_up
           FROM system_stats WHERE ts >= $1 AND ts <= $2 AND uptime_s IS NOT NULL WINDOW w AS (ORDER BY ts)
         ), d AS (
           SELECT ts,
                  CASE WHEN prev_ts IS NULL OR uptime_s < prev_up - 5 THEN 1 ELSE 0 END AS newtrack,
                  CASE WHEN prev_ts IS NULL OR uptime_s < prev_up - 5 THEN 0
                       WHEN abs((ts - prev_ts) - (uptime_s - prev_up)) > $3 THEN 0
                       ELSE (ts - prev_ts) - (uptime_s - prev_up) END AS inc
           FROM s
         ), c AS (
           SELECT ts, sum(newtrack) OVER (ORDER BY ts) AS track, sum(inc) OVER (ORDER BY ts) AS cum FROM d
         )
         SELECT track::int AS track, min(ts)::float8 AS start, max(ts)::float8 AS "end", min(cum)::float8 AS cmin, max(cum)::float8 AS cmax
         FROM c GROUP BY track, floor(ts / 3600) ORDER BY 2`, [fromS - 3_600, nowS + o.futureS, o.clockStepS]);
      futureRows ||= Number(future.rows[0]?.n ?? 0) > 0;
      // clock discontinuities: consecutive samples whose ts advanced unlike uptime (which is real elapsed time) while
      // uptime kept rising — an NTP step either way; a readings gap there may be the step, not a silence
      const steps = await this.pool.query(
        `SELECT ts::float8 AS ts FROM (
           SELECT ts, uptime_s, lag(ts) OVER w AS prev_ts, lag(uptime_s) OVER w AS prev_up
           FROM system_stats WHERE ts >= $1 AND ts <= $3 AND uptime_s IS NOT NULL WINDOW w AS (ORDER BY ts)
         ) s WHERE prev_ts IS NOT NULL AND uptime_s >= prev_up - 5
             AND abs((ts - prev_ts) - (uptime_s - prev_up)) > $2
         ORDER BY ts`, [fromS - 3_600, o.clockStepS, nowS + o.futureS]);
      // stats silences (> gapS between consecutive samples): clock-evolution coverage for pilink.ts — a bracket is only
      // judged where system_stats speaks for the clock (codex pass 21)
      const sgaps = await this.pool.query(
        `SELECT prev_ts::float8 AS start, ts::float8 AS "end" FROM (
           SELECT ts, lag(ts) OVER (ORDER BY ts) AS prev_ts FROM system_stats WHERE ts >= $1 AND ts <= $3 AND uptime_s IS NOT NULL
         ) g WHERE ts - prev_ts > $2 ORDER BY ts`, [fromS - 3_600, o.gapS, nowS + o.futureS]);
      latestStat = latest.rowCount ? { ts: Number(latest.rows[0].ts), uptime_s: latest.rows[0].uptime_s == null ? null : Number(latest.rows[0].uptime_s) } : null;
      // a candidate sampled inside a clock-contaminated span is never certain: its "settled" history may be the
      // displaced samples themselves (codex pass 8 on #193)
      const dirty = (t: number) => contaminated.some((c) => t >= c.start - 60 && t <= c.end + 60);
      // …and only where readings' arrival order COVERS the candidate: without it (table absent, or no readings yet at
      // that time) displaced history cannot be excluded, so nothing is certain (codex pass 9 on #193)
      const arrivalCovers = (t: number) => readings != null && readings.firstTs != null && readings.firstTs <= t - 600
        && readings.lastTs != null && readings.lastTs >= t;
      // Had the candidate been a sample DISPLACED from the previous boot track, it was taken at origin = previous boot +
      // its uptime. A real reboot is only certain if the Pi's pushes were flowing normally at that would-be origin —
      // no readings gap contains it (codex pass 10 on #193: readings missing exactly during a flick bracket the
      // candidate yet prove nothing). An origin older than the analysis range is a clock error of > 8 days: accepted.
      // (the out-of-range exception is against the ANALYSIS boundary, not the first reading: an origin inside the range
      // but before readings begin has no evidence either way — codex pass 13 on #193)
      const originCovered = (o: number) => readings != null && readings.firstTs != null && (o < fromS - 3_600
        || (o >= readings.firstTs && readings.lastTs != null && o <= readings.lastTs
            && !readings.gaps.some((g) => o > g.start - 60 && o < g.end + 60)));
      const certain = (r: any) => r.certain && arrivalCovers(Number(r.sample_ts)) && originCovered(Number(r.origin))
        && !dirty(Number(r.sample_ts));
      stats = {
        boots: b.rows.filter(certain).map((r: any) => ({ at: Number(r.at) })),
        ambiguous: b.rows.filter((r: any) => !certain(r)).map((r: any) => ({ at: Number(r.at) })),
        // future-dated samples ARE a clock discontinuity, at an unknown real time — mark it at now, so a current
        // window cannot read as resolved while they exist
        clockSteps: [...steps.rows.map((r: any) => Number(r.ts)), ...(Number(future.rows[0]?.n ?? 0) > 0 ? [nowS] : [])],
        drift: drift.rows.map((r: any) => ({ track: Number(r.track), start: Number(r.start), end: Number(r.end), cmin: Number(r.cmin), cmax: Number(r.cmax) })),
        gaps: sgaps.rows.map((r: any) => ({ start: Number(r.start), end: Number(r.end) })),
        firstTs: span.rows[0]?.first == null ? null : Number(span.rows[0].first),
        lastTs: span.rows[0]?.last == null ? null : Number(span.rows[0].last),
      };
    } catch (e) { if (!absent(e)) throw e; }
    // phase_b_log is the planner's own: the active-mode rows that say anything about the Pi (a `sent`, or the hub's
    // `no Pi connected` refusal), oldest first, from the lookback start (pilink.ts filters windows by END)
    const pb = await this.pool.query(
      `SELECT (EXTRACT(EPOCH FROM ts) * 1000)::float8 AS ts, result FROM phase_b_log
       WHERE ts >= to_timestamp($1) AND ts <= to_timestamp($2) AND mode = 'active' AND (result = 'sent' OR result LIKE '%no Pi connected%')
       ORDER BY ts`, [fromS, nowS]);
    // a run already OPEN at the range start keeps its real start (codex pass 2 on #193): the first failure after the
    // last `sent` before the boundary, however long ago — prepended, so dropoutRuns opens the run there
    const open = await this.pool.query(
      `SELECT (EXTRACT(EPOCH FROM min(ts)) * 1000)::float8 AS ts FROM phase_b_log
       WHERE mode = 'active' AND result LIKE '%no Pi connected%' AND ts < to_timestamp($1)
         AND ts > COALESCE((SELECT max(ts) FROM phase_b_log
                            WHERE mode = 'active' AND result = 'sent' AND ts < to_timestamp($1)), '-infinity'::timestamptz)`, [fromS]);
    const phaseB = pb.rows.map((r: any) => ({ ts: Number(r.ts), result: String(r.result) }));
    if (open.rows[0]?.ts != null) phaseB.unshift({ ts: Number(open.rows[0].ts), result: "failed: no Pi connected" });
    const obs = await this.pool.query(
      `SELECT EXTRACT(EPOCH FROM at)::float8 AS at, offset_s::float8 AS off FROM pi_clock_observations
       WHERE at >= to_timestamp($1) AND at <= to_timestamp($2) ORDER BY at`, [fromS - 3_600, nowS]);
    const clockObs = obs.rows.map((r: any) => ({ at: Number(r.at), offset: Number(r.off) }));
    return { lastByPump, readings, latestStat, stats, phaseB, futureRows, clockObs };
  }

  /** #177: the newest curve diagnosis on record — seeds /health.drift.last_foreign across restarts. */
  async latestCurveDiagnosis(): Promise<CurveDiagnosis | null> {
    const r = await this.pool.query(
      `SELECT diagnosis FROM hbx_config_versions WHERE verdict IS NOT NULL AND diagnosis IS NOT NULL ORDER BY id DESC LIMIT 1`,
    );
    return r.rowCount ? (r.rows[0].diagnosis as CurveDiagnosis) : null;
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
    const res = await this.locked.query(
      `SELECT config FROM hbx_config_versions ORDER BY id DESC LIMIT 1`,
    );
    return res.rowCount ? (res.rows[0].config as HbxConfig) : null;
  }

  /** The newest version row's config AND raw device object (#177: the "before" provenance for a curve page). */
  async latestConfigVersion(): Promise<{ config: HbxConfig; raw: Record<string, any> | null } | null> {
    const res = await this.locked.query(
      `SELECT config, raw FROM hbx_config_versions ORDER BY id DESC LIMIT 1`,
    );
    return res.rowCount ? { config: res.rows[0].config as HbxConfig, raw: (res.rows[0].raw ?? null) as Record<string, any> | null } : null;
  }

  async insertConfigVersion(
    config: HbxConfig,
    changedFields: Record<string, FieldChange> | null,
    // #177: the raw device object(s) and the curve verdict. Optional so every older call shape still works.
    extra: Pick<ConfigVersionRecord, "raw" | "rereadRaw" | "verdict" | "diagnosis"> = { raw: null },
  ): Promise<void> {
    const j = (v: unknown) => (v == null ? null : JSON.stringify(v));
    await this.locked.query(
      `INSERT INTO hbx_config_versions (changed_fields, config, raw, reread_raw, verdict, diagnosis) VALUES ($1, $2, $3, $4, $5, $6)`,
      [j(changedFields), JSON.stringify(config), j(extra.raw), j(extra.rereadRaw), extra.verdict ?? null, j(extra.diagnosis)],
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
    await Promise.all([this.pool.end(), this.locked.end()]);
  }
}
