import pg from 'pg';

import { serviceDatabaseUrl } from '../env.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

/**
 * PostgreSQL pool for one service database.
 *
 * A service may only ever open its own database. Reading or writing another service's database is
 * forbidden; cross-service data goes through HTTP/oRPC contracts.
 */
export function createPool(service: string): Pool {
  const pool = new pg.Pool({
    connectionString: serviceDatabaseUrl(service),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: `${service}-service`,
  });

  // A pool-level error must not take the process down: the pool discards the broken client.
  pool.on('error', (error) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', service, message: 'idle pool client failed', error: error.message })}\n`,
    );
  });

  return pool;
}

/** Runs `handler` inside a transaction, rolling back on any thrown error. */
export async function withTransaction<T>(
  pool: Pool,
  handler: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Waits for the database to accept connections, which matters on a cold local Compose start. */
export async function waitForDatabase(pool: Pool, attempts = 30, delayMs = 1000): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `Database did not become available after ${attempts} attempts: ${String(lastError)}`,
  );
}
