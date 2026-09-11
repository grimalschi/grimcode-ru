import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { Pool } from './database.js';
import { migrationChecksum, runMigrations } from './migrator.js';
import { migrations } from './migrations/index.js';

/** A fixed storage fixture, independent of the checksum implementation under test. */
const SELECT_ONE_SHA256 = 'e004ebd5b5532a4b85984a62f8ad48a81aa3460c1ca07701f386135d72cdecf5';
const migration = { version: 1, name: 'first', sql: 'SELECT 1' };

function databaseWith(versions: { version: number; name: string; checksum: string }[] = []) {
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: vi.fn(),
  };
  const query = vi.fn().mockResolvedValue({ rows: versions, rowCount: versions.length });
  const connect = vi.fn().mockResolvedValue(client);
  return { pool: { query, connect } as unknown as Pool, query, connect, client };
}

describe('notifications migration storage convention', () => {
  it('lists every source migration under its declared version and name', async () => {
    const folder = new URL('./migrations/', import.meta.url);
    const files = readdirSync(folder).filter((file) => file.endsWith('.ts') && file !== 'index.ts');
    const listed = migrations.map((migration) => ({
      file: `${String(migration.version).padStart(3, '0')}-${migration.name}.ts`, migration,
    }));
    expect(files.sort()).toEqual(listed.map(({ file }) => file).sort());
    for (const { file, migration } of listed) {
      const source = await import(new URL(file, folder).href);
      expect(source.migration).toEqual(migration);
    }
  });

  it('hashes trimmed UTF-8 SQL while preserving whitespace inside the statement', () => {
    expect(migrationChecksum(' \nSELECT 1\t')).toBe(SELECT_ONE_SHA256);
    expect(migrationChecksum('SELECT  1')).toBe(
      'a3cf8c9ac0301433082c6dca3df72df4005dcd9d64c17b87d63cc5163a7f5226',
    );
    expect(migrationChecksum("SELECT 'Привет'")).toBe(
      '01c2dfb2e091e63b8477f207211d14891d78781c4d1b839afb0da712fd409a80',
    );
  });

  it('refuses a changed applied migration before executing its SQL', async () => {
    const database = databaseWith([{ ...migration, checksum: SELECT_ONE_SHA256 }]);
    await expect(runMigrations(database.pool, [{ ...migration, sql: 'SELECT 2' }]))
      .rejects.toThrow('modified after it had been applied');
    expect(database.connect).toHaveBeenCalledOnce();
    expect(database.client.query).not.toHaveBeenCalledWith('SELECT 2');
  });

  it('leaves an already-applied unchanged migration alone', async () => {
    const database = databaseWith([{ ...migration, checksum: SELECT_ONE_SHA256 }]);
    await runMigrations(database.pool, [migration]);
    expect(database.connect).toHaveBeenCalledOnce();
  });

  it('locks and rechecks before applying a new version, then records it in the same transaction', async () => {
    const database = databaseWith();
    await runMigrations(database.pool, [migration]);
    const commands = database.client.query.mock.calls.map(([sql]) => String(sql).trim());
    expect(commands.slice(0, 3)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'CREATE SCHEMA IF NOT EXISTS "notifications"',
    ]);
    expect(commands[3]).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    expect(commands[4]).toBe('COMMIT');
    expect(commands.slice(5)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      'SELECT checksum FROM schema_migrations WHERE version = $1',
      'SELECT 1',
      'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      'COMMIT',
    ]);
    expect(database.client.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtext($1))', ['module-migrations:notifications']);
    expect(database.client.query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [1, 'first', SELECT_ONE_SHA256],
    );
    expect(database.client.release).toHaveBeenCalledTimes(2);
  });

  it('rolls back and releases the client when migration SQL fails', async () => {
    const database = databaseWith();
    const failure = new Error('migration failed');
    database.client.query.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT 1') throw failure;
      return { rows: [], rowCount: 0 };
    });

    await expect(runMigrations(database.pool, [migration])).rejects.toBe(failure);
    expect(database.client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(database.client.query.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(1);
    expect(database.client.query.mock.calls.some(([sql]) => String(sql).startsWith('INSERT'))).toBe(false);
    expect(database.client.release).toHaveBeenCalledTimes(2);
  });

  it('refuses a different migration that took the version while waiting for the lock', async () => {
    const database = databaseWith();
    database.client.query.mockImplementation(async (sql: string) => ({
      rows: sql === 'SELECT checksum FROM schema_migrations WHERE version = $1'
        ? [{ checksum: migrationChecksum('SELECT 2') }] : [],
      rowCount: 0,
    }));
    await expect(runMigrations(database.pool, [migration])).rejects.toThrow('modified after it had been applied');
    expect(database.client.query).not.toHaveBeenCalledWith(migration.sql);
    expect(database.client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(database.client.release).toHaveBeenCalledTimes(2);
  });

  it('refuses reused or unordered versions before touching the database', async () => {
    const database = databaseWith();
    await expect(runMigrations(database.pool, [migration, migration]))
      .rejects.toThrow('must strictly increase');
    expect(database.query).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
  });
});
