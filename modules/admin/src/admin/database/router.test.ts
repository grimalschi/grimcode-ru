import { describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '@template/contracts/modules/auth';
import { adminRouter } from '../router.js';
import type { AdminRpcContext } from '../rpc.js';
import type { AdminRepository } from '../../repository.js';
import { createDatabaseBrowser } from './index.js';

function fixture(role: 'owner' | 'admin' = 'owner') {
  const state = { empty: false, failure: '', invalidOutput: false };
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes('SELECT DISTINCT table_schema')) return {
      rows: [{ name: state.invalidOutput ? 123 : 'auth' }, { name: 'new_module' }], rowCount: 2,
    };
    if (text.includes('information_schema.columns')) return {
      rows: ['records', 'keyless', 'schema_migrations'].flatMap((table) => ['id', 'notes'].map((column) => ({
        table_schema: values[0], table_name: table, column_name: column,
        data_type: column === 'id' ? 'integer' : 'text', is_nullable: column === 'id' ? 'NO' : 'YES',
        is_identity: 'NO', is_generated: 'NEVER', column_default: null,
      }))), rowCount: 6,
    };
    if (text.includes('table_constraints')) return {
      rows: ['records', 'schema_migrations'].map((table) => ({
        table_schema: values[0], table_name: table, column_name: 'id', position: 1,
      })), rowCount: 2,
    };
    if (text.includes('pg_class')) return { rows: [{ estimate: '3' }], rowCount: 1 };
    if (text.includes('count(*)')) return { rows: [{ total: '3' }], rowCount: 1 };
    if (state.failure) throw Object.assign(new Error('Database rejected the operation'), { code: state.failure });
    if (text.startsWith('INSERT')) return { rows: [{ id: values[0], notes: values[1] }], rowCount: 1 };
    if (text.startsWith('UPDATE') || text.startsWith('DELETE')) return { rows: [], rowCount: state.empty ? 0 : 1 };
    return { rows: [{ id: 1, notes: 'stored' }], rowCount: 1 };
  });
  const database = vi.fn(async () => ({ query }));
  const context: AdminRpcContext = {
    databaseBrowser: createDatabaseBrowser(database),
    repo: { findByUserId: vi.fn(async () => ({ role, grants: ['database'] })) } as unknown as AdminRepository,
    auth: {} as AuthApi, catalogue: [],
    env: { sessionCookieName: 'session', csrfCookieName: 'admin_csrf', publicOrigin: 'https://example.test' },
    request: new Request('https://example.test/admin/rpc', {
      headers: { cookie: 'admin_csrf=valid', 'x-csrf-token': 'valid' },
    }),
    resHeaders: new Headers(),
    admin: { userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.test', role, },
  };
  return { state, query, database, context, api: adminRouter.createCaller(context).database };
}

const table = { schema: 'auth', table: 'records' };
const writes = (api: ReturnType<typeof fixture>['api']) => [
  () => api.insert({ ...table, values: { id: 1, notes: 'new' } }),
  () => api.update({ ...table, key: { id: 1 }, values: { notes: 'changed' } }),
  () => api.delete({ ...table, key: { id: 1 } }),
];

describe('owner database procedures', () => {
  it('requires an owner for every operation, irrespective of stored database module grants', async () => {
    const f = fixture('admin');
    for (const admin of [f.context.admin, null]) {
      f.context.admin = admin;
      for (const call of [() => f.api.schemas({}), () => f.api.tables({ schema: 'auth' }), () => f.api.rows(table), ...writes(f.api)]) {
        await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    }
    expect(f.database).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  it('uses the ordinary Admin CSRF cookie and header for all row mutations', async () => {
    const f = fixture();
    for (const token of [null, 'wrong']) {
      if (token === null) f.context.request.headers.delete('x-csrf-token');
      else f.context.request.headers.set('x-csrf-token', token);
      for (const call of writes(f.api)) await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(f.database).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  it('discovers new user schemas and describes tables without exposing migration history', async () => {
    const f = fixture();
    expect(f.database).not.toHaveBeenCalled();
    await expect(f.api.schemas({})).resolves.toEqual({ schemas: [{ name: 'auth' }, { name: 'new_module' }] });
    const { tables } = await f.api.tables({ schema: 'new_module' });
    expect(tables.map(({ name }) => name)).toEqual(['records', 'keyless']);
    expect(tables[0]).toMatchObject({
      schema: 'new_module', primaryKey: ['id'], naturalOrder: null, rows: { count: 3, kind: 'exact' },
      columns: [{ name: 'id', conditions: expect.arrayContaining(['equals']) }, { name: 'notes', conditions: expect.arrayContaining(['contains']) }],
    });
    expect(f.query.mock.calls.some(([sql, values]) => sql.includes('pg_class') && values[1] === 'schema_migrations')).toBe(false);
  });

  it('rejects system schemas, unlisted schemas and history tables on every row operation', async () => {
    const f = fixture();
    for (const schema of ['pg_catalog', 'information_schema', 'missing']) {
      await expect(f.api.tables({ schema })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const hidden = { schema: 'auth', table: 'schema_migrations' };
    for (const call of [
      () => f.api.rows(hidden), () => f.api.insert({ ...hidden, values: {} }),
      () => f.api.update({ ...hidden, key: { id: 1 }, values: { notes: 'x' } }),
      () => f.api.delete({ ...hidden, key: { id: 1 } }),
    ]) await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.query.mock.calls.some(([sql]) => /^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
  });

  it('validates input before querying and validates returned metadata', async () => {
    const f = fixture();
    await expect(f.api.rows({ ...table, order: [{ column: 'id', direction: 'drop' }] } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(f.api.insert({ ...table, values: {}, sql: 'DROP TABLE records' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.query).not.toHaveBeenCalled();
    f.state.invalidOutput = true;
    await expect(f.api.schemas({})).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Output validation failed' });
  });

  it('returns the stored page and performs qualified, parameterized CRUD', async () => {
    const f = fixture();
    const page = await f.api.rows({ ...table, filters: [{ column: 'notes', condition: 'contains', value: "'; DROP TABLE records;--" }] });
    expect(page).toMatchObject({ primaryKey: ['id'], rows: [{ id: 1, notes: 'stored' }], total: 3 });
    const selected = f.query.mock.calls.find(([sql]) => sql.startsWith('SELECT "id"'));
    expect(selected?.[0]).toContain('FROM "auth"."records"');
    expect(selected?.[0]).not.toContain('DROP TABLE');
    expect(selected?.[1]).toContain("%'; DROP TABLE records;--%");
    await expect(f.api.insert({ ...table, values: { id: 2, notes: 'created' } })).resolves.toEqual({ inserted: { id: 2, notes: 'created' } });
    await expect(f.api.update({ ...table, key: { id: 2 }, values: { notes: 'changed' } })).resolves.toEqual({ updated: 1 });
    await expect(f.api.delete({ ...table, key: { id: 2 } })).resolves.toEqual({ deleted: 1 });
  });

  it('allows keyless inserts, refuses ambiguous writes and reports vanished rows', async () => {
    const f = fixture();
    await expect(f.api.insert({ schema: 'auth', table: 'keyless', values: { id: 1 } })).resolves.toMatchObject({ inserted: { id: 1 } });
    await expect(f.api.update({ schema: 'auth', table: 'keyless', key: { id: 1 }, values: { notes: 'x' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(f.api.delete({ schema: 'auth', table: 'keyless', key: { id: 1 } })).rejects.toMatchObject({ code: 'CONFLICT' });
    f.state.empty = true;
    await expect(f.api.update({ ...table, key: { id: 1 }, values: { notes: 'x' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(f.api.delete({ ...table, key: { id: 1 } })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it.each([['22P02', 'BAD_REQUEST'], ['23505', 'BAD_REQUEST'], ['ECONNRESET', 'INTERNAL_SERVER_ERROR'], ['3D000', 'NOT_FOUND']])(
    'maps database failure %s to tRPC %s', async (failure, code) => {
      const f = fixture();
      f.state.failure = failure;
      await expect(f.api.update({ ...table, key: { id: 1 }, values: { notes: 'x' } })).rejects.toMatchObject({ code });
    },
  );
});
