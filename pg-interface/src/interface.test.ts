import { describe, expect, it } from 'vitest';

import { COUNT_LIMIT, readCatalogue, type Queryable, type RowCount } from './catalog.js';
import { changeName, MIGRATIONS_TABLE, ownColumns, parseChangeName } from './ownership.js';
import { conditionsFor } from './filters.js';
import { RequestError, type Table } from './identifiers.js';
import {
  createDatabaseInterface,
  REQUEST_HEADER,
  REQUEST_HEADER_VALUE,
} from './index.js';
import { typeParsers } from './pools.js';
import { deleteRow, insertRow, pageOf, selectRows, updateRow } from './statements.js';
import { serveScreen } from './static.js';

/** A table with a single-column key, and one with a key of two — both shapes exist in this project. */
const rows: Table = {
  schema: 'public',
  name: 'identities',
  columns: [
    { name: 'id', type: 'uuid', nullable: false, hasDefault: false, generated: false },
    { name: 'email', type: 'character varying', nullable: false, hasDefault: false, generated: false },
    // Defaults to `now()`, which is what makes it the column this table opens sorted by.
    { name: 'created_at', type: 'timestamp with time zone', nullable: false, hasDefault: true, generated: false },
    { name: 'attempts', type: 'integer', nullable: true, hasDefault: false, generated: false },
  ],
  primaryKey: ['id'],
};

const grants: Table = {
  schema: 'public',
  name: 'administrator_grants',
  columns: [
    { name: 'administrator_id', type: 'uuid', nullable: false, hasDefault: false, generated: false },
    { name: 'service', type: 'character varying', nullable: false, hasDefault: false, generated: false },
    { name: 'note', type: 'text', nullable: true, hasDefault: false, generated: false },
  ],
  primaryKey: ['administrator_id', 'service'],
};

/** A table the planner has an estimate for, small enough that the estimate is not used. */
const sessions: Table = {
  schema: 'public',
  name: 'sessions',
  columns: [
    { name: 'id', type: 'uuid', nullable: false, hasDefault: false, generated: false },
    { name: 'expires_at', type: 'timestamp with time zone', nullable: false, hasDefault: false, generated: false },
  ],
  primaryKey: ['id'],
};

/** A table with no estimate that turns out to hold more rows than the count is willing to read. */
const audit: Table = {
  schema: 'public',
  name: 'auth_audit',
  // An identity column: the database fills it in, so a new row must not carry it.
  columns: [{ name: 'id', type: 'uuid', nullable: false, hasDefault: true, generated: true }],
  primaryKey: ['id'],
};

/**
 * What the planner says about each table. `identities` is above `COUNT_LIMIT`, so its number is the
 * estimate; the rest are counted, whether the planner has a small estimate or none at all.
 */
const ESTIMATES: Record<string, string> = {
  identities: String(COUNT_LIMIT + 40_000),
  sessions: '3',
  administrator_grants: '-1',
  auth_audit: '-1',
};

/**
 * Column defaults, as `information_schema` would report them: `identity` stands for a generated
 * identity column, anything else is the default expression itself. Keyed by `table.column`.
 *
 * `identities.created_at` defaults to `now()`, which is how a table with a uuid key still opens in the
 * order its rows arrived; `sessions` has neither, so it falls back to its key.
 */
const DEFAULTS: Record<string, string> = {
  'identities.created_at': 'now()',
  'auth_audit.id': 'identity',
};

/** A value no uuid column can hold, which the fake pool refuses the way PostgreSQL would. */
const UNHOLDABLE = 'нет';

/** A value that makes the fake pool fail the way an unreachable database does: no code of its own. */
const UNREACHABLE = 'обрыв';

/** What counting returns for each table, once the estimate has sent it to be counted. */
const COUNTS: Record<string, string> = {
  sessions: '3',
  administrator_grants: '3',
  auth_audit: String(COUNT_LIMIT + 1),
};

describe('what a request may name', () => {
  it('refuses a column the table does not have', () => {
    expect(() => selectRows(rows, { order: [{ column: 'passwd', direction: 'asc' }] })).toThrow(
      /No column passwd/,
    );
  });

  it('refuses a direction that is not asc or desc', () => {
    expect(() =>
      selectRows(rows, { order: [{ column: 'email', direction: 'asc; DROP TABLE identities' }] }),
    ).toThrow(/asc/);
  });

  it('offers text conditions for text and comparison conditions for numbers', () => {
    expect(conditionsFor('character varying')).toContain('contains');
    expect(conditionsFor('integer')).not.toContain('contains');
    expect(conditionsFor('integer')).toContain('greater-than');
  });

  it('refuses a condition that does not apply to the column', () => {
    expect(() =>
      selectRows(rows, { filters: [{ column: 'attempts', condition: 'contains', value: '1' }] }),
    ).toThrow(/does not apply/);
  });
});

describe('values never become SQL', () => {
  it('puts every filter value in a parameter', () => {
    const { rows: statement } = selectRows(rows, {
      filters: [
        { column: 'email', condition: 'contains', value: "o'brien" },
        { column: 'attempts', condition: 'greater-than', value: 3 },
      ],
      combine: 'and',
    });

    expect(statement.text).not.toContain("o'brien");
    expect(statement.values).toContain('%o\'brien%');
    expect(statement.values).toContain(3);
    expect(statement.text).toMatch(/ILIKE \$1 AND "attempts" > \$2/);
  });

  it('treats a wildcard the person typed as text, not as a pattern', () => {
    const { rows: statement } = selectRows(rows, {
      filters: [{ column: 'email', condition: 'starts-with', value: '50%_x' }],
    });

    expect(statement.values[0]).toBe('50\\%\\_x%');
  });

  it('parameterises the page as well, so a limit cannot carry SQL', () => {
    const { rows: statement } = selectRows(rows, { limit: 10, offset: 20 });
    expect(statement.text).toMatch(/LIMIT \$1 OFFSET \$2/);
    expect(statement.values).toEqual([10, 20]);
  });

  it('clamps the page instead of trusting it', () => {
    expect(pageOf({ limit: 100_000 }).limit).toBe(500);
    expect(pageOf({ limit: 0 }).limit).toBe(1);
    expect(pageOf({ offset: -5 }).offset).toBe(0);
    expect(() => pageOf({ limit: '10' })).toThrow(RequestError);
  });

  it('counts with its own parameters, so an empty page still knows the total', () => {
    const { total } = selectRows(rows, {
      filters: [{ column: 'email', condition: 'is', value: 'a@b.c' }],
      offset: 1000,
    });

    expect(total.text).toMatch(/count\(\*\)/);
    expect(total.values).toEqual(['a@b.c']);
  });
});

/**
 * Insertion is the one operation where "left out" and "empty" differ: a column the database fills in
 * must be absent from the statement, and a `not null` column without a default may not be absent.
 */
describe('adding a row', () => {
  it('names only the columns it was given, and returns the whole row', () => {
    const statement = insertRow(rows, {
      values: { id: 'u-1', email: 'new@example.test' },
    });

    expect(statement.text).toBe(
      'INSERT INTO "public"."identities" ("id", "email") VALUES ($1, $2) ' +
        'RETURNING "id", "email", "created_at", "attempts"',
    );
    expect(statement.values).toEqual(['u-1', 'new@example.test']);
  });

  it('leaves out a column with a default, so the database fills it in', () => {
    const statement = insertRow(rows, { values: { id: 'u-1', email: 'a@b.c' } });

    // `created_at` defaults to now(): naming it with an empty value would store an empty value.
    expect(statement.text).not.toContain('"created_at")');
    expect(statement.text).toContain('RETURNING "id", "email", "created_at"');
  });

  it('refuses a required column that has no default and no value', () => {
    expect(() => insertRow(rows, { values: { id: 'u-1' } })).toThrow(/email/);
    expect(() => insertRow(rows, { values: { id: 'u-1' } })).toThrow(/has no default/);
  });

  it('refuses a value for a column the database fills in itself', () => {
    expect(() => insertRow(audit, { values: { id: 7 } })).toThrow(/filled in by the database/);
  });

  it('inserts defaults only when the table asks for nothing', () => {
    const statement = insertRow(audit, { values: {} });

    expect(statement.text).toBe('INSERT INTO "public"."auth_audit" DEFAULT VALUES RETURNING "id"');
    expect(statement.values).toEqual([]);
  });

  it('carries a null as a null and a value as a parameter', () => {
    const statement = insertRow(rows, {
      values: { id: 'u-1', email: 'a@b.c', attempts: null },
    });

    expect(statement.text).toContain('"attempts"');
    expect(statement.values).toEqual(['u-1', 'a@b.c', null]);
  });

  it('refuses a column the table does not have, and values that are not an object', () => {
    expect(() => insertRow(rows, { values: { passwd: 'x' } })).toThrow(/No column passwd/);
    expect(() => insertRow(rows, { values: 'email' })).toThrow(/object of column names/);
    expect(() => insertRow(rows, {})).toThrow(/object of column names/);
  });

  it('puts a value in a parameter even when it carries SQL', () => {
    const statement = insertRow(rows, {
      values: { id: 'u-1', email: "'; DROP TABLE identities; --" },
    });

    expect(statement.text).not.toContain('DROP TABLE');
    expect(statement.values).toContain("'; DROP TABLE identities; --");
  });
});

/** The word `null` typed into a field that cannot hold it: read as empty, except in text. */
/** `date` and `timestamp` come back as text, `timestamptz` as a moment — the day must not shift. */
describe('reading a date', () => {
  const parserFor = (oid: number) => typeParsers().getTypeParser(oid) as (value: string) => unknown;

  it('hands over a date and a zoneless timestamp exactly as stored', () => {
    expect(parserFor(1082)('2026-08-27')).toBe('2026-08-27');
    expect(parserFor(1114)('2026-08-27 10:00:00')).toBe('2026-08-27 10:00:00');
  });

  it('leaves a timestamptz to the driver, because that one is a moment', () => {
    const parsed = parserFor(1184)('2026-08-27 00:00:00+00');
    expect(parsed).toBeInstanceOf(Date);
  });
});

describe('the word null', () => {
  it('means empty for a type that cannot hold the word', () => {
    const statement = insertRow(rows, {
      values: { id: 'u-1', email: 'a@b.c', attempts: 'null' },
    });

    expect(statement.values).toEqual(['u-1', 'a@b.c', null]);
  });

  it('stays a word for a text column, because there it is a value', () => {
    const statement = insertRow(rows, { values: { id: 'u-1', email: 'null' } });
    expect(statement.values).toEqual(['u-1', 'null']);
  });

  it('is refused where the column cannot be empty at all', () => {
    const notNullable: Table = {
      ...rows,
      columns: [
        { name: 'id', type: 'uuid', nullable: false, hasDefault: false, generated: false },
        { name: 'count', type: 'integer', nullable: false, hasDefault: false, generated: false },
      ],
    };

    expect(() => insertRow(notNullable, { values: { id: 'u-1', count: 'null' } })).toThrow(
      /cannot be empty/,
    );
  });

  it('means empty when editing a row as well', () => {
    const statement = updateRow(rows, { key: { id: 'u-1' }, values: { attempts: 'NULL' } });
    expect(statement.values).toEqual([null, 'u-1']);
  });
});

describe('a row is addressed by its whole key', () => {
  it('changes one row of a single-column key', () => {
    const statement = updateRow(rows, { key: { id: 'u-1' }, values: { email: 'new@example.test' } });

    expect(statement.text).toBe('UPDATE "public"."identities" SET "email" = $1 WHERE "id" = $2');
    expect(statement.values).toEqual(['new@example.test', 'u-1']);
  });

  it('needs both columns of a two-column key', () => {
    expect(() =>
      updateRow(grants, { key: { administrator_id: 'a-1' }, values: { note: 'hi' } }),
    ).toThrow(/administrator_id, service/);

    const statement = updateRow(grants, {
      key: { administrator_id: 'a-1', service: 'auth' },
      values: { note: 'hi' },
    });
    expect(statement.text).toMatch(/WHERE "administrator_id" = \$2 AND "service" = \$3/);
  });

  it('refuses a key that names something outside the key', () => {
    expect(() => deleteRow(rows, { key: { id: 'u-1', email: 'a@b.c' } })).toThrow(/key of/);
  });

  it('refuses to change a key column', () => {
    expect(() => updateRow(rows, { key: { id: 'u-1' }, values: { id: 'u-2' } })).toThrow(
      /identifies the row/,
    );
  });

  it('refuses a table with no key at all', () => {
    const keyless: Table = { ...rows, primaryKey: [] };
    expect(() => deleteRow(keyless, { key: {} })).toThrow(/no primary key/);
  });
});

/** A row of `schema_migrations` as the migrator writes it, which is all this package reads. */
interface MigrationRow {
  version: number;
  name: string;
  checksum: string;
}

/**
 * The migration every one of these databases starts with: a module's own, and nothing this interface
 * may touch. Ownership is replayed from names, so the name is the whole of what matters here.
 */
const MODULE_MIGRATION: MigrationRow = {
  version: 1,
  name: 'identities-sessions-tokens-audit',
  checksum: 'module',
};

/**
 * A pool that answers the catalogue, records applied migrations, and applies `ALTER TABLE` to its own
 * tables.
 *
 * It has to do that last part: a test that only checked the statement text would not notice that the
 * recorded name and the catalogue disagree about what a column is called after a rename.
 */
type FakePool = Queryable & {
  asked: { text: string; values: unknown[] }[];
  migrations: MigrationRow[];
  connect(): Promise<Queryable & { release(): void }>;
  failOnAlter?: boolean;
  /** A database no migration has ever been applied to: the record is not there at all. */
  migrationsMissing?: boolean;
  /** The most queries this pool ever had in flight at once — how many rounds a request took. */
  mostAtOnce: number;
  /**
   * Asks and answers in the order they happened, as `ask <text>` and `answer <text>`.
   *
   * What this catches and a count of overlaps does not: whether a query went out **before** anything
   * came back. The table list counts rows table by table in parallel, so its high-water mark of
   * queries in flight says little; "asked before the first answer arrived" is the same round.
   */
  flow: string[];
  /** The answer itself, without the counting `query` wraps it in. */
  answer<Row>(text: string, values?: unknown[]): { rows: Row[]; rowCount: number | null };
};

function fakePool(tables: Table[]): FakePool {
  const asked: { text: string; values: unknown[] }[] = [];
  const migrations: MigrationRow[] = [{ ...MODULE_MIGRATION }];

  /** `ALTER TABLE` as this fake understands it — the three shapes `ddl.ts` can produce. */
  function reshape(text: string): void {
    const add = /^ALTER TABLE "(.+)"\."(.+)" ADD COLUMN "(.+)" (\w+)$/.exec(text);
    const rename = /^ALTER TABLE "(.+)"\."(.+)" RENAME COLUMN "(.+)" TO "(.+)"$/.exec(text);
    const drop = /^ALTER TABLE "(.+)"\."(.+)" DROP COLUMN "(.+)"$/.exec(text);

    const found = (schema: string, name: string) =>
      tables.find((table) => table.schema === schema && table.name === name);

    if (add) {
      found(add[1] ?? '', add[2] ?? '')?.columns.push({
        name: add[3] ?? '',
        type: add[4] ?? '',
        nullable: true,
        hasDefault: false,
        generated: false,
      });
      return;
    }

    if (rename) {
      const column = found(rename[1] ?? '', rename[2] ?? '')?.columns.find(
        (entry) => entry.name === rename[3],
      );
      if (column) column.name = rename[4] ?? column.name;
      return;
    }

    if (drop) {
      const table = found(drop[1] ?? '', drop[2] ?? '');
      if (table) table.columns = table.columns.filter((entry) => entry.name !== drop[3]);
    }
  }

  let inFlight = 0;
  let undo: { tables: Table[]; migrations: MigrationRow[] } | null = null;
  const flow: string[] = [];

  const pool: FakePool = {
    asked,
    migrations,
    mostAtOnce: 0,
    flow,
    async connect() {
      return { query: (text: string, values?: unknown[]) => pool.query(text, values), release() {} };
    },
    async query<Row>(text: string, values: unknown[] = []) {
      asked.push({ text, values });

      /*
       * Answering is deferred a tick, and while it is deferred the query counts as in flight. That is
       * what makes the number of rounds a request takes visible: queries started together overlap,
       * queries awaited one after another never do.
       */
      inFlight += 1;
      pool.mostAtOnce = Math.max(pool.mostAtOnce, inFlight);
      flow.push(`ask ${text}`);
      try {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        return pool.answer<Row>(text, values);
      } finally {
        inFlight -= 1;
        flow.push(`answer ${text}`);
      }
    },
    answer<Row>(text: string, values: unknown[] = []) {
      /*
       * A transaction this fake really undoes.
       *
       * Without it `ROLLBACK` was a word in a list of queries, and a test could only check that the
       * word had been said. PostgreSQL runs DDL inside a transaction, so both halves — the shape of
       * the tables and the record of applied migrations — come back on a rollback, and that is what
       * the failing paths are about.
       */
      if (text === 'BEGIN') {
        undo = { tables: structuredClone(tables), migrations: structuredClone(migrations) };
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (text === 'ROLLBACK') {
        if (undo) {
          tables.splice(0, tables.length, ...undo.tables);
          migrations.splice(0, migrations.length, ...undo.migrations);
        }
        undo = null;
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (text === 'COMMIT') {
        undo = null;
        return { rows: [] as Row[], rowCount: 0 };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] as Row[], rowCount: 0 };

      if (text.includes(`FROM ${MIGRATIONS_TABLE}`)) {
        // What a database no migration has reached answers, whatever the query.
        if (pool.migrationsMissing) {
          throw Object.assign(new Error(`relation "${MIGRATIONS_TABLE}" does not exist`), {
            code: '42P01',
          });
        }
        // The highest version applied here, which is half of what decides the next one.
        if (text.includes('MAX(version)')) {
          const highest = Math.max(0, ...migrations.map((row) => row.version));
          return { rows: [{ highest }] as Row[], rowCount: 1 };
        }
        return { rows: migrations as Row[], rowCount: migrations.length };
      }
      if (text.includes(`INSERT INTO ${MIGRATIONS_TABLE}`)) {
        migrations.push({
          version: Number(values[0]),
          name: String(values[1]),
          checksum: String(values[2]),
        });
        return { rows: [] as Row[], rowCount: 1 };
      }

      /*
       * `INSERT … RETURNING`: the row as this fake stored it, built from the columns the statement
       * names and the values that came with it. Without this the answer would be an empty row, and the
       * test would pass while the server dropped `RETURNING` altogether.
       */
      if (text.startsWith('INSERT INTO') && text.includes('RETURNING')) {
        const named = /\(([^)]*)\) VALUES/.exec(text);
        const columns = named
          ? named[1].split(',').map((part) => part.trim().replace(/^"|"$/g, ''))
          : [];
        const stored = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
        return { rows: [stored] as Row[], rowCount: 1 };
      }

      if (text.startsWith('ALTER TABLE')) {
        if (pool.failOnAlter) throw Object.assign(new Error('permission denied'), { code: '42501' });
        reshape(text);
        return { rows: [] as Row[], rowCount: 0 };
      }

      if (text.includes('information_schema.columns')) {
        const rows = tables.flatMap((table) =>
          table.columns.map((column) => ({
            table_schema: table.schema,
            table_name: table.name,
            column_name: column.name,
            data_type: column.type,
            is_nullable: column.nullable ? 'YES' : 'NO',
            // The two schema facts that say "this column counts upwards as rows are added". The test
            // tables carry them in the same shape `information_schema` reports them.
            is_identity: DEFAULTS[`${table.name}.${column.name}`] === 'identity' ? 'YES' : 'NO',
            is_generated: 'NEVER',
            column_default: DEFAULTS[`${table.name}.${column.name}`] ?? null,
          })),
        );
        return { rows: rows as Row[], rowCount: rows.length };
      }

      if (text.includes('table_constraints')) {
        const rows = tables.flatMap((table) =>
          table.primaryKey.map((column, index) => ({
            table_schema: table.schema,
            table_name: table.name,
            column_name: column,
            position: index + 1,
          })),
        );
        return { rows: rows as Row[], rowCount: rows.length };
      }

      if (text.includes('pg_class')) {
        const estimate = ESTIMATES[String(values[1])] ?? '-1';
        return { rows: [{ estimate }] as Row[], rowCount: 1 };
      }
      // The counting query names its table in the text, not in a parameter — that is how it is found here.
      if (text.includes('capped')) {
        const named = Object.keys(COUNTS).find((name) => text.includes(`"${name}"`));
        return { rows: [{ total: COUNTS[named ?? ''] ?? '3' }] as Row[], rowCount: 1 };
      }
      if (text.includes('count(*)')) return { rows: [{ total: '7' }] as Row[], rowCount: 1 };

      // What PostgreSQL does with a value the column cannot hold: refuses, with a code in class 22.
      if (values.includes(UNHOLDABLE)) {
        throw Object.assign(new Error('invalid input syntax for type uuid: "нет"'), { code: '22P02' });
      }
      // And what a database that is simply not there does, which is not the caller's fault at all.
      if (values.includes(UNREACHABLE)) {
        throw Object.assign(new Error('connection terminated unexpectedly'), { code: 'ECONNRESET' });
      }
      if (text.startsWith('SELECT')) return { rows: [{ id: 'u-1' }] as Row[], rowCount: 1 };

      return { rows: [] as Row[], rowCount: 1 };
    },
  };

  return pool;
}

/**
 * The project side of a shape change, as a test can watch it.
 *
 * The real one writes a file into a module's migrations folder; this one remembers what it was asked
 * to write. `refuses` is how a test makes that half fail — the half that is not a database, and so the
 * one whose failure has to undo the other.
 */
function fakeWriter() {
  const written: { database: string; version: number; name: string; sql: string }[] = [];
  const state = { refuses: false };

  return {
    written,
    state,
    writer: {
      root: 'nowhere in particular',
      highest: () => Math.max(0, ...written.map((entry) => entry.version)),
      write(database: string, migration: { version: number; name: string; sql: string }) {
        if (state.refuses) throw new Error('nowhere to write this migration');
        written.push({ database, ...migration });
      },
      checksum: (sql: string) => `sha:${sql.length}`,
    },
  };
}

function build(tables: Table[] = [rows, grants, sessions, audit], { writes = true } = {}) {
  // Cloned: the fake applies `ALTER TABLE` to these objects, and a column added by one test would
  // otherwise still be there in the next one.
  const pool = fakePool(structuredClone(tables));
  const project = fakeWriter();

  const api = createDatabaseInterface({
    databases: [{ name: 'demo_auth', connectionString: 'postgres://unused/demo_auth' }],
    basePath: '/admin/embed/database',
    connect: async () => pool,
    ...(writes ? { writer: project.writer } : {}),
  });

  return { api, pool, written: project.written, project };
}

const at = (path: string, init?: RequestInit) =>
  new Request(`http://panel.test/admin/embed/database${path}`, init);

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  at(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const marked = { [REQUEST_HEADER]: REQUEST_HEADER_VALUE };

describe('the API', () => {
  it('lists the databases it was handed and nothing else', async () => {
    const { api } = build();
    const response = await api.fetch(at('/api/databases'));

    expect(response.status).toBe(200);
    // Beside them, where a change of shape would be written — null when there is nowhere to write it.
    expect(await response.json()).toEqual({
      databases: [{ name: 'demo_auth' }],
      writesInto: 'nowhere in particular',
    });
  });

  it('refuses a database it was not handed', async () => {
    const { api } = build();
    expect((await api.fetch(at('/api/databases/other/tables'))).status).toBe(404);
  });

  it('describes tables with their key and the conditions each column takes', async () => {
    const { api } = build();
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; primaryKey: string[]; rows: RowCount }[];
    };

    expect(body.tables.map((table) => table.name)).toEqual([
      'identities',
      'administrator_grants',
      'sessions',
      'auth_audit',
    ]);
    expect(body.tables[1]?.primaryKey).toEqual(['administrator_id', 'service']);
    expect(body.tables[0]?.rows).toEqual({ count: COUNT_LIMIT + 40_000, kind: 'estimate' });
  });

  /**
   * The estimate decides whether counting is cheap, and nothing else. A table nothing has analysed says
   * `-1`, a small table says a small number, and both are counted — otherwise `~3` sat beside a plain
   * `5` and the difference between them was only autovacuum.
   */
  it('counts every table small enough to count, estimate or not', async () => {
    const { api } = build();
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; rows: RowCount }[];
    };

    expect(body.tables[1]?.rows).toEqual({ count: 3, kind: 'exact' });
    expect(body.tables[2]?.rows).toEqual({ count: 3, kind: 'exact' });
  });

  /**
   * Counting stops at the limit, and what comes back is a floor rather than an estimate — the screen
   * says `>10000`, not `~10000`. The two are different statements and used to share one sign.
   */
  it('stops counting a table larger than the limit and says so', async () => {
    const { api } = build();
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; rows: RowCount }[];
    };

    expect(body.tables[3]?.rows).toEqual({ count: COUNT_LIMIT, kind: 'more' });
  });

  it('reads a page of rows with the total beside it', async () => {
    const { api } = build();
    const response = await api.fetch(
      post('/api/databases/demo_auth/rows', { schema: 'public', table: 'identities' }, marked),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rows: [{ id: 'u-1' }], total: 7 });
  });

  /**
   * The guard this package has to hold itself: the repository's mechanical CSRF check reads tRPC
   * procedures, and this is not one.
   */
  it('refuses a changing request that could have come from another site', async () => {
    const { api } = build();
    const response = await api.fetch(
      post('/api/databases/demo_auth/rows/delete', { schema: 'public', table: 'identities', key: { id: 'u-1' } }),
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain(REQUEST_HEADER);
  });

  it('changes a row when the request carries the header', async () => {
    const { api, pool } = build();
    const response = await api.fetch(
      post(
        '/api/databases/demo_auth/rows/update',
        { schema: 'public', table: 'identities', key: { id: 'u-1' }, values: { email: 'x@y.z' } },
        marked,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: 1 });
    expect(pool.asked.at(-1)?.text).toMatch(/^UPDATE/);
  });

  /**
   * A value the column cannot hold is the caller's mistake, so it reads as a refusal rather than as
   * this interface breaking. It used to answer 500, which on screen looked like the section was broken —
   * and the filter panel produced one the moment it opened on a uuid column.
   */
  it('answers a value the column cannot hold as a refusal, not a failure', async () => {
    const { api } = build();
    const response = await api.fetch(
      post(
        '/api/databases/demo_auth/rows',
        {
          schema: 'public',
          table: 'identities',
          filters: [{ column: 'id', condition: 'is', value: UNHOLDABLE }],
        },
        marked,
      ),
    );

    expect(response.status).toBe(400);
    // The class of the refusal reaches the person; the value that caused it stays out of the answer.
    expect(await response.json()).toMatchObject({ error: 'refused' });
  });

  /** The other side of the same fork: a database that is not answering is still this side's failure. */
  it('still answers a database that fails as a failure', async () => {
    const { api } = build();
    const response = await api.fetch(
      post(
        '/api/databases/demo_auth/rows',
        {
          schema: 'public',
          table: 'identities',
          filters: [{ column: 'id', condition: 'is', value: UNREACHABLE }],
        },
        marked,
      ),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'database-failed' });
  });

  /**
   * And the third branch of that fork: a module creates its own database on the first request that
   * needs it, so a database this interface was handed may simply not be there yet. That is the ordinary
   * state of a module nobody has reached — not a failure, and not a database it was never given.
   */
  it('tells a database that does not exist yet from a failure', async () => {
    const api = createDatabaseInterface({
      databases: [{ name: 'demo_sandbox', connectionString: 'postgres://unused/demo_sandbox' }],
      basePath: '/admin/embed/database',
      connect: async () => ({
        query: () => {
          throw Object.assign(new Error('database "demo_sandbox" does not exist'), { code: '3D000' });
        },
      }),
    });

    const response = await api.fetch(at('/api/databases/demo_sandbox/tables'));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'database-absent' });
  });

  it('refuses a table the database does not have', async () => {
    const { api } = build();
    const response = await api.fetch(
      post('/api/databases/demo_auth/rows', { schema: 'public', table: 'secrets' }, marked),
    );

    expect(response.status).toBe(404);
  });

  it('serves the screen at its root', async () => {
    const { api } = build();
    const response = await api.fetch(at('/'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<div id="app">');
  });

  it('serves a built asset, and lets it be cached', async () => {
    const { api } = build();
    const page = await (await api.fetch(at('/'))).text();
    const asset = /src="\.\/(assets\/[^"]+\.js)"/.exec(page)?.[1];
    expect(asset).toBeDefined();

    const response = await api.fetch(at(`/${asset}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
  });

  /**
   * The guard is tested on `serveScreen` itself rather than through a request, and that is the point:
   * `new Request(…)` collapses `..` in a URL before this package ever sees it, so a test that went in
   * over HTTP would pass without the guard existing at all. What is checked here is the function that
   * would read the file.
   */
  it('refuses a path that walks out of the built screen', async () => {
    // Two levels up from `web/dist` is this package's own manifest — a file that certainly exists, which
    // is what makes this a probe rather than a path that happens to resolve to nothing.
    const response = await serveScreen('/../../package.json');

    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).not.toContain('@grimcode/pg-interface');
  });

  it('answers a method a path does not take', async () => {
    const { api } = build();
    expect((await api.fetch(at('/api/databases/demo_auth/tables', { method: 'POST' }))).status).toBe(
      405,
    );
    expect((await api.fetch(at('/', { method: 'POST' }))).status).toBe(405);
  });

});

/**
 * Columns: what this interface may do to the shape of a table, and what it may not.
 *
 * The rule the whole group is about: **adding is open, renaming and dropping are not.** A nullable
 * column nobody reads cannot break a module; a renamed column its code reads breaks it with the next
 * request. Which columns are which is not in `information_schema` — it is in the names of the
 * migrations the database has applied.
 */
describe('the shape of a table', () => {
  const addColumnAt = (column: string, type: string, table = 'identities') =>
    post('/api/databases/demo_auth/columns', { schema: 'public', table, column, type }, marked);

  it('adds a nullable column, writes it as a migration and records it as applied', async () => {
    const { api, pool, written } = build();
    const response = await api.fetch(addColumnAt('nickname', 'text'));

    expect(response.status).toBe(200);
    // Version 2: the module's own migration is version 1, and this one follows it like any other.
    expect(await response.json()).toMatchObject({ added: 'nickname', version: 2 });

    // The statement, once, and always nullable: `NOT NULL` would break the module's own INSERT.
    const altered = pool.asked.filter((query) => query.text.startsWith('ALTER TABLE'));
    expect(altered).toHaveLength(1);
    expect(altered[0]?.text).toBe('ALTER TABLE "public"."identities" ADD COLUMN "nickname" text');

    // Written into the project — the whole point: the same statement, under a name that says what it did.
    expect(written).toEqual([
      {
        database: 'demo_auth',
        version: 2,
        name: 'interface-add-public-identities-nickname',
        sql: 'ALTER TABLE "public"."identities" ADD COLUMN "nickname" text',
      },
    ]);

    // And recorded as applied, by the same rule the project's migrator uses, so it never runs twice.
    expect(pool.migrations.at(-1)).toEqual({
      version: 2,
      name: 'interface-add-public-identities-nickname',
      checksum: `sha:${written[0]?.sql.length}`,
    });
  });

  /**
   * Where the shape cannot be written, it cannot be changed.
   *
   * A built copy of the program has no sources beside it, so a column added there would live in that
   * database alone — exactly what this design exists to prevent. The screen is told, and offers
   * nothing; the server refuses anyway, because a screen is not a guard.
   */
  it('changes no shape at all where there is no project to write into', async () => {
    const { api, written } = build(undefined, { writes: false });

    const response = await api.fetch(addColumnAt('nickname', 'text'));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('no project to write a migration into');
    expect(written).toEqual([]);

    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; reshapable: boolean }[];
    };
    expect(body.tables.every((table) => table.reshapable === false)).toBe(true);
  });

  it('marks its own columns as its own, and the rest as not', async () => {
    const { api } = build();
    await api.fetch(addColumnAt('nickname', 'text'));

    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; columns: { name: string; own: boolean }[] }[];
    };
    const identities = body.tables.find((table) => table.name === 'identities');

    expect(identities?.columns.find((column) => column.name === 'nickname')?.own).toBe(true);
    expect(identities?.columns.find((column) => column.name === 'email')?.own).toBe(false);
  });

  /** The test this whole feature stands on. A column of a migration is the module's, not ours. */
  it('refuses to rename or drop a column that came from a migration', async () => {
    const { api } = build();

    const renamed = await api.fetch(
      post(
        '/api/databases/demo_auth/columns/rename',
        { schema: 'public', table: 'identities', column: 'email', to: 'mail' },
        marked,
      ),
    );
    const dropped = await api.fetch(
      post(
        '/api/databases/demo_auth/columns/drop',
        { schema: 'public', table: 'identities', column: 'email' },
        marked,
      ),
    );

    expect(renamed.status).toBe(400);
    expect(await renamed.text()).toContain('migrations');
    expect(dropped.status).toBe(400);
  });

  it('renames and drops a column it added, and the record follows the new name', async () => {
    const { api, pool } = build();
    await api.fetch(addColumnAt('nickname', 'text'));

    const renamed = await api.fetch(
      post(
        '/api/databases/demo_auth/columns/rename',
        { schema: 'public', table: 'identities', column: 'nickname', to: 'handle' },
        marked,
      ),
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ renamed: 'handle' });

    // Renaming keeps it ours: otherwise the next rename would be refused as a migration's column.
    const listed = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; columns: { name: string; own: boolean }[] }[];
    };
    const columns = listed.tables.find((table) => table.name === 'identities')?.columns ?? [];
    expect(columns.find((column) => column.name === 'handle')?.own).toBe(true);
    expect(columns.some((column) => column.name === 'nickname')).toBe(false);

    const dropped = await api.fetch(
      post(
        '/api/databases/demo_auth/columns/drop',
        { schema: 'public', table: 'identities', column: 'handle' },
        marked,
      ),
    );
    expect(dropped.status).toBe(200);
    expect(pool.migrations.map((row) => row.name)).toEqual([
      MODULE_MIGRATION.name,
      'interface-add-public-identities-nickname',
      'interface-rename-public-identities-nickname-handle',
      'interface-drop-public-identities-handle',
    ]);
  });

  it('refuses a name that would be a nuisance, and a type it does not offer', async () => {
    const { api } = build();

    expect((await api.fetch(addColumnAt('two words', 'text'))).status).toBe(400);
    expect((await api.fetch(addColumnAt('пробел', 'text'))).status).toBe(400);
    expect((await api.fetch(addColumnAt('a'.repeat(64), 'text'))).status).toBe(400);
    expect((await api.fetch(addColumnAt('ok_name', 'money'))).status).toBe(400);
    // A name the table already has, which PostgreSQL would refuse anyway — but with its own message.
    expect((await api.fetch(addColumnAt('email', 'text'))).status).toBe(400);
  });

  it('will not reshape the table that records what has been applied', async () => {
    const { api } = build([{ ...rows, name: MIGRATIONS_TABLE }]);

    expect((await api.fetch(addColumnAt('note', 'text', MIGRATIONS_TABLE))).status).toBe(400);
  });

  it('needs the header for a change of shape, like any other change', async () => {
    const { api } = build();
    const response = await api.fetch(
      post('/api/databases/demo_auth/columns', {
        schema: 'public',
        table: 'identities',
        column: 'nickname',
        type: 'text',
      }),
    );

    expect(response.status).toBe(403);
  });

  /** Applied and recorded are one transaction, so a statement that fails leaves no record behind. */
  it('rolls back the record when the statement fails', async () => {
    const { api, pool, written } = build();
    pool.failOnAlter = true;

    const response = await api.fetch(addColumnAt('nickname', 'text'));

    expect(response.status).toBe(500);
    expect(pool.asked.map((query) => query.text)).toContain('ROLLBACK');
    expect(pool.migrations).toEqual([MODULE_MIGRATION]);
    expect(written).toEqual([]);
  });

  /**
   * The file is written inside the transaction, and this is the test that says why.
   *
   * A column in a database that is in no file is the one outcome this design cannot allow — it is what
   * the old journal did, and what nobody else ever received. So the write goes in before the commit:
   * if the project cannot be written to, the database is left as it was.
   */
  it('undoes the change when the migration cannot be written', async () => {
    const { api, pool, project } = build();
    project.state.refuses = true;

    const response = await api.fetch(addColumnAt('nickname', 'text'));

    expect(response.status).toBe(500);
    expect(pool.asked.map((query) => query.text)).toContain('ROLLBACK');
    expect(pool.asked.map((query) => query.text)).not.toContain('COMMIT');
    expect(pool.migrations).toEqual([MODULE_MIGRATION]);
  });

  /**
   * The applied migrations depend on nothing the other reads produce, so they go out with them.
   *
   * Measured on a live database before the change: reading them after the page and the count cost the
   * price of the query itself, a tenth of a millisecond over a socket — but a whole round trip once
   * the database is on another machine, on every page a person opens.
   */
  it('reads the applied migrations in the same round as the rows and the count', async () => {
    const { api, pool } = build();
    await api.fetch(post('/api/databases/demo_auth/rows', { schema: 'public', table: 'identities' }, marked));

    expect(pool.mostAtOnce).toBe(3);
  });

  it('asks for the applied migrations without waiting for the catalogue', async () => {
    const { api, pool } = build();
    await api.fetch(at('/api/databases/demo_auth/tables'));

    // Asked before anything at all came back, which is what "in the same round" means here.
    const askedRecord = pool.flow.findIndex((step) => step.includes(`ask SELECT name`));
    const firstAnswer = pool.flow.findIndex((step) => step.startsWith('answer'));
    expect(askedRecord).toBeGreaterThanOrEqual(0);
    expect(askedRecord).toBeLessThan(firstAnswer);
  });

  it('adds a row through the API and answers with what was stored', async () => {
    const { api } = build();
    const response = await api.fetch(
      post(
        '/api/databases/demo_auth/rows/insert',
        { schema: 'public', table: 'identities', values: { id: 'u-9', email: 'new@example.test' } },
        marked,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      inserted: { id: 'u-9', email: 'new@example.test' },
    });
  });

  it('tells the screen which tables take a new row', async () => {
    const { api } = build([rows, { ...rows, name: MIGRATIONS_TABLE }]);
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; insertable: boolean }[];
    };

    expect(body.tables.find((table) => table.name === 'identities')?.insertable).toBe(true);
    expect(body.tables.find((table) => table.name === MIGRATIONS_TABLE)?.insertable).toBe(false);
  });

  it('refuses a new row in the table that records what has been applied', async () => {
    const { api } = build([{ ...rows, name: MIGRATIONS_TABLE }]);

    const response = await api.fetch(
      post(
        '/api/databases/demo_auth/rows/insert',
        { schema: 'public', table: MIGRATIONS_TABLE, values: { id: 'u-9', email: 'a@b.c' } },
        marked,
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('already been applied');
  });

  it('needs the header to add a row, like any other change', async () => {
    const { api } = build();
    const response = await api.fetch(
      post('/api/databases/demo_auth/rows/insert', {
        schema: 'public',
        table: 'identities',
        values: { id: 'u-9', email: 'a@b.c' },
      }),
    );

    expect(response.status).toBe(403);
  });

  it('sends no DDL while reading', async () => {
    const { api, pool } = build();
    await api.fetch(at('/api/databases/demo_auth/tables'));
    await api.fetch(post('/api/databases/demo_auth/rows', { schema: 'public', table: 'identities' }, marked));

    expect(pool.asked.filter((query) => query.text.includes('CREATE TABLE'))).toEqual([]);
  });

  it('reads a database that has no record of applied migrations at all', async () => {
    const { api, pool } = build();
    pool.migrationsMissing = true;

    // Not a failure but an answer: nothing has been applied here, so nothing here is this one's.
    const listed = await api.fetch(at('/api/databases/demo_auth/tables'));
    const body = (await listed.json()) as {
      tables: { name: string; columns: { name: string; own: boolean }[] }[];
    };
    expect(listed.status).toBe(200);
    expect(
      body.tables.find((table) => table.name === 'identities')?.columns.every((column) => !column.own),
    ).toBe(true);

    // And with nothing recorded, nothing is ours to rename.
    const renamed = await api.fetch(
      post(
        '/api/databases/demo_auth/columns/rename',
        { schema: 'public', table: 'identities', column: 'email', to: 'mail' },
        marked,
      ),
    );
    expect(renamed.status).toBe(400);
  });
});

/**
 * The name of a migration is where ownership lives, so reading it back is not a detail.
 *
 * A name that cannot be read back is a column this interface would refuse to rename tomorrow, with no
 * sign that anything went wrong today — which is why building one is refused rather than escaped.
 */
describe('a change, as a migration name', () => {
  it('writes and reads back the three kinds', () => {
    const add = { kind: 'add', schema: 'public', table: 'profiles', column: 'notes' } as const;
    const rename = { ...add, kind: 'rename', to: 'remarks' } as const;
    const drop = { ...add, kind: 'drop', column: 'remarks' } as const;

    expect(changeName(add)).toBe('interface-add-public-profiles-notes');
    expect(changeName(rename)).toBe('interface-rename-public-profiles-notes-remarks');
    expect(changeName(drop)).toBe('interface-drop-public-profiles-remarks');

    for (const change of [add, rename, drop]) {
      expect(parseChangeName(changeName(change))).toEqual(change);
    }
  });

  it('reads a migration of the module itself as nobody at all', () => {
    expect(parseChangeName('identities-sessions-tokens-audit')).toBeNull();
    expect(parseChangeName('interface-move-public-profiles-notes')).toBeNull();
    expect(parseChangeName('interface-add-public-profiles')).toBeNull();
    // A rename carries the new name; anything else that does is not one.
    expect(parseChangeName('interface-drop-public-profiles-notes-remarks')).toBeNull();
  });

  it('refuses to name a change it could not read back', () => {
    expect(() =>
      changeName({ kind: 'add', schema: 'public', table: 'odd-table', column: 'notes' }),
    ).toThrow(/hyphen/);
  });

  it('replays the names into the columns it owns', () => {
    const changes = [
      { kind: 'add', schema: 'public', table: 'profiles', column: 'notes' },
      { kind: 'rename', schema: 'public', table: 'profiles', column: 'notes', to: 'remarks' },
      { kind: 'add', schema: 'public', table: 'profiles', column: 'tag' },
      { kind: 'drop', schema: 'public', table: 'profiles', column: 'tag' },
    ] as const;

    expect([...ownColumns([...changes])]).toEqual(['public.profiles.remarks']);
  });
});

/**
 * There is always an order, because there has to be.
 *
 * Without `ORDER BY` PostgreSQL hands back rows in whatever order it read them, and an updated row is
 * rewritten at the end of the table: editing the first row moved it to the bottom of the list. The same
 * gap makes paging unsound — `LIMIT`/`OFFSET` over an undefined order can repeat one row and skip
 * another. The primary key is what closes it: unique, so the order is total, and indexed, so it is free.
 */
describe('the order rows come back in', () => {
  it('sorts by the primary key when nothing was asked for', () => {
    const { rows: statement } = selectRows(rows, {});
    expect(statement.text).toContain('ORDER BY "id"');
  });

  it('sorts by the whole key when the key is two columns', () => {
    const { rows: statement } = selectRows(grants, {});
    expect(statement.text).toContain('ORDER BY "administrator_id", "service"');
  });

  it('keeps the key as the last level of a sort a person chose', () => {
    const { rows: statement } = selectRows(rows, {
      order: [{ column: 'email', direction: 'desc' }],
    });

    // The chosen column decides; the key only breaks ties, which is what stops rows swapping places.
    expect(statement.text).toContain('ORDER BY "email" DESC, "id"');
  });

  /**
   * `NULLS LAST` only where nulls can occur.
   *
   * It is a decision about reading — nulls first on `DESC` reads as a fault — but on a `NOT NULL`
   * column it says nothing and costs the index: `DESC NULLS LAST` does not match a btree's order, so
   * PostgreSQL sorts the whole table instead of walking the index backwards. Measured on 200 000 rows:
   * 15.3 ms against 0.024 ms.
   */
  it('says nulls last for a column that can hold one, and nothing for a column that cannot', () => {
    const nullable = selectRows(rows, { order: [{ column: 'attempts', direction: 'desc' }] });
    expect(nullable.rows.text).toContain('ORDER BY "attempts" DESC NULLS LAST, "id"');

    const notNullable = selectRows(rows, { order: [{ column: 'created_at', direction: 'desc' }] });
    expect(notNullable.rows.text).toContain('ORDER BY "created_at" DESC, "id"');
    expect(notNullable.rows.text).not.toContain('NULLS');
  });

  it('does not name the key twice when the sort is already by the key', () => {
    const { rows: statement } = selectRows(rows, {
      order: [{ column: 'id', direction: 'asc' }],
    });

    // `ORDER BY "id" ASC NULLS LAST, "id"` behaves correctly and reads like a mistake.
    expect(statement.text).toContain('ORDER BY "id" ASC LIMIT');
  });

  it('appends only the missing half of a key of two columns', () => {
    const { rows: statement } = selectRows(grants, {
      order: [{ column: 'service', direction: 'desc' }],
    });

    // Dropping both would leave rows with the same service in no order at all.
    expect(statement.text).toContain('ORDER BY "service" DESC, "administrator_id"');
  });

  it('pages a keyless table by the physical address of the row', () => {
    const keyless: Table = { ...rows, primaryKey: [] };
    const { rows: statement } = selectRows(keyless, {});

    // Such a table cannot be edited here, so `ctid` is stable enough to page by.
    expect(statement.text).toContain('ORDER BY ctid');
  });
});

/**
 * What a table opens sorted by.
 *
 * Sorting by the key is stable, and with a uuid key it reads as no order at all — which is how it looked
 * to the person using it. So the catalogue is asked instead: a counter or a timestamp that defaults to
 * the current time records the order rows arrived in, and that is what a table opens by. Both marks are
 * schema facts; a column named `created_at` with no default is somebody's data and means nothing here.
 */
describe('the column a table opens sorted by', () => {
  it('takes a timestamp that defaults to now()', async () => {
    const { api } = build();
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; naturalOrder: string | null }[];
    };

    expect(body.tables.find((table) => table.name === 'identities')?.naturalOrder).toBe('created_at');
  });

  it('takes an identity column', async () => {
    const { api } = build();
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; naturalOrder: string | null }[];
    };

    expect(body.tables.find((table) => table.name === 'auth_audit')?.naturalOrder).toBe('id');
  });

  it('says nothing when the table records no arrival order', async () => {
    const { api } = build();
    const body = (await (await api.fetch(at('/api/databases/demo_auth/tables'))).json()) as {
      tables: { name: string; naturalOrder: string | null }[];
    };

    // Nothing to sort by is an answer: the screen leaves the order to the server, which uses the key.
    expect(body.tables.find((table) => table.name === 'sessions')?.naturalOrder).toBeNull();
  });
});

/**
 * Reading the catalogue is the expensive part of every request, so its two halves go out together.
 *
 * Measured on a live database: the keys cost 1.6 ms beside 5.2 ms for the columns on a module's own
 * database, and 72 ms beside 160 ms on a database of two hundred tables. Awaited one after the other
 * that time was added up — and the catalogue is read for the table list, for a page of rows, and for
 * every change of shape.
 */
describe('reading the catalogue', () => {
  it('asks for columns and keys in the same round', async () => {
    const pool = fakePool(structuredClone([rows, grants]));
    await readCatalogue(pool);

    expect(pool.mostAtOnce).toBe(2);
  });
});

/**
 * Which conditions a column is offered, and what each one becomes.
 *
 * Five sets by type, because a menu that offers "greater than" for a boolean or "contains" for a number
 * teaches a person not to trust it. And every condition is an ordinary comparison — `IN (…)` rather than
 * PostgreSQL's `= ANY($1)`, `BETWEEN` rather than a pair of clauses — so the set survives a move to
 * another database with the two casts in this file as the only work.
 */
describe('conditions by type', () => {
  const withColumn = (name: string, type: string): Table => ({
    schema: 'public',
    name: 'sample',
    columns: [{ name, type, nullable: true }],
    primaryKey: [name],
  });

  it('offers a boolean truth and nothing to compare', () => {
    const conditions = conditionsFor('boolean');

    expect(conditions).toEqual(['is-true', 'is-false', 'is-empty', 'is-not-empty']);
    expect(conditions).not.toContain('greater-than');
    expect(conditions).not.toContain('contains');
  });

  it('offers a uuid matching but not ordering', () => {
    const conditions = conditionsFor('uuid');

    expect(conditions).toContain('starts-with');
    expect(conditions).toContain('one-of');
    expect(conditions).not.toContain('greater-than');
  });

  it('offers a json document searching only', () => {
    expect(conditionsFor('jsonb')).toEqual(['contains', 'not-contains', 'is-empty', 'is-not-empty']);
  });

  it('offers numbers and dates the same range conditions', () => {
    for (const type of ['integer', 'numeric', 'timestamp with time zone', 'date']) {
      const conditions = conditionsFor(type);
      expect(conditions).toContain('between');
      expect(conditions).toContain('at-least');
      expect(conditions).toContain('at-most');
    }
  });

  it('writes the loose comparisons as >= and <=', () => {
    const table = withColumn('amount', 'numeric');

    expect(selectRows(table, { filters: [{ column: 'amount', condition: 'at-least', value: 10 }] })
      .rows.text).toContain('"amount" >= $1');
    expect(selectRows(table, { filters: [{ column: 'amount', condition: 'at-most', value: 10 }] })
      .rows.text).toContain('"amount" <= $1');
  });

  it('writes a range as BETWEEN, with both ends included', () => {
    const table = withColumn('amount', 'integer');
    const { rows: statement } = selectRows(table, {
      filters: [{ column: 'amount', condition: 'between', value: [10, 20] }],
    });

    expect(statement.text).toContain('"amount" BETWEEN $1 AND $2');
    expect(statement.values).toEqual([10, 20, 50, 0]);
  });

  it('refuses a range that has only one end', () => {
    const table = withColumn('amount', 'integer');

    expect(() =>
      selectRows(table, { filters: [{ column: 'amount', condition: 'between', value: [10] }] }),
    ).toThrow(/two values/);
    expect(() =>
      selectRows(table, { filters: [{ column: 'amount', condition: 'between', value: [10, ''] }] }),
    ).toThrow(/both ends/);
  });

  it('writes a list as IN, one placeholder per value', () => {
    const table = withColumn('tag', 'text');
    const { rows: statement } = selectRows(table, {
      filters: [{ column: 'tag', condition: 'one-of', value: ['a', 'b', 'c'] }],
    });

    expect(statement.text).toContain('"tag" IN ($1, $2, $3)');
    expect(statement.values.slice(0, 3)).toEqual(['a', 'b', 'c']);
  });

  it('takes a single value as a list of one, and refuses an empty list', () => {
    const table = withColumn('tag', 'text');

    expect(
      selectRows(table, { filters: [{ column: 'tag', condition: 'not-one-of', value: 'a' }] }).rows.text,
    ).toContain('"tag" NOT IN ($1)');

    expect(() =>
      selectRows(table, { filters: [{ column: 'tag', condition: 'one-of', value: [] }] }),
    ).toThrow(/at least one/);
  });

  it('asks a boolean about truth without a value', () => {
    const table = withColumn('active', 'boolean');

    expect(selectRows(table, { filters: [{ column: 'active', condition: 'is-true' }] }).rows.text)
      .toContain('"active" IS TRUE');
    expect(selectRows(table, { filters: [{ column: 'active', condition: 'is-false' }] }).rows.text)
      .toContain('"active" IS FALSE');
  });

  it('writes the negative text conditions as NOT ILIKE', () => {
    const table = withColumn('title', 'text');

    expect(
      selectRows(table, { filters: [{ column: 'title', condition: 'not-starts-with', value: 'a' }] })
        .rows.text,
    ).toContain('NOT ILIKE');
    expect(
      selectRows(table, { filters: [{ column: 'title', condition: 'not-ends-with', value: 'a' }] })
        .rows.text,
    ).toContain('NOT ILIKE');
  });
});

/**
 * A required column, and the default that makes it safe.
 *
 * `NOT NULL` on its own would break the module: its `INSERT` names the columns it knows, and a column it
 * has never heard of would have nothing to be filled with. With a default the insert leaves the column
 * out and PostgreSQL fills it in — so a required column always carries one, and keeps it.
 *
 * The default is the one value in this package that reaches SQL as text, which is why it is parsed by
 * type: a number has to be a number, a date a date, a json document has to parse.
 */
describe('a required column', () => {
  const add = (body: Record<string, unknown>) =>
    post('/api/databases/demo_auth/columns', { schema: 'public', table: 'identities', ...body }, marked);

  const statementOf = (pool: FakePool) =>
    pool.asked.filter((query) => query.text.startsWith('ALTER TABLE')).at(-1)?.text ?? '';

  it('gets the neutral default of its type', async () => {
    const cases: [string, string][] = [
      ['text', `DEFAULT '' NOT NULL`],
      ['integer', 'DEFAULT 0 NOT NULL'],
      ['numeric', 'DEFAULT 0 NOT NULL'],
      ['boolean', 'DEFAULT false NOT NULL'],
      ['timestamptz', 'DEFAULT now() NOT NULL'],
      ['jsonb', `DEFAULT '{}'::jsonb NOT NULL`],
    ];

    for (const [type, expected] of cases) {
      const { api, pool } = build();
      const response = await api.fetch(add({ column: `probe_${type}`, type, required: true }));

      expect(response.status).toBe(200);
      expect(statementOf(pool)).toContain(expected);
    }
  });

  it('stays nullable and undefaulted when nothing is asked for', async () => {
    const { api, pool } = build();
    await api.fetch(add({ column: 'plain', type: 'text' }));

    expect(statementOf(pool)).toBe('ALTER TABLE "public"."identities" ADD COLUMN "plain" text');
  });

  /** A generating default is volatile, and PostgreSQL rewrites the whole table to apply one. */
  it('refuses a required uuid, because filling one would rewrite the table', async () => {
    const { api } = build();
    const response = await api.fetch(add({ column: 'ref', type: 'uuid', required: true }));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('rewrite the table');
  });

  it('takes a default of its own, quoted by type', async () => {
    const { api, pool } = build();

    await api.fetch(add({ column: 'label', type: 'text', required: true, default: "o'brien" }));
    // The quote is doubled, the way it is in an identifier — this is the one literal in the package.
    expect(statementOf(pool)).toContain(`DEFAULT 'o''brien' NOT NULL`);

    await api.fetch(add({ column: 'amount', type: 'numeric', default: '10.5' }));
    expect(statementOf(pool)).toContain('DEFAULT 10.5');

    await api.fetch(add({ column: 'seen_at', type: 'timestamptz', default: '2026-08-24T10:00:00Z' }));
    expect(statementOf(pool)).toContain(`DEFAULT '2026-08-24T10:00:00Z'::timestamptz`);

    await api.fetch(add({ column: 'ref', type: 'uuid', default: '018f0000-0000-4000-8000-000000000000' }));
    expect(statementOf(pool)).toContain(`::uuid`);
  });

  it('refuses a default the type cannot hold', async () => {
    const { api } = build();

    expect((await api.fetch(add({ column: 'a', type: 'integer', default: 'много' }))).status).toBe(400);
    expect((await api.fetch(add({ column: 'b', type: 'timestamptz', default: 'вчера' }))).status).toBe(400);
    expect((await api.fetch(add({ column: 'c', type: 'jsonb', default: '{сломано' }))).status).toBe(400);
    expect((await api.fetch(add({ column: 'd', type: 'boolean', default: 'может быть' }))).status).toBe(400);
    expect((await api.fetch(add({ column: 'e', type: 'uuid', default: 'не uuid' }))).status).toBe(400);
  });

  /**
   * What was done is what is written, and nothing beside it.
   *
   * The old journal kept the request as well as the statement, which was two records of one fact. A
   * migration has room for one, and the statement is the one that is true: it is what ran here and
   * what will run everywhere else.
   */
  it('writes the statement that ran, defaults and all', async () => {
    const { api, written } = build();
    await api.fetch(add({ column: 'note', type: 'text', required: true, default: 'нет' }));

    expect(written.at(-1)?.sql).toContain(`DEFAULT 'нет' NOT NULL`);
    expect(written.at(-1)?.name).toBe('interface-add-public-identities-note');
  });
});

/**
 * "Is empty" asks the question the column can answer.
 *
 * For text, empty covers both null and the empty string: a person looking at a blank cell does not know
 * or care which one is there. For everything else there is only null — and this was a real refusal, not
 * a nicety. `uuid` and `jsonb` were counted as textual, so "is empty" on an id column asked `id = ''`
 * and PostgreSQL answered `invalid input syntax for type uuid: ""`.
 */
describe('asking whether a cell is empty', () => {
  const withColumn = (name: string, type: string): Table => ({
    schema: 'public',
    name: 'sample',
    columns: [{ name, type, nullable: true }],
    primaryKey: [name],
  });

  const clauseFor = (type: string, condition: string): string => {
    const { rows: statement } = selectRows(withColumn('value', type), {
      filters: [{ column: 'value', condition }],
    });
    return statement.text;
  };

  it('counts the empty string as empty for text', () => {
    expect(clauseFor('text', 'is-empty')).toContain(`("value" IS NULL OR "value" = '')`);
    expect(clauseFor('character varying', 'is-empty')).toContain(`OR "value" = ''`);
  });

  it('asks only about null for a type that cannot hold an empty string', () => {
    for (const type of ['uuid', 'jsonb', 'json', 'integer', 'timestamp with time zone', 'boolean']) {
      const clause = clauseFor(type, 'is-empty');

      expect(clause).toContain('"value" IS NULL');
      expect(clause).not.toContain(`= ''`);
    }
  });

  /**
   * An enum column, as `information_schema` describes it.
   *
   * It says `USER-DEFINED` and keeps the enum's own name in `udt_name`, which this package does not
   * read — so an enum takes the ordinary conditions and asks only about null. That is the right answer
   * rather than a lucky one: PostgreSQL refuses `''` for an enum too (`invalid input value`).
   */
  it('asks only about null for an enum, which arrives as USER-DEFINED', () => {
    expect(clauseFor('USER-DEFINED', 'is-empty')).toContain('"value" IS NULL');
    expect(clauseFor('USER-DEFINED', 'is-empty')).not.toContain(`= ''`);
    expect(conditionsFor('USER-DEFINED')).not.toContain('contains');
  });

  it('negates the same question for "is not empty"', () => {
    expect(clauseFor('uuid', 'is-not-empty')).toContain('NOT "value" IS NULL');
    expect(clauseFor('text', 'is-not-empty')).toContain(`NOT ("value" IS NULL OR "value" = '')`);
  });
});
