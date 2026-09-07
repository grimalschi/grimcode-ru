import type pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

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

/**
 * Waits for the server to accept connections, which is what makes a cold start work: `pnpm dev`
 * starts listening without waiting for PostgreSQL, and the local server is started by hand, so the
 * first request can arrive before the database is up. Called by each module while creating its own.
 */
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
