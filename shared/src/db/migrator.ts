import { createHash } from 'node:crypto';

import type { Logger } from '../logger.js';
import { withTransaction, type Pool } from './pool.js';

export interface Migration {
  /** Strictly increasing. Versions are never reused or reordered once released. */
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS_TABLE = 'schema_migrations';

/**
 * Versioned migrations.
 *
 * This is deliberately not a startup `CREATE TABLE IF NOT EXISTS`: applied versions are recorded,
 * a fresh database is built from version 1 upwards, an existing database only receives the missing
 * versions, and running the same set again changes nothing.
 */
export async function runMigrations(
  pool: Pool,
  migrations: readonly Migration[],
  logger: Logger,
): Promise<{ applied: number[]; alreadyApplied: number[] }> {
  assertOrdered(migrations);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      version     integer PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query<{ version: number; name: string; checksum: string }>(
    `SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  const known = new Map(rows.map((row) => [row.version, row]));

  const applied: number[] = [];
  const alreadyApplied: number[] = [];

  for (const migration of migrations) {
    const checksum = checksumOf(migration.sql);
    const existing = known.get(migration.version);

    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `Migration ${migration.version} (${migration.name}) was modified after it had been applied. ` +
            'Released migrations are immutable — add a new version instead.',
        );
      }
      alreadyApplied.push(migration.version);
      continue;
    }

    // Advisory lock so parallel service instances never apply the same version twice.
    await withTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [migrationLockKey(migration.version)]);

      const { rowCount } = await client.query(
        `SELECT 1 FROM ${MIGRATIONS_TABLE} WHERE version = $1`,
        [migration.version],
      );
      if (rowCount && rowCount > 0) return;

      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.name, checksum],
      );
    });

    applied.push(migration.version);
    logger.info('migration applied', { version: migration.version, name: migration.name });
  }

  logger.info('migrations up to date', {
    applied: applied.length,
    alreadyApplied: alreadyApplied.length,
    head: migrations.at(-1)?.version ?? 0,
  });

  return { applied, alreadyApplied };
}

export async function appliedVersions(pool: Pool): Promise<number[]> {
  const { rows } = await pool.query<{ version: number }>(
    `SELECT version FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  return rows.map((row) => row.version);
}

function assertOrdered(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (migration.version <= previous) {
      throw new Error(
        `Migration versions must strictly increase; ${migration.version} follows ${previous}`,
      );
    }
    previous = migration.version;
  }
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.trim(), 'utf8').digest('hex');
}

function migrationLockKey(version: number): number {
  // Stable, collision-free enough namespace for a per-service migration table.
  return 0x5f000000 + version;
}
