import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AdminRpcContext } from '../rpc.js';
import { createDatabaseBrowser } from './index.js';
import { databaseRouter } from './router.js';

/**
 * Every condition against real PostgreSQL, on one table shaped like the owner's probe table of
 * 7 October 2026: eight rows with NULL, the empty string, mixed case, a `%` in text, an empty array,
 * an empty range. The expected answers are names, so a wrong row is named in the failure.
 */
const schema = `admin_db_filters_${randomUUID().replaceAll('-', '')}`;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const table = 'v';
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

const U1 = '11111111-1111-1111-1111-111111111111';

beforeAll(async () => {
  await database.connect();
  await database.query(`CREATE SCHEMA ${quote(schema)}`);
  await database.query(`CREATE TABLE ${quote(schema)}.${table} (
    id integer PRIMARY KEY, name text, city varchar(50), active boolean, amount integer, born_on date,
    ref uuid, tags text[], ids uuid[], payload jsonb, doc json, age_range int4range, days daterange, address inet)`);
  await database.query(`INSERT INTO ${quote(schema)}.${table} VALUES
    (1, 'Аня',     'Москва',          true,  100,  '1990-05-12', '${U1}', '{a,b}',     ARRAY['${U1}']::uuid[], '{"plan":"pro","city":"Москва","items":[1,2]}', '{"plan":"pro"}', '[18,30)', '[2026-10-01,2026-10-10)', '10.0.0.5'),
    (2, 'Боря',    'Казань',          false, 250,  '1985-11-30', NULL,    '{b,c}',     NULL,                   '{"plan":"free","city":"Казань"}',              NULL,             '[30,45)', NULL,                      '10.0.1.7'),
    (3, 'Вера',    NULL,              NULL,  NULL, NULL,         NULL,    NULL,        NULL,                   NULL,                                           NULL,             NULL,      NULL,                      NULL),
    (4, 'Гена',    '',                true,  0,    '2000-01-01', NULL,    '{}',        '{}',                   '{}',                                           '{}',             'empty',   'empty',                   '192.168.1.1'),
    (5, 'lisa',    'москва',          false, 1000, '1995-07-04', NULL,    '{a}',       NULL,                   '{"plan":"pro","items":[]}',                    NULL,             '[18,65)', '[2026-10-05,2026-10-06)', '172.16.0.9'),
    (6, 'LISA',    'MOSCOW',          true,  50,   '2010-02-28', NULL,    '{a,b,c,d}', NULL,                   '{"plan":"team","nested":{"deep":true}}',       NULL,             '[0,18)',  NULL,                      '10.0.0.200'),
    (7, 'Яна 50%', 'Санкт-Петербург', false, -5,   '1970-12-31', NULL,    NULL,        NULL,                   '[1,2,3]',                                      NULL,             '[40,50]', NULL,                      '2001:db8::1'),
    (8, '',        'Тверь',           NULL,  7,    '2026-10-07', NULL,    '{x}',       NULL,                   '"строка"',                                     NULL,             NULL,      NULL,                      '10.0.0.0/8')`);
  // A view over the same rows: listed beside the table, read like it, never written.
  await database.query(`CREATE VIEW ${quote(schema)}.grown AS SELECT id, name, city, amount FROM ${quote(schema)}.${table} WHERE amount > 60`);
});

afterAll(async () => {
  try { await database.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); }
  finally { await Promise.all([database.end(), pool.end()]); }
});

/** The names of the rows a filter keeps, in id order. */
async function names(column: string, condition: string, value?: unknown): Promise<(string | null)[]> {
  const { rows } = await api.rows({
    schema, table, filters: [{ column, condition: condition as never, value }], order: [{ column: 'id', direction: 'asc' }],
  });
  return rows.map((row) => row.name ?? null);
}

const refused = (column: string, condition: string, value?: unknown) =>
  expect(names(column, condition, value)).rejects.toMatchObject({ code: 'BAD_REQUEST' });

describe('empty and "or empty"', () => {
  it('"is empty" is SQL NULL only; the empty string is its own condition for text', async () => {
    expect(await names('city', 'is-empty')).toEqual(['Вера']);
    expect(await names('city', 'empty-string')).toEqual(['Гена']);
    expect(await names('city', 'not-empty-string')).toEqual(['Аня', 'Боря', 'lisa', 'LISA', 'Яна 50%', '']);
    expect(await names('city', 'is-not-empty')).toEqual(['Аня', 'Боря', 'Гена', 'lisa', 'LISA', 'Яна 50%', '']);
  });

  it('"not equal" drops the empty cell, "not equal or empty" keeps it', async () => {
    expect(await names('city', 'is-not', 'Москва')).toEqual(['Боря', 'Гена', 'lisa', 'LISA', 'Яна 50%', '']);
    expect(await names('city', 'not-equals-or-empty', 'Москва')).toEqual(['Боря', 'Вера', 'Гена', 'lisa', 'LISA', 'Яна 50%', '']);
    expect(await names('amount', 'not-equals-or-empty', '100')).toEqual(['Боря', 'Вера', 'Гена', 'lisa', 'LISA', 'Яна 50%', '']);
    expect(await names('ref', 'not-equals-or-empty', U1)).toHaveLength(7);
  });

  it('"does not contain or empty" keeps the empty cell and ignores case like "contains"', async () => {
    expect(await names('city', 'not-contains', 'моск')).toEqual(['Боря', 'Гена', 'LISA', 'Яна 50%', '']);
    expect(await names('city', 'not-contains-or-empty', 'моск')).toEqual(['Боря', 'Вера', 'Гена', 'LISA', 'Яна 50%', '']);
  });
});

describe('text length and the outside of a range', () => {
  it('measures length in characters, Cyrillic included', async () => {
    expect(await names('name', 'length-over', '3')).toEqual(['Боря', 'Вера', 'Гена', 'lisa', 'LISA', 'Яна 50%']);
    expect(await names('name', 'length-under', '4')).toEqual(['Аня', '']);
    await refused('name', 'length-over', 'abc');
  });

  it('"outside" excludes both ends and the empty cell', async () => {
    expect(await names('amount', 'not-between', ['0', '100'])).toEqual(['Боря', 'lisa', 'Яна 50%']);
    expect(await names('born_on', 'not-between', ['1980-01-01', '2020-12-31'])).toEqual(['Яна 50%', '']);
  });
});

describe('arrays', () => {
  it('asks about one element without braces, in either direction', async () => {
    expect(await names('tags', 'array-has', 'a')).toEqual(['Аня', 'lisa', 'LISA']);
    expect(await names('tags', 'array-lacks', 'a')).toEqual(['Боря', 'Гена', '']);
    expect(await names('ids', 'array-has', U1)).toEqual(['Аня']);
    await refused('ids', 'array-has', 'zzz');
  });

  it('asks for every listed element, cast to the column\'s element type', async () => {
    expect(await names('tags', 'array-has-all', ['a', 'b'])).toEqual(['Аня', 'LISA']);
    expect(await names('tags', 'array-has-all', ['x'])).toEqual(['']);
    expect(await names('ids', 'array-has-all', [U1])).toEqual(['Аня']);
  });

  it('counts elements; an empty array has none and a missing array is not counted', async () => {
    expect(await names('tags', 'count-over', '2')).toEqual(['LISA']);
    expect(await names('tags', 'count-under', '1')).toEqual(['Гена']);
  });

  it('no longer orders arrays', async () => {
    await refused('tags', 'greater-than', '{a}');
    await refused('tags', 'between', ['{a}', '{b}']);
    expect(await names('tags', 'equals', '{a,b}')).toEqual(['Аня']);
  });
});

describe('json documents', () => {
  it('compares a whole document, which is how {} is found', async () => {
    expect(await names('payload', 'equals', '{}')).toEqual(['Гена']);
    expect(await names('payload', 'equals', '{"city": "Казань", "plan": "free"}')).toEqual(['Боря']);
    expect(await names('payload', 'not-equals-or-empty', '{}')).toHaveLength(7);
    await refused('payload', 'equals', '{plan: pro}');
  });

  it('asks about a top-level key, only for jsonb', async () => {
    expect(await names('payload', 'has-key', 'city')).toEqual(['Аня', 'Боря']);
    expect(await names('payload', 'lacks-key', 'city')).toEqual(['Гена', 'lisa', 'LISA', 'Яна 50%', '']);
    await refused('doc', 'has-key', 'plan');
  });

  it('reads a value by key or dotted path, equal or containing', async () => {
    expect(await names('payload', 'key-equals', ['plan', 'pro'])).toEqual(['Аня', 'lisa']);
    expect(await names('payload', 'key-equals', ['nested.deep', 'true'])).toEqual(['LISA']);
    expect(await names('payload', 'key-equals', ['items.0', '1'])).toEqual(['Аня']);
    expect(await names('payload', 'key-contains', ['city', 'каз'])).toEqual(['Боря']);
    expect(await names('doc', 'key-equals', ['plan', 'pro'])).toEqual(['Аня']);
  });
});

describe('ranges and addresses', () => {
  it('asks whether a range contains a value; an empty range contains nothing', async () => {
    expect(await names('age_range', 'range-has', '25')).toEqual(['Аня', 'lisa']);
    expect(await names('age_range', 'range-has', '50')).toEqual(['lisa', 'Яна 50%']);
    expect(await names('days', 'range-has', '2026-10-05')).toEqual(['Аня', 'lisa']);
    await refused('age_range', 'range-has', 'abc');
  });

  it('no longer orders ranges or addresses', async () => {
    await refused('age_range', 'greater-than', '[1,2)');
    await refused('address', 'at-least', '10.0.0.0');
    expect(await names('address', 'equals', '10.0.0.5')).toEqual(['Аня']);
    expect(await names('age_range', 'equals', 'empty')).toEqual(['Гена']);
  });
});

describe('a view in the schema', () => {
  it('is listed as a view, read-only, with its columns and row count', async () => {
    const { tables } = await api.tables({ schema });
    const view = tables.find((entry) => entry.name === 'grown');
    expect(view).toMatchObject({ kind: 'view', primaryKey: [], readOnlyReason: 'Представление — только чтение.', rows: { count: 3, kind: 'exact' } });
    expect(view?.columns.map((column) => column.name)).toEqual(['id', 'name', 'city', 'amount']);
    expect(tables.find((entry) => entry.name === table)).toMatchObject({ kind: 'table', readOnlyReason: null });
  });

  it('reads, filters and sorts like a table, in its own order when no sort is chosen', async () => {
    const page = await api.rows({ schema, table: 'grown' });
    expect(page.readOnlyReason).toBe('Представление — только чтение.');
    const byId = (rows: { id?: string | null }[]) => [...rows].sort((a, b) => Number(a.id) - Number(b.id)).map((row) => row.id);
    expect(byId(page.rows)).toEqual(['1', '2', '5']);
    const sorted = await api.rows({ schema, table: 'grown', order: [{ column: 'amount', direction: 'desc' }] });
    expect(sorted.rows.map((row) => row.name)).toEqual(['lisa', 'Боря', 'Аня']);
    const filtered = await api.rows({ schema, table: 'grown', filters: [{ column: 'city', condition: 'contains' as never, value: 'моск' }] });
    expect(byId(filtered.rows)).toEqual(['1', '5']);
  });

  it('refuses writes', async () => {
    const refusal = { code: 'FORBIDDEN', message: 'Представление — только чтение.' };
    await expect(api.insert({ schema, table: 'grown', values: { id: '9', name: 'x' } })).rejects.toMatchObject(refusal);
    await expect(api.update({ schema, table: 'grown', original: { id: '1', name: 'Аня', city: 'Москва', amount: '100' }, values: { name: 'y' } })).rejects.toMatchObject(refusal);
    await expect(api.delete({ schema, table: 'grown', original: { id: '1', name: 'Аня', city: 'Москва', amount: '100' } })).rejects.toMatchObject(refusal);
  });
});

describe('a chain of conditions and the case switch', () => {
  const chain = async (filters: { column: string; condition: string; value?: unknown; join?: 'and' | 'or' }[], caseSensitive = false) => {
    const { rows } = await api.rows({ schema, table, filters: filters as never, caseSensitive, order: [{ column: 'id', direction: 'asc' }] });
    return rows.map((row) => row.name ?? null);
  };

  it('reads И before ИЛИ and parenthesises the groups, as the panel draws them', async () => {
    // (city is empty string AND amount = 0) OR city is null: Гена from the first group, Вера from the second.
    expect(await chain([
      { column: 'city', condition: 'empty-string' },
      { column: 'amount', condition: 'equals', value: '0', join: 'and' },
      { column: 'city', condition: 'is-empty', join: 'or' },
    ])).toEqual(['Вера', 'Гена']);
    // city is null OR (city = 'Москва' AND amount > 50): the same three read in the other order.
    expect(await chain([
      { column: 'city', condition: 'is-empty' },
      { column: 'city', condition: 'is', value: 'Москва', join: 'or' },
      { column: 'amount', condition: 'greater-than', value: '50', join: 'and' },
    ])).toEqual(['Аня', 'Вера']);
  });

  it('tells big letters from small only when asked', async () => {
    expect(await chain([{ column: 'city', condition: 'contains', value: 'моск' }])).toEqual(['Аня', 'lisa']);
    expect(await chain([{ column: 'city', condition: 'contains', value: 'моск' }], true)).toEqual(['lisa']);
    expect(await chain([{ column: 'city', condition: 'starts-with', value: 'MOS' }], true)).toEqual(['LISA']);
  });
});
