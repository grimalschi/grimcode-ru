import { whereClause, orderClause } from './filters.js';
import {
  findColumn,
  Parameters,
  qualify,
  quote,
  RequestError,
  type Column,
  type Table,
} from './identifiers.js';

/** How many rows one page may hold, whatever a request asks for. */
export const MAX_PAGE = 500;
export const DEFAULT_PAGE = 50;

export interface Statement {
  text: string;
  values: unknown[];
}

export interface Page {
  limit: number;
  offset: number;
}

/** The page a request asked for, clamped. A huge `limit` is a mistake, not a permission. */
export function pageOf(body: { limit?: unknown; offset?: unknown }): Page {
  const limit = whole(body.limit, DEFAULT_PAGE, 'limit');
  const offset = whole(body.offset, 0, 'offset');

  return { limit: Math.min(Math.max(limit, 1), MAX_PAGE), offset: Math.max(offset, 0) };
}

function whole(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RequestError(400, `${name} is a whole number.`);
  }
  return value;
}

/**
 * The order a page is read in when nobody asked for one.
 *
 * There is always an order, and that is the point: without `ORDER BY` an updated row is written to the
 * end of the table, so editing the first row moved it to the bottom. Paging is unsound for the same
 * reason — `LIMIT`/`OFFSET` over an undefined order can show one row twice and another not at all.
 *
 * The primary key is the natural choice: it is unique, so the order is total, and it is indexed, so it
 * costs nothing. A table without a key cannot be edited through this interface at all, and for reading
 * it `ctid` — the physical address of the row — is unique and stable enough to page by.
 */
function byKey(table: Table, alreadySorted: string[]): string[] {
  if (table.primaryKey.length === 0) return ['ctid'];

  /*
   * A key column a person already sorted by is not added again: `ORDER BY "id" ASC NULLS LAST, "id"`
   * works and reads like a mistake. With a key of two columns only the missing ones are appended —
   * dropping both would leave the order incomplete when only one of them was chosen.
   */
  return table.primaryKey
    .filter((column) => !alreadySorted.includes(column))
    .map((column) => quote(column));
}

/** The rows of one page, and the statement that counts every row the same filters match. */
export function selectRows(
  table: Table,
  body: { filters?: unknown; combine?: unknown; order?: unknown; limit?: unknown; offset?: unknown },
): { rows: Statement; total: Statement } {
  const page = pageOf(body);

  const rowParameters = new Parameters();
  const where = whereClause(table, body.filters, body.combine, rowParameters);
  const order = orderClause(table, body.order);

  const columns = table.columns.map((column) => quote(column.name)).join(', ');
  const filtered = where === null ? '' : ` WHERE ${where}`;
  /*
   * The key goes last even when a sort was asked for: sorting by a column with repeated values leaves
   * those rows in no particular order between themselves, so they swap places between pages and after
   * an edit. With the key appended the order is total, and the sort a person chose still decides.
   */
  const levels = [...(order === null ? [] : [order.sql]), ...byKey(table, order?.columns ?? [])];
  const sorted = ` ORDER BY ${levels.join(', ')}`;

  const rows = {
    text:
      `SELECT ${columns} FROM ${qualify(table)}${filtered}${sorted} ` +
      `LIMIT ${rowParameters.add(page.limit)} OFFSET ${rowParameters.add(page.offset)}`,
    values: rowParameters.values,
  };

  /*
   * The count is its own statement with its own parameters rather than a window function beside the
   * rows: `count(*) OVER ()` returns nothing at all when the page is empty, and a person on page ten
   * of a table that shrank would be told the table is empty.
   */
  const countParameters = new Parameters();
  const countWhere = whereClause(table, body.filters, body.combine, countParameters);

  const total = {
    text: `SELECT count(*)::bigint AS total FROM ${qualify(table)}${
      countWhere === null ? '' : ` WHERE ${countWhere}`
    }`,
    values: countParameters.values,
  };

  return { rows, total };
}

/**
 * The word `null`, typed into a field that cannot hold it. The screen shows an empty value as `null`,
 * a person writes the same word back, and PostgreSQL answers `invalid input syntax for type uuid:
 * "null"` — the type system explained instead of the mistake. No uuid, number, date, boolean or json
 * document has a value spelled `null`, so the word is read as empty. Text is the exception: there
 * `null` is an ordinary string, and a column that holds words must hold that one too.
 */
const HOLDS_THE_WORD = /char|text|name/i;

function valueOf(column: Column, value: unknown): unknown {
  if (typeof value !== 'string' || !/^null$/i.test(value.trim())) return value;
  if (HOLDS_THE_WORD.test(column.type)) return value;

  if (!column.nullable) {
    throw new RequestError(
      400,
      `${column.name} cannot be empty, and "null" is not a value of type ${column.type}.`,
    );
  }

  return null;
}

/**
 * A new row. What may be left out is decided from the catalogue, not from the form: a column the
 * database fills in itself is left out of the statement so `DEFAULT` applies, and a `not null` column
 * with nothing to fall back on is refused here, where the answer can name the column and the reason.
 * `RETURNING` brings the stored row back, so the screen shows what the database actually wrote.
 */
export function insertRow(table: Table, body: { values?: unknown }): Statement {
  if (typeof body.values !== 'object' || body.values === null || Array.isArray(body.values)) {
    throw new RequestError(400, 'Values are an object of column names and values.');
  }

  const values = body.values as Record<string, unknown>;
  const given = Object.keys(values);

  for (const name of given) {
    const column = findColumn(table, name);
    if (column.generated) {
      throw new RequestError(
        400,
        `${column.name} is filled in by the database, so a new row cannot carry it.`,
      );
    }
  }

  const missing = table.columns.filter(
    (column) => !column.nullable && !column.hasDefault && !column.generated && !given.includes(column.name),
  );

  if (missing.length > 0) {
    throw new RequestError(
      400,
      `${missing.map((column) => column.name).join(', ')} ` +
        `${missing.length === 1 ? 'has' : 'have'} no default in ${describeTable(table)}, ` +
        'so a new row has to carry a value.',
    );
  }

  const parameters = new Parameters();
  const named = table.columns.filter((column) => given.includes(column.name));

  const columns = named.map((column) => quote(column.name)).join(', ');
  const placeholders = named
    .map((column) => parameters.add(valueOf(column, values[column.name])))
    .join(', ');
  const returned = table.columns.map((column) => quote(column.name)).join(', ');

  // A table where every column fills itself in: `DEFAULT VALUES` is how PostgreSQL spells that.
  const body_ = named.length === 0 ? 'DEFAULT VALUES' : `(${columns}) VALUES (${placeholders})`;

  return {
    text: `INSERT INTO ${qualify(table)} ${body_} RETURNING ${returned}`,
    values: parameters.values,
  };
}

function describeTable(table: Table): string {
  return `${table.schema}.${table.name}`;
}

/**
 * The `WHERE` that addresses exactly one row.
 *
 * Every primary key column must be present and nothing else may be: a key with one column missing
 * would match a set of rows, and an update or a delete would take them all. A table without a
 * primary key is refused here rather than addressed by its contents — matching on every column would
 * hit both of two identical rows, and there is no honest way to tell them apart.
 */
function keyClause(table: Table, key: unknown, parameters: Parameters): string {
  if (table.primaryKey.length === 0) {
    throw new RequestError(
      409,
      `${table.schema}.${table.name} has no primary key, so a single row cannot be addressed. ` +
        'Rows here can be read but not changed.',
    );
  }

  if (typeof key !== 'object' || key === null || Array.isArray(key)) {
    throw new RequestError(400, 'A key is an object of column names and values.');
  }

  const given = Object.keys(key as Record<string, unknown>);
  const missing = table.primaryKey.filter((column) => !given.includes(column));
  const extra = given.filter((column) => !table.primaryKey.includes(column));

  if (missing.length > 0 || extra.length > 0) {
    throw new RequestError(
      400,
      `The key of ${table.schema}.${table.name} is (${table.primaryKey.join(', ')}); ` +
        `received (${given.join(', ') || 'nothing'}).`,
    );
  }

  return table.primaryKey
    .map((column) => {
      const value = (key as Record<string, unknown>)[column];
      if (value === null || value === undefined) {
        throw new RequestError(400, `The key column ${column} has no value.`);
      }
      return `${quote(findColumn(table, column).name)} = ${parameters.add(value)}`;
    })
    .join(' AND ');
}

/**
 * Changing the columns of one row.
 *
 * Key columns are refused: the row is addressed by its key, so changing the key in the same
 * statement is a rename, and a rename of a row other rows point at is not a thing to do by
 * accident. Deleting the row and inserting the new one is the honest way to say that.
 */
export function updateRow(
  table: Table,
  body: { key?: unknown; values?: unknown },
): Statement {
  if (typeof body.values !== 'object' || body.values === null || Array.isArray(body.values)) {
    throw new RequestError(400, 'Values are an object of column names and values.');
  }

  const values = body.values as Record<string, unknown>;
  const names = Object.keys(values);
  if (names.length === 0) throw new RequestError(400, 'Nothing to change.');

  const keyColumns = names.filter((name) => table.primaryKey.includes(name));
  if (keyColumns.length > 0) {
    throw new RequestError(
      400,
      `${keyColumns.join(', ')} identifies the row and cannot be changed here.`,
    );
  }

  const parameters = new Parameters();
  const assignments = names
    .map((name) => {
      const column = findColumn(table, name);
      return `${quote(column.name)} = ${parameters.add(valueOf(column, values[name]))}`;
    })
    .join(', ');

  const where = keyClause(table, body.key, parameters);

  return {
    text: `UPDATE ${qualify(table)} SET ${assignments} WHERE ${where}`,
    values: parameters.values,
  };
}

/** Removing one row, addressed the same way. */
export function deleteRow(table: Table, body: { key?: unknown }): Statement {
  const parameters = new Parameters();
  const where = keyClause(table, body.key, parameters);

  return {
    text: `DELETE FROM ${qualify(table)} WHERE ${where}`,
    values: parameters.values,
  };
}
