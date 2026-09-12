import { describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '@template/contracts/modules/auth';
import type { Pool } from '../../db/database.js';
import { adminRouter } from '../router.js';
import type { AdminRpcContext } from '../rpc.js';
import type { AdminRepository } from '../../repository.js';
import { createDatabaseBrowser } from './index.js';
import { valuesSchema } from './schemas.js';

function fixture(role: 'owner' | 'admin' = 'owner') {
  const state = {
    row: { id: '1', notes: 'stored' } as Record<string, string | null>,
    empty: false, failure: '', invalidOutput: false, canonical: false, changedAfter: false,
    affected: 1, unsafe: false, cascade: false, encoding: 'UTF8', completeColumns: true as boolean | undefined,
  };
  const asked: { text: string; values: unknown[] }[] = [];
  const query = vi.fn(async (input: string | { text: string; values?: unknown[] }, args: unknown[] = []) => {
    const text = typeof input === 'string' ? input : input.text;
    const values = typeof input === 'string' ? args : input.values ?? [];
    asked.push({ text, values });
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|LOCK TABLE)/.test(text)) return { rows: [], rowCount: 0 };
    if (text.includes('SELECT DISTINCT table_schema')) return {
      rows: [{ name: state.invalidOutput ? 123 : 'auth' }, { name: 'new_module' }], rowCount: 2,
    };
    if (text.includes('information_schema.columns')) return {
      rows: ['records', 'keyless', 'schema_migrations'].flatMap((table) => ['id', 'notes'].map((column) => ({
        table_schema: values[0], table_name: table, column_name: column,
        data_type: column === 'id' ? 'integer' : 'text', is_nullable: column === 'id' ? 'NO' : 'YES',
        is_identity: 'NO', is_generated: 'NEVER', column_default: null,
        server_encoding: state.encoding, sql_type: column === 'id' ? 'integer' : 'text', type_name: column === 'id' ? 'int4' : 'text',
        type_schema: 'pg_catalog', type_kind: 'b', element_name: null, element_schema: null, element_kind: null,
        complete_columns: state.completeColumns,
        unsafe_relation: state.unsafe, unsafe_code: false, cascading_delete: state.cascade, cascading_update: false,
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
    if (text.startsWith('SELECT $')) {
      const names = [...text.matchAll(/ AS "([^"]+)"/g)].map((match) => match[1]);
      return { rows: [Object.fromEntries(names.map((name, index) => [name, state.canonical ? 'normalized' : values[index]]))], rowCount: 1 };
    }
    if (text.startsWith('INSERT')) {
      const names = /\(([^)]*)\) VALUES/.exec(text)![1]!.split(', ').map((name) => name.slice(1, -1));
      state.row = { notes: null, ...Object.fromEntries(names.map((name, index) => [name, values[index]])) };
      return { rows: [{ ...state.row }], rowCount: state.affected };
    }
    if (text.startsWith('UPDATE')) {
      const names = [...text.matchAll(/"([^"]+)" = \$\d+/g)].slice(0, -1).map((match) => match[1]);
      state.row = { ...state.row, ...Object.fromEntries(names.map((name, index) => [name, values[index]])) };
      return { rows: [{ ...state.row, ...(state.changedAfter ? { id: 'unexpected' } : {}) }], rowCount: state.affected };
    }
    if (text.startsWith('DELETE')) return { rows: [], rowCount: state.affected };
    return { rows: state.empty ? [] : [{ ...state.row }], rowCount: state.empty ? 0 : 1 };
  });
  const release = vi.fn();
  const database = vi.fn(async () => ({ connect: async () => ({ query, release }) }) as unknown as Pool);
  const context: AdminRpcContext = {
    databaseBrowser: createDatabaseBrowser(database),
    repo: { findByUserId: vi.fn(async () => ({ role, grants: ['database'] })) } as unknown as AdminRepository,
    auth: {} as AuthApi, catalogue: [],
    env: { sessionCookieName: 'session', csrfCookieName: 'admin_csrf', publicOrigin: 'https://example.test' },
    request: new Request('https://example.test/admin/rpc', {
      headers: { cookie: 'admin_csrf=valid', 'x-csrf-token': 'valid' },
    }),
    resHeaders: new Headers(),
    adminContext: { userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.test', role },
  };
  return { state, query, asked, database, release, context, api: adminRouter.createCaller(context).database };
}

const table = { schema: 'auth', table: 'records' };
const original = { id: '1', notes: 'stored' };
const writes = (api: ReturnType<typeof fixture>['api']) => [
  () => api.insert({ ...table, values: { id: '1', notes: 'new' } }),
  () => api.update({ ...table, original, values: { notes: 'changed' } }),
  () => api.delete({ ...table, original }),
];

const mutated = (f: ReturnType<typeof fixture>) => f.asked.filter(({ text }) => /^(INSERT|UPDATE|DELETE)/.test(text));

describe('owner database procedures', () => {
  it('requires an owner for every operation irrespective of module grants', async () => {
    const f = fixture('admin');
    for (const adminContext of [f.context.adminContext, null]) {
      f.context.adminContext = adminContext as never;
      for (const call of [() => f.api.schemas({}), () => f.api.tables({ schema: 'auth' }), () => f.api.rows(table), ...writes(f.api)]) {
        await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    }
    expect(f.database).not.toHaveBeenCalled();
  });

  it('requires the Admin CSRF cookie and header for every mutation', async () => {
    const f = fixture();
    for (const token of [null, 'wrong']) {
      if (token === null) f.context.request.headers.delete('x-csrf-token');
      else f.context.request.headers.set('x-csrf-token', token);
      for (const call of writes(f.api)) await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(f.database).not.toHaveBeenCalled();
  });

  it('describes discovered tables, readonly reasons and excludes migration history', async () => {
    const f = fixture();
    await expect(f.api.schemas({})).resolves.toEqual({ schemas: [{ name: 'auth' }, { name: 'new_module' }] });
    const { tables } = await f.api.tables({ schema: 'new_module' });
    expect(tables.map(({ name }) => name)).toEqual(['records', 'keyless']);
    expect(tables[0]).toMatchObject({ schema: 'new_module', primaryKey: ['id'], readOnlyReason: null,
      columns: [{ name: 'id', conditions: expect.arrayContaining(['equals']) }, { name: 'notes', conditions: expect.arrayContaining(['contains']) }] });
    expect(tables[1]?.readOnlyReason).toBeTruthy();
  });

  it('rejects system schemas, unknown schemas and migration history before writing', async () => {
    const f = fixture();
    for (const schema of ['pg_catalog', 'information_schema', 'missing']) {
      await expect(f.api.tables({ schema })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    const hidden = { schema: 'auth', table: 'schema_migrations' };
    for (const call of [() => f.api.rows(hidden), () => f.api.insert({ ...hidden, values: {} }),
      () => f.api.update({ ...hidden, original, values: { notes: 'x' } }), () => f.api.delete({ ...hidden, original })]) {
      await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(mutated(f)).toEqual([]);
  });

  it('rejects parsed values before querying and validates metadata output', async () => {
    const f = fixture();
    for (const value of [123, true, { x: 1 }, ['value']]) {
      await expect(f.api.insert({ ...table, values: { notes: value } } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(f.database).not.toHaveBeenCalled();
    f.state.invalidOutput = true;
    await expect(f.api.schemas({})).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Output validation failed' });
  });

  it('preserves legal object-property column names during schema validation', () => {
    const row = JSON.parse('{"__proto__":"literal","constructor":"data","toString":null}');
    expect(valuesSchema.parse(row)).toBe(row);
    expect(Object.keys(valuesSchema.parse(row))).toEqual(['__proto__', 'constructor', 'toString']);
  });

  it('returns native text and performs qualified, parameterized CRUD on one transaction connection', async () => {
    const f = fixture();
    expect(await f.api.rows(table)).toMatchObject({ rows: [original], total: 3 });
    await expect(f.api.insert({ ...table, values: { id: '2', notes: 'created' } })).resolves.toEqual({ inserted: { id: '2', notes: 'created' } });
    await expect(f.api.update({ ...table, original: { ...f.state.row }, values: { notes: "'; DROP TABLE records;--" } })).resolves.toEqual({ updated: 1 });
    await expect(f.api.delete({ ...table, original: { ...f.state.row } })).resolves.toEqual({ deleted: 1 });
    const update = mutated(f).find(({ text }) => text.startsWith('UPDATE'))!;
    expect(update.text).toContain('UPDATE ONLY "auth"."records"');
    expect(update.text).not.toContain('DROP TABLE');
    expect(update.values).toContain("'; DROP TABLE records;--");
    expect(f.asked.some(({ text }) => text.includes('FOR UPDATE'))).toBe(true);
    expect(f.asked.some(({ text }) => text.startsWith('LOCK TABLE ONLY'))).toBe(true);
    expect(f.release).toHaveBeenCalledTimes(4);
  });

  it('does not execute UPDATE for an unchanged patch', async () => {
    const f = fixture();
    await expect(f.api.update({ ...table, original, values: { notes: original.notes } })).resolves.toEqual({ updated: 0 });
    expect(mutated(f)).toEqual([]);
  });

  it('refuses vanished or stale original rows, including changes outside the edited column', async () => {
    const f = fixture();
    f.state.row.notes = 'someone else';
    await expect(f.api.update({ ...table, original, values: { notes: 'mine' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(f.api.delete({ ...table, original })).rejects.toMatchObject({ code: 'CONFLICT' });
    f.state.empty = true;
    await expect(f.api.delete({ ...table, original })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mutated(f)).toEqual([]);
  });

  it('rejects normalization before mutation and rolls back', async () => {
    const f = fixture();
    f.state.canonical = true;
    await expect(f.api.update({ ...table, original, values: { notes: 'changed' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mutated(f)).toEqual([]);
    expect(f.asked.at(-1)?.text).toBe('ROLLBACK');
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(['changedAfter', 'affected'] as const)('rolls back when post-write verification fails: %s', async (mode) => {
    const f = fixture();
    if (mode === 'affected') f.state.affected = 2;
    else f.state.changedAfter = true;
    await expect(f.api.update({ ...table, original, values: { notes: 'changed' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.asked.at(-1)?.text).toBe('ROLLBACK');
    expect(f.asked.some(({ text }) => text === 'COMMIT')).toBe(false);
  });

  it('refuses unsafe relations server-side and prevents cascading deletes while allowing updates', async () => {
    const f = fixture();
    f.state.unsafe = true;
    for (const call of writes(f.api)) await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mutated(f)).toEqual([]);
    f.state.unsafe = false;
    f.state.cascade = true;
    await expect(f.api.delete({ ...table, original })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.api.update({ ...table, original, values: { notes: 'changed' } })).resolves.toEqual({ updated: 1 });
  });

  it.each([false, undefined])('keeps partial rows readable but refuses every write when catalogue completeness is %s', async (completeColumns) => {
    const f = fixture();
    f.state.completeColumns = completeColumns;
    const metadata = await f.api.tables({ schema: table.schema });
    expect(metadata.tables[0]?.columns.map(({ name }) => name)).toEqual(['id', 'notes']);
    expect(metadata.tables[0]?.readOnlyReason).toContain('Не все колонки');
    const page = await f.api.rows(table);
    expect(page.rows).toEqual([original]);
    expect(page.readOnlyReason).toContain('Не все колонки');
    for (const call of writes(f.api)) await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mutated(f)).toEqual([]);
    expect(f.asked.at(-1)?.text).toBe('ROLLBACK');
  });

  it.each(['SQL_ASCII', 'LATIN1', 'unknown'])('refuses every write for unsupported server encoding %s', async (encoding) => {
    const f = fixture();
    f.state.encoding = encoding;
    const metadata = await f.api.tables({ schema: table.schema });
    expect(metadata.tables[0]?.readOnlyReason).toContain('UTF8');
    expect((await f.api.rows(table)).readOnlyReason).toContain('UTF8');
    for (const call of writes(f.api)) await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mutated(f)).toEqual([]);
  });

  it.each([['22P02', 'BAD_REQUEST'], ['23505', 'BAD_REQUEST'], ['ECONNRESET', 'INTERNAL_SERVER_ERROR'], ['3D000', 'NOT_FOUND']])(
    'maps database failure %s to tRPC %s and rolls back', async (failure, code) => {
      const f = fixture();
      f.state.failure = failure;
      await expect(f.api.update({ ...table, original, values: { notes: 'x' } })).rejects.toMatchObject({ code });
      expect(f.asked.at(-1)?.text).toBe('ROLLBACK');
      expect(f.release).toHaveBeenCalledOnce();
    },
  );
});
