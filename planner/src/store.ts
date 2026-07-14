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
    `);
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
