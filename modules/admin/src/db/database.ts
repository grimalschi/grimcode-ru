import pg from 'pg';

import { runMigrations, waitForDatabase } from '@template/shared';

import type { AdminEnv } from '../env.js';
import { migrations } from './migrations/index.js';

export type Pool = pg.Pool;

// Five modules share this process and the server's 100 connections; the sum is what matters.
const MAX_CONNECTIONS = 5;

/**
 * This module's database, prepared on the first request that needs it. No deployment step stands
 * behind it, and the cost of that is a broken migration answering 500 instead of failing a deploy.
 */
export function createDatabase(): (env: AdminEnv) => Promise<Pool> {
  const open = async (env: AdminEnv): Promise<Pool> => {
    await ensureDatabase(env);

    const pool = new pg.Pool({
      connectionString: env.databaseUrl,
      max: MAX_CONNECTIONS,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'admin-service',
    });

    // Empty on purpose: without a listener a broken idle connection takes the whole process down.
    // Nothing is reported — the request that needed the pool fails on its own, and that is visible.
    pool.on('error', () => undefined);

    try {
      await assertOpenedDatabase(pool, env.databaseName);
      await runMigrations(pool, migrations);
    } catch (error) {
      // The attempt is retried, so its connections must not be left behind.
      await pool.end().catch(() => undefined);
      throw error;
    }

    return pool;
  };

  return openOnce(open);
}

/**
 * Remembers the promise, not the value: two requests arriving together share one attempt. A failure
 * is forgotten, so a server that was not up yet is retried instead of refusing until restart.
 */
export function openOnce<TArg, TValue>(
  open: (arg: TArg) => Promise<TValue>,
): (arg: TArg) => Promise<TValue> {
  let opening: Promise<TValue> | undefined;

  return (arg) =>
    (opening ??= open(arg).catch((error: unknown) => {
      opening = undefined;
      throw error;
    }));
}

/** A database cannot be created from inside itself, hence the second connection, closed straight away. */
async function ensureDatabase(env: AdminEnv): Promise<void> {
  const server = new pg.Pool({
    connectionString: env.maintenanceUrl,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'admin-create',
  });

  server.on('error', () => undefined);

  try {
    await waitForDatabase(server);

    const { rowCount } = await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      env.databaseName,
    ]);
    if (rowCount) return;

    try {
      // An identifier cannot be a bound parameter, so it is quoted instead.
      await server.query(`CREATE DATABASE "${env.databaseName.replace(/"/g, '""')}"`);
    } catch (error) {
      // Two instances starting together both find it missing; the loser gets this and wanted it.
      if ((error as { code?: string }).code !== '42P04') throw error;
    }
  } finally {
    await server.end().catch(() => undefined);
  }
}

/**
 * One account opens every database on the server, so this check is the whole of what stands between a
 * mistyped `DATABASE_URL_<MODULE>` and this module's tables appearing in a neighbour's database.
 */
export async function assertOpenedDatabase(pool: Pool, expected: string): Promise<void> {
  const { rows } = await pool.query<{ current_database: string }>('SELECT current_database()');
  const opened = rows[0]?.current_database;
  if (opened !== expected) {
    throw new Error(`Pool opened database "${opened}", expected "${expected}"`);
  }
}
