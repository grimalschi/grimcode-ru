import type { Pool, PoolClient } from './database.js';

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
 * Waits for the database server while the module prepares its own schema at application startup.
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
