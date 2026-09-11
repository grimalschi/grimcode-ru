import pg from 'pg';

import { SCHEMA, runMigrations } from './migrator.js';
import { waitForDatabase } from './pool.js';

import type { EmailEnv } from '../env.js';
import { migrations } from './migrations/index.js';
import { seedTemplates } from './seeding.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

// Five modules share this process and the server's 100 connections; the sum is what matters.
const MAX_CONNECTIONS = 5;

/**
 * This module's fixed schema in the installation database, prepared by migrate() before the application starts listening.
 * The same cached opening promise is reused by HTTP handlers and internal callers.
 */
export function createDatabase(env: EmailEnv) {
  let opening: Promise<Pool> | undefined;

  const open = async (): Promise<Pool> => {
    const pool = new pg.Pool({
      connectionString: env.databaseUrl,
      max: MAX_CONNECTIONS,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'email-module',
      // pg-pool awaits this hook before handing out each new connection, including replacements.
      onConnect: async (client) => { await client.query(`SET search_path TO "${SCHEMA}"`); },
    });

    // Empty on purpose: without a listener a broken idle connection takes the whole process down.
    // Nothing is reported — the request that needed the pool fails on its own, and that is visible.
    pool.on('error', () => undefined);

    try {
      await waitForDatabase(pool);
      await runMigrations(pool, migrations);
      await seedTemplates(pool);
    } catch (error) {
      // The attempt is retried, so its connections must not be left behind.
      await pool.end().catch(() => undefined);
      throw error;
    }

    return pool;
  };

  // Concurrent callers share one opening attempt; a failed attempt can be retried.
  return () => (opening ??= open().catch((error: unknown) => {
    opening = undefined;
    throw error;
  }));
}
