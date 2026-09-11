import { createHash } from 'node:crypto';

import { withTransaction } from './pool.js';
import type { Pool } from './database.js';

interface Migration {
  /** Strictly increasing. Versions are never reused or reordered once released. */
  version: number;
  name: string;
  sql: string;
}

export const SCHEMA = 'admin';
const MIGRATIONS_TABLE = 'schema_migrations';
/** Concurrent instances coordinate startup for this schema independently of other modules. */
const MIGRATION_LOCK_KEY = `module-migrations:${SCHEMA}`;

/**
 * Versioned migrations.
 *
 * This is deliberately not a startup `CREATE TABLE IF NOT EXISTS`: applied versions are recorded,
 * a fresh schema is built from version 1 upwards, an existing schema only receives the missing
 * versions, and running the same set again changes nothing.
 */
export async function runMigrations(
  pool: Pool,
  migrations: readonly Migration[],
): Promise<void> {
  assertOrdered(migrations);

  // IF NOT EXISTS alone does not prevent concurrent catalogue insert races.
  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        version     integer PRIMARY KEY,
        name        text NOT NULL,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
  });

  const { rows } = await pool.query<{ version: number; name: string; checksum: string }>(
    `SELECT version, name, checksum FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
  const known = new Map(rows.map((row) => [row.version, row]));

  for (const migration of migrations) {
    const checksum = migrationChecksum(migration.sql);
    const existing = known.get(migration.version);

    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `Migration ${migration.version} (${migration.name}) was modified after it had been applied. ` +
            'Released migrations are immutable — add a new version instead.',
        );
      }
      continue;
    }

    // Advisory lock so parallel module instances never apply the same version twice.
    await withTransaction(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);

      const { rows: current } = await client.query<{ checksum: string }>(
        `SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE version = $1`,
        [migration.version],
      );
      if (current[0]) {
        if (current[0].checksum !== checksum) {
          throw new Error(`Migration ${migration.version} (${migration.name}) was modified after it had been applied.`);
        }
        return;
      }

      await client.query(migration.sql);
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
        [migration.version, migration.name, checksum],
      );
    });
  }
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

/** SHA-256 of trimmed UTF-8 SQL records the exact released statements. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.trim(), 'utf8').digest('hex');
}
