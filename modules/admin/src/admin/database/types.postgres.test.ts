import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TRPCError } from '@trpc/server';
import type { AdminRpcContext } from '../rpc.js';
import { createDatabaseBrowser } from './index.js';
import { databaseRouter } from './router.js';

/**
 * Real PostgreSQL is the reference; expected values never use JavaScript date/number/JSON parsers.
 * Every supported type gets non-NULL data, an unchanged save, a neighbouring-column edit,
 * a value edit, an insert and a delete through the local database tRPC router. Unsupported types refuse.
 * The catalogue gate below makes newly introduced PostgreSQL types a visible coverage failure.
 */
type RawRow = Record<string, string | null>;
interface Column { name: string; readOnlyReason: string | null }
interface Page {
  rows: RawRow[];
  columns: Column[];
  readOnlyReason: string | null;
  deleteReadOnlyReason: string | null;
}

const schema = `admin_db_types_${randomUUID().replaceAll('-', '')}`;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const tableSql = (table: string) => `${quote(schema)}.${quote(table)}`;
const pgType = (name: string) => `pg_catalog.${quote(name)}`;
const RAW = { getTypeParser: () => (value: string) => value };
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to run the Admin PostgreSQL tests.');
const database = new pg.Client({ connectionString });
const pool = new pg.Pool({ connectionString, max: 3 });
const api = databaseRouter.createCaller({
  databaseBrowser: createDatabaseBrowser(async () => pool),
  // The database router does not call repository or Auth methods.
  repo: {} as AdminRpcContext['repo'], auth: {} as AdminRpcContext['auth'], catalogue: [],
  env: { sessionCookieName: 'session', csrfCookieName: 'admin_csrf', publicOrigin: 'https://example.test' },
  request: new Request('https://example.test/admin/rpc', {
    headers: { cookie: 'admin_csrf=valid', 'x-csrf-token': 'valid' },
  }),
  resHeaders: new Headers(),
  adminContext: { userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.test', role: 'owner' },
});
let connected = false;
let created = false;

// Inputs here are fixture literals, not values returned by the application under test.
// PostgreSQL chooses their native spelling before they are submitted to the canonical-only API.
const SAMPLES: Record<string, readonly [string, string]> = {
  bool: ['false', 'true'],
  int2: ['-32768', '32767'],
  int4: ['-2147483648', '2147483647'],
  int8: ['9007199254740993', '9223372036854775807'],
  float4: ['1.2345678', '3.4028235e38'],
  float8: ['1.2345678901234567', '1.7976931348623157e308'],
  numeric: ['9007199254740993.123456789012345678901234567890', '-999999999999999999999999999999.000000000000000000000000000001'],
  money: ['1234.56', '-9876.54'],
  char: ['a', 'Z'],
  bpchar: ['initial  ', 'changed   '],
  varchar: ['строка e\u0301', '変更 🌍'],
  text: ['before\r\n\tстрока 🌍', 'after\r\n\t変更 e\u0301'],
  name: ['initial_name', 'changed_name'],
  bytea: ['\\x00017f80ff', '\\x00ff0d0a095c22'],
  bit: ['0', '1'],
  varbit: ['00101001', '1110000010101'],
  date: ['2024-02-29', '0001-01-01 BC'],
  timestamp: ['2026-01-02 03:04:05.123456', '0001-01-01 12:34:56.654321 BC'],
  timestamptz: ['2026-01-02 03:04:05.123456+05:45', '0001-01-01 12:34:56.654321+00 BC'],
  time: ['03:04:05.123456', '23:59:59.654321'],
  timetz: ['03:04:05.123456+05:45', '23:59:59.654321-03:30'],
  interval: ['1 year 2 mons 3 days 04:05:06.123456', '-2 mons -3 days -04:05:06.654321'],
  uuid: ['00000000-0000-4000-8000-000000000001', 'abcdef01-2345-4678-9abc-def012345678'],
  json: [' { "big": 9007199254740993, "nested": [null,1.12345678901234567890] } ', '{"big":99999999999999999999999999,"text":"変更 🌍"}'],
  jsonb: ['{"big":9007199254740993,"fraction":1.12345678901234567890}', '{"big":99999999999999999999999999,"nested":[null,"変更 🌍"]}'],
  xml: ['<root value="🌍">first &amp; second</root>', '<root>変更\n<child/></root>'],
  inet: ['192.0.2.123/24', '2001:db8::1234/64'],
  cidr: ['192.0.2.0/24', '2001:db8::/48'],
  macaddr: ['08:00:2b:01:02:03', 'aa:bb:cc:dd:ee:ff'],
  macaddr8: ['08:00:2b:ff:fe:01:02:03', 'aa:bb:cc:dd:ee:ff:01:02'],
  point: ['(1.1234567890123457,2)', '(3.141592653589793,4)'],
  line: ['{1,-1,0}', '{2,-3,4}'],
  lseg: ['[(1,2),(3,4)]', '[(5.123456789012345,6),(7,8)]'],
  box: ['(3,4),(1,2)', '(9,10),(5,6)'],
  path: ['[(1,2),(3,4)]', '((5,6),(7,8),(9,10))'],
  polygon: ['((0,0),(1,0),(1,1))', '((2,2),(4,2),(4,4),(2,4))'],
  circle: ['<(1,2),3>', '<(4,5),6.123456789012345>'],
  tsvector: ["'first':1 'word':2A", "'changed':3B 'слово':4"],
  tsquery: ["'first' & 'word'", "'changed' | !'слово'"],
  int4range: ['[1,5)', '[10,20)'],
  int8range: ['[9007199254740993,9007199254740999)', '[9223372036854775800,9223372036854775807)'],
  numrange: ['[1.12345678901234567890,2.00000000000000000001)', '[9007199254740993.1,9007199254740994.2]'],
  tsrange: ['["2026-01-01 01:02:03.123456","2026-01-02 01:02:03.654321")', '["2027-02-01 01:02:03.123456",infinity)'],
  tstzrange: ['["2026-01-01 01:02:03.123456+00","2026-01-02 01:02:03.654321+00")', '["2027-02-01 01:02:03.123456+00",infinity)'],
  daterange: ['[2024-02-28,2024-03-01)', '[2026-01-01,2027-01-01)'],
  int4multirange: ['{[1,5),[10,15)}', '{[20,25),[30,35)}'],
  int8multirange: ['{[9007199254740993,9007199254740999)}', '{[9223372036854775800,9223372036854775807)}'],
  nummultirange: ['{[1.12345678901234567890,2.00000000000000000001)}', '{[9007199254740993.1,9007199254740994.2]}'],
  tsmultirange: ['{["2026-01-01 01:02:03.123456","2026-01-02 01:02:03.654321")}', '{["2027-01-01 01:02:03.654321",infinity)}'],
  tstzmultirange: ['{["2026-01-01 01:02:03.123456+00","2026-01-02 01:02:03.654321+00")}', '{["2027-01-01 01:02:03.654321+00",infinity)}'],
  datemultirange: ['{[2024-02-28,2024-03-01)}', '{[2026-01-01,2027-01-01)}'],
  oid: ['100', '4294967295'],
  pg_lsn: ['0/16B6C50', 'FFFFFFFF/FFFFFFFF'],
};

// These are legal column types but not supported editing codecs. Some internal types cannot
// accept a non-NULL textual literal at all; the refusal must happen before invoking their input.
const READ_ONLY_TYPES = [
  'aclitem', 'cid', 'gtsvector', 'int2vector', 'jsonpath', 'oidvector',
  'pg_brin_bloom_summary', 'pg_brin_minmax_multi_summary', 'pg_dependencies', 'pg_mcv_list',
  'pg_ndistinct', 'pg_node_tree', 'pg_snapshot', 'refcursor', 'regclass', 'regcollation',
  'regconfig', 'regdictionary', 'regnamespace', 'regoper', 'regoperator', 'regproc',
  'regprocedure', 'regrole', 'regtype', 'tid', 'txid_snapshot', 'xid', 'xid8',
];
const WITHOUT_ARRAY = new Set([
  'pg_brin_bloom_summary', 'pg_brin_minmax_multi_summary', 'pg_dependencies',
  'pg_mcv_list', 'pg_ndistinct', 'pg_node_tree',
]);
const TYPE_CASES = [...Object.keys(SAMPLES), ...READ_ONLY_TYPES].flatMap((name) =>
  (WITHOUT_ARRAY.has(name) ? [false] : [false, true]).map((array) => ({
    name, array, label: `${name}${array ? '[]' : ''}`, supported: Object.hasOwn(SAMPLES, name),
  })),
);

async function raw(text: string, values: unknown[] = []): Promise<RawRow[]> {
  const result = await database.query<(string | null)[]>({ text, values, types: RAW, rowMode: 'array' });
  return result.rows.map((row) => Object.fromEntries(result.fields.map((field, index) => [field.name, row[index]!])));
}

async function stored(table: string): Promise<RawRow[]> {
  return raw(`SELECT * FROM ${tableSql(table)} ORDER BY id`);
}

async function page(table: string): Promise<Page> {
  return api.rows({ schema, table, limit: 500 });
}

function write<Action extends 'insert' | 'update' | 'delete'>(
  action: Action, table: string, input: object,
): ReturnType<typeof api[Action]> {
  // Some cases deliberately pass invalid inputs; the router must validate them at runtime.
  const payload = { schema, table, ...input } as never;
  const result = action === 'insert' ? api.insert(payload) : action === 'update' ? api.update(payload) : api.delete(payload);
  return result as ReturnType<typeof api[Action]>;
}

async function forbidden(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toBeInstanceOf(TRPCError);
  await expect(operation).rejects.toMatchObject({ code: 'FORBIDDEN' });
}

async function refused(operation: Promise<unknown>, code?: TRPCError['code']): Promise<void> {
  await expect(operation).rejects.toBeInstanceOf(TRPCError);
  await expect(operation).rejects.toMatchObject({ code: code ?? expect.stringMatching(/^(BAD_REQUEST|CONFLICT)$/) });
}

async function createValuesTable(type: string, first: string | null, second: string | null, table = 'values') {
  await database.query(`CREATE TABLE ${tableSql(table)} (id integer PRIMARY KEY, value ${type}, note text NOT NULL DEFAULT 'default note')`);
  await database.query(`INSERT INTO ${tableSql(table)} (id,value,note) VALUES (1,$1,'original note'),(2,$2,'untouched neighbour')`, [first, second]);
  return table;
}

async function canonical(type: string, value: string): Promise<string> {
  const row = (await raw(`SELECT $1::${type} AS value`, [value]))[0]!;
  expect(typeof row.value).toBe('string');
  return row.value!;
}

async function exerciseWritable(table: string, next: string): Promise<void> {
  const before = await stored(table);
  const shown = await page(table);
  expect(shown.readOnlyReason).toBeNull();
  expect(shown.deleteReadOnlyReason).toBeNull();
  expect(shown.columns.every((column) => column.readOnlyReason === null)).toBe(true);
  expect(shown.rows).toEqual(before);
  const first = shown.rows[0]!;
  expect(first.value).not.toBeNull();
  expect(next).not.toBe(first.value);

  const noop = await write('update', table, { original: first, values: { value: first.value, note: first.note } });
  expect(noop.updated).toBe(0);
  expect(await stored(table)).toEqual(before);

  await write('update', table, { original: first, values: { note: 'changed note' } });
  const adjacent = [{ ...first, note: 'changed note' }, before[1]!];
  expect(await stored(table)).toEqual(adjacent);

  await write('update', table, { original: adjacent[0], values: { value: next } });
  const changed = [{ ...adjacent[0]!, value: next }, before[1]!];
  expect(await stored(table)).toEqual(changed);
  expect((await page(table)).rows).toEqual(changed);

  const inserted = { id: '3', value: next, note: 'inserted note' };
  await write('insert', table, { values: inserted });
  expect(await stored(table)).toEqual([...changed, inserted]);
  await write('delete', table, { original: inserted });
  expect(await stored(table)).toEqual(changed);
}

async function exerciseReadOnly(table: string, column?: string): Promise<void> {
  const before = await stored(table);
  const shown = await page(table);
  expect(shown.rows).toEqual(before);
  expect(shown.readOnlyReason).toEqual(expect.any(String));
  expect(shown.readOnlyReason?.length).toBeGreaterThan(0);
  if (column) expect(shown.columns.find((item) => item.name === column)?.readOnlyReason).toEqual(expect.any(String));
  for (const action of ['update', 'insert', 'delete'] as const) {
    const input = action === 'insert' ? { values: { id: '3', value: null, note: 'forbidden' } }
      : action === 'update' ? { original: before[0], values: { note: 'forbidden' } }
        : { original: before[0] };
    await forbidden(write(action, table, input));
    expect(await stored(table), action).toEqual(before);
  }
}

beforeAll(async () => {
  await database.connect();
  connected = true;
  await database.query(`SET DateStyle TO 'ISO, YMD'; SET TIME ZONE 'UTC'; SET IntervalStyle TO 'postgres'; SET extra_float_digits TO 3; SET bytea_output TO 'hex'; SET lc_monetary TO 'C'`);
});

beforeEach(async () => {
  await database.query(`CREATE SCHEMA ${quote(schema)}`);
  created = true;
});

afterEach(async () => {
  if (created) {
    await database.query(`DROP SCHEMA ${quote(schema)} CASCADE`);
    created = false;
  }
});

afterAll(async () => {
  try { if (created) await database.query(`DROP SCHEMA ${quote(schema)} CASCADE`); }
  finally { await Promise.all([connected ? database.end() : Promise.resolve(), pool.end()]); }
});

describe('PostgreSQL type coverage', () => {
  it('accounts for every built-in base, range, multirange and actual array column type', async () => {
    const { rows } = await database.query<{ name: string; element: string | null }>(
      `SELECT t.typname AS name, element.typname AS element
         FROM pg_catalog.pg_type t
         JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
         LEFT JOIN pg_catalog.pg_type element ON element.typarray=t.oid
        WHERE n.nspname='pg_catalog' AND t.typtype IN ('b','r','m')
          AND (element.oid IS NULL OR element.typtype IN ('b','r','m')) ORDER BY t.typname`,
    );
    // Exclude autogenerated relation row types and their arrays, not built-in data types.
    // typelem alone is insufficient: name, point, box and vector types also have an element.
    const actual = rows.map((row) => row.element ? `${row.element}[]` : row.name).sort();
    expect(actual).toEqual(TYPE_CASES.map((item) => item.label).sort());
    expect(new Set(TYPE_CASES.map((item) => item.label)).size).toBe(TYPE_CASES.length);
  });

  it.each(TYPE_CASES)('$label: raw reading and explicit editing policy', async ({ name, array, supported }) => {
    const type = `${pgType(name)}${array ? '[]' : ''}`;
    if (!supported) {
      await createValuesTable(type, null, null);
      await exerciseReadOnly('values', 'value');
      return;
    }
    const sample = SAMPLES[name]!;
    let first: string;
    let next: string;
    if (array) {
      // PostgreSQL builds the array, preserving its element delimiter, escaping and NULL member.
      first = (await raw(`SELECT ARRAY[$1::${pgType(name)},NULL,$2::${pgType(name)}] AS value`, [...sample]))[0]!.value!;
      next = (await raw(`SELECT ARRAY[$2::${pgType(name)},$1::${pgType(name)},NULL] AS value`, [...sample]))[0]!.value!;
    } else {
      first = await canonical(type, sample[0]);
      next = await canonical(type, sample[1]);
    }
    await createValuesTable(type, first, first);
    await exerciseWritable('values', next);
  });
});

describe('values that JavaScript coercion must never touch', () => {
  const special: { label: string; type: string; first: string; next: string }[] = [
    { label: 'float NaN and infinity', type: 'float8', first: 'NaN', next: 'Infinity' },
    { label: 'negative float infinity', type: 'float4', first: '-Infinity', next: 'NaN' },
    { label: 'numeric infinity', type: 'numeric', first: '-Infinity', next: 'Infinity' },
    { label: 'numeric NaN', type: 'numeric', first: 'NaN', next: '9007199254740993.00000000000000000001' },
    { label: 'date infinity', type: 'date', first: '-infinity', next: 'infinity' },
    { label: 'timestamp infinity', type: 'timestamp', first: '-infinity', next: 'infinity' },
    { label: 'timestamptz infinity', type: 'timestamptz', first: '-infinity', next: 'infinity' },
    { label: 'far-future timestamp beyond JavaScript Date', type: 'timestamp', first: '294000-01-01 00:00:00.123456', next: '294000-01-02 00:00:00.654321' },
    { label: 'JSON null is not SQL NULL', type: 'json', first: 'null', next: '{"number":9007199254740993}' },
    { label: 'JSONB null is not SQL NULL', type: 'jsonb', first: 'null', next: '{"number":9007199254740993}' },
    { label: 'bytea containing every byte', type: 'bytea', first: `\\x${Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0')).join('')}`, next: '\\x' },
    { label: 'empty ranges', type: 'numrange', first: 'empty', next: '[1.00000000000000000001,2)' },
    { label: 'empty multiranges', type: 'int8multirange', first: '{}', next: '{[9007199254740993,9007199254740995)}' },
  ];

  it.each(special)('$label', async ({ type, first, next }) => {
    await createValuesTable(pgType(type), await canonical(pgType(type), first), await canonical(pgType(type), first));
    await exerciseWritable('values', await canonical(pgType(type), next));
  });

  it('distinguishes empty text, literal null, SQL NULL, Unicode and control characters', async () => {
    await createValuesTable('text', 'initial', 'neighbour');
    // PostgreSQL text excludes NUL; other controls, CRLF, tabs and Unicode remain literal data.
    const values = ['', 'null', 'NULL', ' null ', null, 'e\u0301 é 🌍 変更\r\nsecond\tline\u0001\u000b\u001f\u007f', ''];
    for (const value of values) {
      const original = (await page('values')).rows[0]!;
      await write('update', 'values', { original, values: { value } });
      const current = await stored('values');
      expect(current[0]).toEqual({ ...original, value });
      expect(current[1]).toEqual({ id: '2', value: 'neighbour', note: 'untouched neighbour' });
      expect((await page('values')).rows).toEqual(current);
    }
    const original = (await page('values')).rows[0]!;
    for (const value of ['before\u0000after', 'before\uD800after', 'before\uDC00after']) {
      await refused(write('update', 'values', { original, values: { value, note: 'must roll back' } }));
      expect((await stored('values'))[0]).toEqual(original);
    }
  });

  it('preserves multidimensional arrays, nondefault bounds, escaped members and NULL members', async () => {
    const first = '[0:1][3:4]={{"null",NULL},{"a,b","line\\\\end"}}';
    const next = '[0:1][3:4]={{"",NULL},{"変更 🌍","brace{}quote\\""}}';
    await createValuesTable('text[]', first, first);
    await exerciseWritable('values', await canonical('text[]', next));
    const dimensions = await database.query<{ bounds: string }>(`SELECT array_dims(value) AS bounds FROM ${tableSql('values')} WHERE id=1`);
    expect(dimensions.rows[0]?.bounds).toBe('[0:1][3:4]');
  });

  it('orders numbers as PostgreSQL numbers instead of their wire strings', async () => {
    await createValuesTable('numeric', '10', '2');
    await database.query(`INSERT INTO ${tableSql('values')} (id,value) VALUES (3,100)`);
    const result = await api.rows( { schema, table: 'values', order: [{ column: 'value', direction: 'asc' }] });
    expect(result.rows.map((row) => row.value)).toEqual(['2', '10', '100']);
  });
});

describe('canonical input and type modifiers', () => {
  const modifiers = [
    { type: 'numeric(8,2)', first: '12.34', rejected: '12.345', next: '23.45' },
    { type: 'numeric(3,-2)', first: '1200', rejected: '1234', next: '2300' },
    { type: 'varchar(3)', first: 'abc', rejected: 'abcd', next: 'xyz' },
    { type: 'char(3)', first: 'abc', rejected: 'abcd', next: 'xyz' },
    { type: 'bit(3)', first: '101', rejected: '1011', next: '010' },
    { type: 'varbit(3)', first: '101', rejected: '1011', next: '01' },
    { type: 'time(3)', first: '01:02:03.123', rejected: '01:02:03.123456', next: '04:05:06.456' },
    { type: 'timetz(3)', first: '01:02:03.123+00', rejected: '01:02:03.123456+00', next: '04:05:06.456+00' },
    { type: 'timestamp(3)', first: '2026-01-01 01:02:03.123', rejected: '2026-01-01 01:02:03.123456', next: '2026-01-02 04:05:06.456' },
    { type: 'timestamptz(3)', first: '2026-01-01 01:02:03.123+00', rejected: '2026-01-01 01:02:03.123456+00', next: '2026-01-02 04:05:06.456+00' },
    { type: 'interval(3)', first: '01:02:03.123', rejected: '01:02:03.123456', next: '04:05:06.456' },
    { type: 'numeric(8,2)[]', first: '{1.23,2.34}', rejected: '{1.234,2.345}', next: '{3.45,4.56}' },
    { type: 'varchar(3)[]', first: '{abc,def}', rejected: '{abcd,def}', next: '{ghi,jkl}' },
    { type: 'timestamp(3)[]', first: '{"2026-01-01 01:02:03.123"}', rejected: '{"2026-01-01 01:02:03.123456"}', next: '{"2026-01-02 04:05:06.456"}' },
  ];

  it.each(modifiers)('$type rejects rounding/truncation atomically and accepts exact values', async ({ type, first, rejected, next }) => {
    await createValuesTable(type, first, first);
    const before = await stored('values');
    await refused(write('update', 'values', { original: before[0], values: { note: 'must roll back', value: rejected } }));
    expect(await stored('values')).toEqual(before);
    await refused(write('insert', 'values', { values: { id: '3', note: 'must not exist', value: rejected } }));
    expect(await stored('values')).toEqual(before);
    await exerciseWritable('values', await canonical(type, next));
  });

  it.each([
    { type: 'bool', first: 'f', rejected: 'true', next: 't' },
    { type: 'int8', first: '1', rejected: '0002', next: '2' },
    { type: 'uuid', first: SAMPLES.uuid![0], rejected: SAMPLES.uuid![1].toUpperCase(), next: SAMPLES.uuid![1] },
    { type: 'jsonb', first: '{}', rejected: '{"n":1}', next: '{"n": 1}' },
    { type: 'jsonb', first: '{}', rejected: '{"n": 1, "n": 2}', next: '{"n": 2}' },
    { type: 'timestamptz', first: '2026-01-01 00:00:00+00', rejected: '2026-01-01T03:00:00+03:00', next: '2026-01-01 03:00:00+00' },
    { type: 'date', first: '2026-01-01', rejected: '01/02/2026', next: '2026-01-02' },
    { type: 'int4range', first: '[1,5)', rejected: '[10,20]', next: '[10,21)' },
  ])('$type refuses normalization instead of silently changing the submitted text', async ({ type, first, rejected, next }) => {
    await createValuesTable(type, first, first);
    const before = await stored('values');
    await refused(write('update', 'values', { original: before[0], values: { value: rejected } }), 'BAD_REQUEST');
    expect(await stored('values')).toEqual(before);
    await write('update', 'values', { original: before[0], values: { value: next } });
    expect((await stored('values'))[0]?.value).toBe(next);
  });

  it('rejects non-string wire values, including numbers, booleans, arrays and objects', async () => {
    await createValuesTable('text', 'original', 'neighbour');
    const before = await stored('values');
    for (const value of [9007199254740992, true, ['a'], { a: 1 }]) {
      await refused(write('update', 'values', { original: before[0], values: { value } }), 'BAD_REQUEST');
      await refused(write('insert', 'values', { values: { id: '3', value } }), 'BAD_REQUEST');
      expect(await stored('values')).toEqual(before);
    }
  });
});

describe('original row identity and concurrent edits', () => {
  it('uses every exact component of numeric and microsecond primary keys', async () => {
    await database.query(`CREATE TABLE ${tableSql('keys')} (key_number numeric, key_time timestamptz, value text, PRIMARY KEY (key_number,key_time))`);
    await database.query(`INSERT INTO ${tableSql('keys')} VALUES
      (9007199254740993,'2026-01-01 00:00:00.123456+00','chosen'),
      (9007199254740993,'2026-01-01 00:00:00.123457+00','same number'),
      (9007199254740992,'2026-01-01 00:00:00.123456+00','same time')`);
    const select = () => raw(`SELECT * FROM ${tableSql('keys')} ORDER BY key_number,key_time`);
    const before = await select();
    const shown = await page('keys');
    expect(shown.rows).toEqual(before);
    const chosen = shown.rows.find((row) => row.value === 'chosen')!;
    await write('update', 'keys', { original: chosen, values: { value: 'edited exactly once' } });
    const expected = before.map((row) => row.value === 'chosen' ? { ...row, value: 'edited exactly once' } : row);
    expect(await select()).toEqual(expected);
    await write('delete', 'keys', { original: { ...chosen, value: 'edited exactly once' } });
    expect(await select()).toEqual(before.filter((row) => row.value !== 'chosen'));
  });

  it('rejects stale updates and deletes after another writer changed an untouched column', async () => {
    await createValuesTable('text', 'original', 'neighbour');
    const original = (await page('values')).rows[0]!;
    await database.query(`UPDATE ${tableSql('values')} SET note='concurrent writer' WHERE id=1`);
    const concurrent = await stored('values');
    await refused(write('update', 'values', { original, values: { value: 'stale overwrite' } }), 'CONFLICT');
    await refused(write('delete', 'values', { original }), 'CONFLICT');
    expect(await stored('values')).toEqual(concurrent);
  });

  it('allows exactly one of two overlapping edits from the same original row', async () => {
    await createValuesTable('text', 'original', 'neighbour');
    const original = (await page('values')).rows[0]!;
    await expect(write('update', 'values', { original, values: { value: original.value } })).resolves.toEqual({ updated: 0 });
    const results = await Promise.allSettled(['writer A', 'writer B'].map((value) => write('update', 'values', { original, values: { value } })));
    expect(results.filter((result) => result.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: { updated: 1 } }]);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(TRPCError);
    expect(rejected[0]!.reason).toMatchObject({ code: 'CONFLICT' });
    const current = await stored('values');
    expect(['writer A', 'writer B']).toContain(current[0]?.value);
    expect(current[1]).toEqual({ id: '2', value: 'neighbour', note: 'untouched neighbour' });
  });

  it('rejects missing or extra original columns and a deleted original row', async () => {
    await createValuesTable('text', 'original', 'neighbour');
    const before = await stored('values');
    for (const original of [{ id: '1' }, { ...before[0], extra: 'unexpected' }]) {
      await refused(write('update', 'values', { original, values: { value: 'forbidden' } }));
      expect(await stored('values')).toEqual(before);
    }
    await database.query(`DELETE FROM ${tableSql('values')} WHERE id=1`);
    await refused(write('update', 'values', { original: before[0], values: { value: 'resurrected' } }), 'CONFLICT');
    await refused(write('delete', 'values', { original: before[0] }), 'CONFLICT');
    expect(await stored('values')).toEqual([before[1]]);
  });
});

describe('quoted identifiers', () => {
  it('preserves prototype-like names, quotes, dots and Unicode', async () => {
    const table = 'quoted."table 変更';
    const names = ['id', '__proto__', 'constructor', 'toString', 'dot.name', 'quote"name', '変更 🌍'];
    await database.query(`CREATE TABLE ${tableSql(table)} (${names.map((name, index) =>
      `${quote(name)} ${index === 0 ? 'integer PRIMARY KEY' : 'text'}`).join(', ')})`);
    const initial = Object.fromEntries(names.map((name, index) => [name, index === 0 ? '1' : `original ${name}`]));
    const inserted = Object.fromEntries(names.map((name, index) => [name, index === 0 ? '2' : `inserted ${name}`]));
    await database.query(`INSERT INTO ${tableSql(table)} (${names.map(quote).join(',')})
      VALUES (${names.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(initial));
    expect((await page(table)).rows).toEqual([initial]);
    const changedValues = Object.fromEntries(names.slice(1).map((name) => [name, `changed ${name}`]));
    await write('update', table, { original: initial, values: changedValues });
    const changed = { ...initial, ...changedValues };
    expect(await stored(table)).toEqual([changed]);
    expect((await page(table)).rows).toEqual([changed]);
    await write('insert', table, { values: inserted });
    expect(await stored(table)).toEqual([changed, inserted]);
    await write('delete', table, { original: inserted });
    expect(await stored(table)).toEqual([changed]);
  });
});

describe('custom types and unsupported table behaviour', () => {
  it.each([false, true])('supports enum labels including empty and literal null (array=%s)', async (array) => {
    await database.query(`CREATE TYPE ${tableSql('status')} AS ENUM ('initial','','null','変更 🌍')`);
    const type = `${tableSql('status')}${array ? '[]' : ''}`;
    const first = array ? '{initial,NULL}' : 'initial';
    const next = array ? '{"","null","変更 🌍",NULL}' : 'null';
    await createValuesTable(type, first, first);
    await exerciseWritable('values', await canonical(type, next));
    if (!array) {
      const original = (await page('values')).rows[0]!;
      await write('update', 'values', { original, values: { value: '' } });
      expect((await stored('values'))[0]?.value).toBe('');
    }
  });

  it.each(['domain', 'domain_array', 'composite', 'composite_array', 'custom_range'])('%s stays readable and refuses every mutation', async (kind) => {
    await database.query(`CREATE DOMAIN ${tableSql('positive')} AS numeric CHECK (VALUE > 0)`);
    await database.query(`CREATE TYPE ${tableSql('pair')} AS (amount numeric, label text)`);
    await database.query(`CREATE TYPE ${tableSql('own_range')} AS RANGE (subtype=numeric)`);
    const definitions: Record<string, [string, string]> = {
      domain: [tableSql('positive'), '9007199254740993.123456789'],
      domain_array: [`${tableSql('positive')}[]`, '{9007199254740993.123456789,NULL}'],
      composite: [tableSql('pair'), '(9007199254740993.123456789,"変更 🌍")'],
      composite_array: [`${tableSql('pair')}[]`, '{"(9007199254740993.123456789,first)",NULL}'],
      custom_range: [tableSql('own_range'), '[1.000000000000000000001,2)'],
    };
    const [type, value] = definitions[kind]!;
    await createValuesTable(type, value, value);
    await exerciseReadOnly('values', 'value');
  });

  it.each(['trigger', 'rule', 'generated', 'rls', 'inheritance', 'partition'])('%s tables refuse mutations without firing side effects', async (kind) => {
    if (kind === 'inheritance') {
      await createValuesTable('text', 'original', 'neighbour');
      await database.query(`CREATE TABLE ${tableSql('child')} () INHERITS (${tableSql('values')})`);
      await database.query(`INSERT INTO ${tableSql('child')} (id,value,note) VALUES (1,'duplicate inherited key','child')`);
    } else if (kind === 'partition') {
      await database.query(`CREATE TABLE ${tableSql('values')} (id integer PRIMARY KEY, value text, note text) PARTITION BY RANGE (id)`);
      await database.query(`CREATE TABLE ${tableSql('partition')} PARTITION OF ${tableSql('values')} FOR VALUES FROM (0) TO (10)`);
      await database.query(`INSERT INTO ${tableSql('values')} VALUES (1,'original','original note'),(2,'neighbour','untouched neighbour')`);
    } else {
      await createValuesTable('text', 'original', 'neighbour');
      if (kind === 'trigger') {
        await database.query(`CREATE TABLE ${tableSql('effects')} (operation text)`);
        await database.query(`CREATE FUNCTION ${tableSql('mutate')}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${tableSql('effects')} VALUES (TG_OP); RETURN NULL; END $$`);
        await database.query(`CREATE TRIGGER mutate BEFORE INSERT OR UPDATE OR DELETE ON ${tableSql('values')} FOR EACH ROW EXECUTE FUNCTION ${tableSql('mutate')}()`);
      } else if (kind === 'rule') {
        await database.query(`CREATE RULE ignore_update AS ON UPDATE TO ${tableSql('values')} DO INSTEAD NOTHING`);
      } else if (kind === 'generated') {
        await database.query(`ALTER TABLE ${tableSql('values')} ADD computed text GENERATED ALWAYS AS (value || note) STORED`);
      } else {
        await database.query(`ALTER TABLE ${tableSql('values')} ENABLE ROW LEVEL SECURITY`);
      }
    }
    await exerciseReadOnly('values');
    if (kind === 'trigger') expect((await database.query(`SELECT * FROM ${tableSql('effects')}`)).rows).toEqual([]);
  });

  it('refuses all writes to a table without a primary key', async () => {
    await database.query(`CREATE TABLE ${tableSql('values')} (id integer, value text, note text)`);
    await database.query(`INSERT INTO ${tableSql('values')} VALUES (1,'original','original note'),(2,'neighbour','untouched neighbour')`);
    await exerciseReadOnly('values');
  });

  it.each(['default', 'check', 'expression_index', 'operator'])('refuses custom %s expressions before they can run during a write', async (kind) => {
    await createValuesTable('text', 'original', 'neighbour');
    await database.query(`CREATE FUNCTION ${tableSql('custom_text')}(text) RETURNS text LANGUAGE sql IMMUTABLE AS 'SELECT $1'`);
    if (kind === 'default') {
      await database.query(`ALTER TABLE ${tableSql('values')} ALTER value SET DEFAULT ${tableSql('custom_text')}('custom default')`);
    } else if (kind === 'check') {
      await database.query(`ALTER TABLE ${tableSql('values')} ADD CHECK (${tableSql('custom_text')}(value) IS NOT NULL)`);
    } else if (kind === 'expression_index') {
      await database.query(`CREATE INDEX custom_expression ON ${tableSql('values')} ((${tableSql('custom_text')}(value)))`);
    } else {
      await database.query(`CREATE FUNCTION ${tableSql('custom_equal')}(text,text) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT $1 = $2'`);
      await database.query(`CREATE OPERATOR ${quote(schema)}.=== (LEFTARG=text, RIGHTARG=text, FUNCTION=${tableSql('custom_equal')})`);
      await database.query(`ALTER TABLE ${tableSql('values')} ADD CHECK (value OPERATOR(${quote(schema)}.===) value)`);
    }
    await exerciseReadOnly('values');
  });

  it('refuses cascading parent deletion while allowing a non-key parent update', async () => {
    await createValuesTable('text', 'original', 'neighbour');
    await database.query(`CREATE TABLE ${tableSql('child')} (id integer PRIMARY KEY, parent integer REFERENCES ${tableSql('values')}(id) ON DELETE CASCADE)`);
    await database.query(`INSERT INTO ${tableSql('child')} VALUES (1,1)`);
    const shown = await page('values');
    expect(shown.readOnlyReason).toBeNull();
    expect(shown.deleteReadOnlyReason).toEqual(expect.any(String));
    await forbidden(write('delete', 'values', { original: shown.rows[0] }));
    expect((await database.query(`SELECT * FROM ${tableSql('child')}`)).rows).toHaveLength(1);
    await write('update', 'values', { original: shown.rows[0], values: { value: 'allowed' } });
    expect((await stored('values'))[0]?.value).toBe('allowed');
  });

  it.each(['CASCADE', 'SET NULL', 'SET DEFAULT'])('refuses a referenced UNIQUE value update with ON UPDATE %s', async (action) => {
    await createValuesTable('text', 'original', 'neighbour');
    await database.query(`ALTER TABLE ${tableSql('values')} ADD UNIQUE (value)`);
    await database.query(`CREATE TABLE ${tableSql('child')} (id integer PRIMARY KEY,
      parent_value text REFERENCES ${tableSql('values')}(value) ON UPDATE ${action})`);
    await database.query(`INSERT INTO ${tableSql('child')} VALUES (1,'original')`);
    const before = await stored('values');
    const children = await raw(`SELECT * FROM ${tableSql('child')} ORDER BY id`);
    await forbidden(write('update', 'values', { original: before[0], values: { value: 'would change child' } }));
    expect(await stored('values')).toEqual(before);
    expect(await raw(`SELECT * FROM ${tableSql('child')} ORDER BY id`)).toEqual(children);
  });
});
