import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminRpcContext } from '../rpc.js';
import { createDatabaseBrowser } from './index.js';
import { databaseRouter } from './router.js';

/**
 * Foreign keys as the catalogue reports them: a key of one column is the column's own pointer, a
 * composite key stays on the table, a key into another schema names that schema, and the target
 * knows who points at it.
 */
const schema = `admin_db_refs_${randomUUID().replaceAll('-', '')}`;
const other = `${schema}_other`;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to run the Admin PostgreSQL tests.');
const database = new pg.Client({ connectionString });
const pool = new pg.Pool({ connectionString, max: 3 });
const api = databaseRouter.createCaller({
  databaseBrowser: createDatabaseBrowser(async () => pool, { ownersAbleToSignIn: async (ids) => [...ids] }),
  repo: {} as AdminRpcContext['repo'], auth: {} as AdminRpcContext['auth'], catalogue: [],
  env: { sessionCookieName: 'session', csrfCookieName: 'admin_csrf', publicOrigin: 'https://example.test' },
  request: new Request('https://example.test/admin/rpc', { headers: { cookie: 'admin_csrf=valid', 'x-csrf-token': 'valid' } }),
  resHeaders: new Headers(),
  adminContext: { userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.test', role: 'owner' },
});

beforeAll(async () => {
  await database.connect();
  await database.query(`CREATE SCHEMA ${quote(schema)}`);
  await database.query(`CREATE SCHEMA ${quote(other)}`);
  await database.query(`CREATE TABLE ${quote(other)}.accounts (id uuid PRIMARY KEY)`);
  await database.query(`CREATE TABLE ${quote(schema)}.parents (id integer PRIMARY KEY, title text)`);
  await database.query(`CREATE TABLE ${quote(schema)}.pairs (a integer, b integer, PRIMARY KEY (a, b))`);
  await database.query(`CREATE TABLE ${quote(schema)}.children (
    id integer PRIMARY KEY,
    parent_id integer REFERENCES ${quote(schema)}.parents (id),
    account_id uuid REFERENCES ${quote(other)}.accounts (id),
    pair_a integer, pair_b integer,
    FOREIGN KEY (pair_a, pair_b) REFERENCES ${quote(schema)}.pairs (a, b))`);
});

afterAll(async () => {
  try {
    await database.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`);
    await database.query(`DROP SCHEMA IF EXISTS ${quote(other)} CASCADE`);
  } finally { await Promise.all([database.end(), pool.end()]); }
});

describe('foreign keys in the catalogue', () => {
  it('gives a single-column key to its column, with the target named by schema', async () => {
    const { tables } = await api.tables({ schema });
    const children = tables.find((table) => table.name === 'children')!;
    const column = (name: string) => children.columns.find((entry) => entry.name === name)!;
    expect(column('parent_id').references).toEqual({ schema, table: 'parents', column: 'id' });
    expect(column('account_id').references).toEqual({ schema: other, table: 'accounts', column: 'id' });
    expect(column('id').references).toBeNull();
  });

  it('keeps a composite key on the table and off its columns', async () => {
    const { tables } = await api.tables({ schema });
    const children = tables.find((table) => table.name === 'children')!;
    expect(children.foreignKeys).toEqual(expect.arrayContaining([
      { columns: ['pair_a', 'pair_b'], target: { schema, table: 'pairs', columns: ['a', 'b'] } },
    ]));
    expect(children.foreignKeys).toHaveLength(3);
    expect(children.columns.find((entry) => entry.name === 'pair_a')!.references).toBeNull();
  });

  it('tells a target who points at it', async () => {
    const { tables } = await api.tables({ schema });
    expect(tables.find((table) => table.name === 'parents')!.referencedBy).toEqual([
      { columns: ['parent_id'], target: { schema, table: 'children', columns: ['id'] } },
    ]);
    expect(tables.find((table) => table.name === 'pairs')!.referencedBy).toEqual([
      { columns: ['pair_a', 'pair_b'], target: { schema, table: 'children', columns: ['a', 'b'] } },
    ]);
    expect(tables.find((table) => table.name === 'children')!.referencedBy).toEqual([]);
    // The other schema's table is pointed at from here, and says so when its own schema is read.
    const { tables: others } = await api.tables({ schema: other });
    expect(others.find((table) => table.name === 'accounts')!.referencedBy).toEqual([
      { columns: ['account_id'], target: { schema, table: 'children', columns: ['id'] } },
    ]);
  });

  it('reports the same pointers on a page of rows', async () => {
    const page = await api.rows({ schema, table: 'children' });
    expect(page.columns.find((entry) => entry.name === 'parent_id')!.references).toEqual({ schema, table: 'parents', column: 'id' });
  });
});
