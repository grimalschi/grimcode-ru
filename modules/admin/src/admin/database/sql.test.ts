import { describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { COUNT_LIMIT, countRows, readCatalogue, type Queryable } from './catalog.js';
import { conditionsFor } from './filters.js';
import type { Table } from './identifiers.js';
import { typeParsers } from '../../db/type-parsers.js';
import { deleteRow, insertRow, pageOf, selectRows, updateRow } from './statements.js';


/** A table with a single-column key, and one with a key of two — both shapes exist in this project. */
const rows: Table = {
  schema: 'auth',
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
  schema: 'auth',
  name: 'administrator_grants',
  columns: [
    { name: 'administrator_id', type: 'uuid', nullable: false, hasDefault: false, generated: false },
    { name: 'module', type: 'character varying', nullable: false, hasDefault: false, generated: false },
    { name: 'note', type: 'text', nullable: true, hasDefault: false, generated: false },
  ],
  primaryKey: ['administrator_id', 'module'],
};

/** A table the planner has an estimate for, small enough that the estimate is not used. */
const sessions: Table = {
  schema: 'auth',
  name: 'sessions',
  columns: [
    { name: 'id', type: 'uuid', nullable: false, hasDefault: false, generated: false },
    { name: 'expires_at', type: 'timestamp with time zone', nullable: false, hasDefault: false, generated: false },
  ],
  primaryKey: ['id'],
};

/** A table with no estimate that turns out to hold more rows than the count is willing to read. */
const audit: Table = {
  schema: 'auth',
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
    expect(() => pageOf({ limit: '10' })).toThrow(TRPCError);
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
      'INSERT INTO "auth"."identities" ("id", "email") VALUES ($1, $2) ' +
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

    expect(statement.text).toBe('INSERT INTO "auth"."auth_audit" DEFAULT VALUES RETURNING "id"');
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

    expect(statement.text).toBe('UPDATE "auth"."identities" SET "email" = $1 WHERE "id" = $2');
    expect(statement.values).toEqual(['new@example.test', 'u-1']);
  });

  it('needs both columns of a two-column key', () => {
    expect(() =>
      updateRow(grants, { key: { administrator_id: 'a-1' }, values: { note: 'hi' } }),
    ).toThrow(/administrator_id, module/);

    const statement = updateRow(grants, {
      key: { administrator_id: 'a-1', module: 'auth' },
      values: { note: 'hi' },
    });
    expect(statement.text).toMatch(/WHERE "administrator_id" = \$2 AND "module" = \$3/);
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

/** A catalogue and row-query recorder without a live PostgreSQL server. */
type FakePool = Queryable & {
  asked: { text: string; values: unknown[] }[];
  /** The most queries this pool ever had in flight at once — how many rounds a request took. */
  mostAtOnce: number;
  /** The answer itself, without the counting `query` wraps it in. */
  answer<Row>(text: string, values?: unknown[]): { rows: Row[]; rowCount: number | null };
};

function fakePool(tables: Table[]): FakePool {
  const asked: { text: string; values: unknown[] }[] = [];

  let inFlight = 0;

  const pool: FakePool = {
    asked,
    mostAtOnce: 0,
    async query<Row>(text: string, values: unknown[] = []) {
      asked.push({ text, values });

      /*
       * Answering is deferred a tick, and while it is deferred the query counts as in flight. That is
       * what makes the number of rounds a request takes visible: queries started together overlap,
       * queries awaited one after another never do.
       */
      inFlight += 1;
      pool.mostAtOnce = Math.max(pool.mostAtOnce, inFlight);
      try {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        return pool.answer<Row>(text, values);
      } finally {
        inFlight -= 1;
      }
    },
    answer<Row>(text: string, values: unknown[] = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK|ALTER TABLE)/.test(text)
        || text.includes('pg_advisory_xact_lock')) {
        throw new Error('The interface must not execute structure changes.');
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

      if (text.includes('information_schema.columns')) {
        const rows = tables.filter((table) => table.schema === values[0]).flatMap((table) =>
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
        const rows = tables.filter((table) => table.schema === values[0]).flatMap((table) =>
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
    expect(statement.text).toContain('ORDER BY "administrator_id", "module"');
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
      order: [{ column: 'module', direction: 'desc' }],
    });

    // Dropping both would leave rows with the same module in no order at all.
    expect(statement.text).toContain('ORDER BY "module" DESC, "administrator_id"');
  });

  it('pages a keyless table by the physical address of the row', () => {
    const keyless: Table = { ...rows, primaryKey: [] };
    const { rows: statement } = selectRows(keyless, {});

    // Such a table cannot be edited here, so `ctid` is stable enough to page by.
    expect(statement.text).toContain('ORDER BY ctid');
  });
});

/**
 * Reading the catalogue is the expensive part of every request, so its two halves go out together.
 *
 * Measured on a live database: the keys cost 1.6 ms beside 5.2 ms for a small schema's columns, and 72 ms beside 160 ms on a database of two hundred tables. Awaited one after the other
 * that time was added up — and the catalogue is read for the table list, for a page of rows, and for
 * every change of shape.
 */
describe('reading the catalogue', () => {
  it('asks for columns and keys in the same round', async () => {
    const pool = fakePool(structuredClone([rows, grants]));
    await readCatalogue(pool, 'auth');

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
    schema: 'auth',
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
 * "Is empty" asks the question the column can answer.
 *
 * For text, empty covers both null and the empty string: a person looking at a blank cell does not know
 * or care which one is there. For everything else there is only null — and this was a real refusal, not
 * a nicety. `uuid` and `jsonb` were counted as textual, so "is empty" on an id column asked `id = ''`
 * and PostgreSQL answered `invalid input syntax for type uuid: ""`.
 */
describe('asking whether a cell is empty', () => {
  const withColumn = (name: string, type: string): Table => ({
    schema: 'auth',
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

describe('table metadata', () => {
  it('infers arrival order from defaults and identities, not arbitrary names', async () => {
    const { tables } = await readCatalogue(fakePool([rows, sessions, audit]), 'auth');
    expect(tables.find((table) => table.name === 'identities')?.naturalOrder).toBe('created_at');
    expect(tables.find((table) => table.name === 'auth_audit')?.naturalOrder).toBe('id');
    expect(tables.find((table) => table.name === 'sessions')?.naturalOrder).toBeUndefined();
  });

  it.each([
    ['50000', '0', { count: 50000, kind: 'estimate' }, 1],
    ['3', '3', { count: 3, kind: 'exact' }, 2],
    ['-1', String(COUNT_LIMIT + 1), { count: COUNT_LIMIT, kind: 'more' }, 2],
  ])('bounds the count when the planner reports %s', async (estimate, total, expected, calls) => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ estimate }], rowCount: 1 })
      .mockResolvedValue({ rows: [{ total }], rowCount: 1 });
    expect(await countRows({ query }, rows)).toEqual(expected);
    expect(query).toHaveBeenCalledTimes(calls);
  });
});


describe('lossless JSON values', () => {
  const table: Table = {
    schema: 'example', name: 'documents', primaryKey: ['id'],
    columns: [
      { name: 'id', type: 'integer', nullable: false, hasDefault: true, generated: true },
      { name: 'document', type: 'jsonb', nullable: false, hasDefault: false, generated: false },
    ],
  };

  it('keeps large JSON numbers as text on reads, inserts and updates', () => {
    const document = '{"large":9007199254740993,"fraction":1.234567890123456789}';
    expect(selectRows(table, {}).rows.text).toContain('"document"::text AS "document"');
    const insert = insertRow(table, { values: { document } });
    expect(insert.values).toEqual([document]);
    expect(insert.text).toContain('"document"::text AS "document"');
    expect(updateRow(table, { key: { id: 1 }, values: { document } }).values).toEqual([document, 1]);
  });

  it('keeps JSON null distinct from SQL NULL, including a NOT NULL JSON column', () => {
    expect(insertRow(table, { values: { document: 'null' } }).values).toEqual(['null']);
    expect(updateRow(table, { key: { id: 1 }, values: { document: null } }).values).toEqual([null, 1]);
  });

  it('refuses pre-parsed JSON that may have already lost precision', () => {
    expect(() => insertRow(table, { values: { document: { large: 123 } } })).toThrow(/JSON/);
  });
});
