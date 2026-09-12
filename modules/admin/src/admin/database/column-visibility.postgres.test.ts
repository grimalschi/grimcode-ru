import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseBrowser } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required to run Admin PostgreSQL tests.');

const database = new pg.Client({ connectionString: databaseUrl });
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
let connected = false;

beforeAll(async () => { await database.connect(); connected = true; });
afterAll(async () => { if (connected) await database.end(); });

describe('database editor with column-level PostgreSQL privileges', () => {
  it.for(['text', 'domain'])('refuses changes when a %s column is hidden from the catalogue', async (hiddenType, { skip }) => {
    const privileges = await database.query<{ name: string; allowed: boolean }>(
      'SELECT rolname AS name, rolsuper OR rolcreaterole AS allowed FROM pg_roles WHERE rolname = current_user',
    );
    const current = privileges.rows[0]!;
    if (!current.allowed) skip('This test requires a PostgreSQL role with CREATEROLE.');

    const schema = `admin_columns_${randomUUID().replaceAll('-', '')}`;
    const role = `admin_columns_role_${randomUUID().replaceAll('-', '')}`;
    const table = `${quote(schema)}.records`;
    let roleCreated = false;
    let schemaCreated = false;
    let pool: pg.Pool | undefined;
    try {
      await database.query(`CREATE ROLE ${quote(role)} NOLOGIN ADMIN ${quote(current.name)}`);
      roleCreated = true;
      await database.query(`CREATE SCHEMA ${quote(schema)}`);
      schemaCreated = true;
      await database.query(`CREATE DOMAIN ${quote(schema)}.hidden_type AS text`);
      await database.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, value text,
        discarded text, secret ${hiddenType === 'domain' ? `${quote(schema)}.hidden_type` : 'text'})`);
      // Dropped physical attributes must not make an otherwise complete catalogue read-only.
      await database.query(`ALTER TABLE ${table} DROP COLUMN discarded`);
      await database.query(`INSERT INTO ${table} VALUES (1, 'visible', 'hidden original')`);
      await database.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
      await database.query(`GRANT SELECT(id,value), INSERT(id,value), UPDATE(id,value), DELETE ON ${table} TO ${quote(role)}`);
      pool = new pg.Pool({
        connectionString: databaseUrl, max: 1,
        onConnect: async (client) => { await client.query(`SET ROLE ${quote(role)}`); },
      });
      const restrictedPool = pool;
      const editor = createDatabaseBrowser(async () => restrictedPool);
      const target = { schema, table: 'records' };
      const metadata = (await editor.tables({ schema })).tables[0]!;
      expect(metadata.primaryKey).toEqual(['id']);
      expect(metadata.columns.map(({ name }) => name)).toEqual(['id', 'value']);
      expect(metadata.readOnlyReason).toContain('Не все колонки');
      const shown = await editor.rows(target);
      expect(shown.rows).toEqual([{ id: '1', value: 'visible' }]);
      expect(shown.readOnlyReason).toBe(metadata.readOnlyReason);

      await database.query(`UPDATE ${table} SET secret = 'changed after reading' WHERE id = 1`);
      const before = (await database.query(`SELECT * FROM ${table}`)).rows;
      const original = shown.rows[0]!;
      for (const operation of [
        () => editor.insert({ ...target, values: { id: '2', value: 'inserted' } }),
        () => editor.update({ ...target, original, values: { value: 'updated' } }),
        () => editor.delete({ ...target, original }),
      ]) {
        await expect(operation()).rejects.toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('Не все колонки') });
        expect((await database.query(`SELECT * FROM ${table}`)).rows).toEqual(before);
      }

      await database.query(`GRANT SELECT(secret) ON ${table} TO ${quote(role)}`);
      const complete = await editor.rows(target);
      expect(complete.columns.map(({ name }) => name)).toEqual(['id', 'value', 'secret']);
      if (hiddenType === 'text') {
        expect(complete.readOnlyReason).toBeNull();
        await expect(editor.update({ ...target, original: complete.rows[0]!, values: { value: 'allowed' } }))
          .resolves.toEqual({ updated: 1 });
        expect((await database.query(`SELECT secret FROM ${table}`)).rows).toEqual([{ secret: 'changed after reading' }]);
      } else {
        expect(complete.readOnlyReason).toContain('пока не поддерживает');
      }
    } finally {
      await pool?.end();
      try { if (schemaCreated) await database.query(`DROP SCHEMA ${quote(schema)} CASCADE`); }
      finally { if (roleCreated) await database.query(`DROP ROLE ${quote(role)}`); }
    }
  });
});
