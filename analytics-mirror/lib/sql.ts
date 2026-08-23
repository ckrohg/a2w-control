/**
 * @purpose Drop-in replacement for `@vercel/postgres`'s `sql` tagged template, backed
 * by plain node-postgres.
 *
 * `@vercel/postgres` speaks Neon's serverless protocol and cannot talk to an ordinary
 * Postgres server, so it could not follow the analytics DB when it moved from Neon to
 * Railway (Neon's free tier caps compute at 100 CU-hours/month; it hard-refused every
 * connection on 2026-08-19 and took the planner down with it). Railway Postgres is
 * container-billed with no compute-hour cliff.
 *
 * The exported shape is deliberately identical to what the 34 existing call sites
 * already use — `sql`…`` returning { rows, rowCount } — so the migration touches only
 * import lines, not queries.
 */

import { Pool, type QueryResult, type QueryResultRow } from "pg";

/**
 * One pool per warm serverless instance, cached on globalThis and built lazily.
 *
 * Lazy matters: `next build` imports every module to analyze routes, and the build
 * environment has no database URL. Constructing (or worse, throwing) at import time
 * would fail the build rather than the request. A missing URL is a runtime error, on
 * the first query, where it is actionable.
 *
 * Cached on globalThis for two reasons: Next.js re-evaluates modules on hot reload in
 * dev, which would leak a pool per edit; and each warm Vercel instance holds its own
 * pool, so `max` is a per-instance figure, not a global one. Keep it at 2 — this
 * dashboard serves a single household, and Postgres' ~100 connection ceiling is shared
 * with the planner and every concurrent instance.
 */
const globalForPg = globalThis as unknown as { _a2wPool?: Pool };

function getPool(): Pool {
  if (globalForPg._a2wPool) return globalForPg._a2wPool;

  // A2W_DATABASE_URL first, and deliberately so. DATABASE_URL / POSTGRES_URL /
  // DATABASE_URL_UNPOOLED are all owned by the Vercel Marketplace integration that
  // provisioned Neon — removing that integration deletes them. Pointing the dashboard
  // at a variable the integration does not manage means tearing Neon down cannot take
  // the dashboard with it. The others remain as fallbacks for local dev.
  const connectionString =
    process.env.A2W_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error(
      "No database connection string. Set A2W_DATABASE_URL to the Railway Postgres " +
        "TCP-proxy URL — Railway → a2w-hub → Postgres → Variables (RAILWAY_TCP_PROXY_DOMAIN/PORT).",
    );
  }

  const pool = new Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Railway's TCP proxy terminates TLS with a cert that does not chain to a public
    // CA, so verification is off while transport encryption stays on. Local dev over
    // loopback is plaintext.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString)
      ? undefined
      : { rejectUnauthorized: false },
  });

  // An unhandled error on an idle client would otherwise take the process down. Log
  // it and let the next query re-establish.
  pool.on("error", (err) => console.error("[sql] idle client error:", err.message));

  globalForPg._a2wPool = pool;
  return pool;
}

/**
 * Tagged-template query. Interpolated values become $1, $2, … bind parameters — they
 * are never spliced into the SQL text, so this is injection-safe in the same way
 * `@vercel/postgres` was.
 *
 *   const { rows } = await sql`SELECT * FROM readings WHERE ts > ${since}`;
 */
export async function sql<T extends QueryResultRow = QueryResultRow>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<QueryResult<T>> {
  const text = strings.reduce(
    (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ""),
    "",
  );
  return getPool().query<T>(text, values);
}

/**
 * Escape hatch for queries the tagged template cannot express — specifically batched
 * multi-row inserts via UNNEST, where the parameters are arrays rather than scalars.
 *
 * This exists because per-row inserts are a latency trap. Every `sql`…`` is one network
 * round-trip; a 500-row backlog became 500 sequential round-trips, blew past the Pi's
 * 10s client timeout, and left the exporter's cursor permanently stuck — the backlog
 * could never drain because draining it was what timed out. One UNNEST statement moves
 * the same 500 rows in a single round-trip.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export default sql;
