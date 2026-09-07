/**
 * Where SQL is built, and the one place a name from a request can reach it.
 *
 * This is the difference between this package and the third-party console it replaces. There, a
 * person wrote the query and owned it. Here the query is assembled from a request body, so every
 * table and column named in it is untrusted input — and a column name cannot be a bound parameter,
 * which is exactly why it has to be checked against the catalogue instead.
 *
 * The rule this file exists to keep: **values are parameters, identifiers are looked up.** Nothing
 * else may be interpolated into SQL anywhere in this package.
 */

export interface Column {
  name: string;
  /** `data_type` from `information_schema`, for the interface to render by. */
  type: string;
  nullable: boolean;
  /**
   * Whether the database fills this column in when a new row says nothing about it.
   *
   * Only insertion needs it: a `not null` column with a default may be left out of a form, and one
   * without a default may not — the row would be refused. Editing an existing row never asks.
   */
  hasDefault: boolean;
  /**
   * Whether the database, and only the database, decides this value: an identity column or one
   * computed from others. A new row must not carry one — PostgreSQL refuses `GENERATED ALWAYS`
   * outright, and a value written into a `BY DEFAULT` identity quietly desynchronises its sequence.
   */
  generated: boolean;
}

/** A table as the catalogue describes it, with the key rows are addressed by. */
export interface Table {
  schema: string;
  name: string;
  columns: Column[];
  /** The primary key columns in order, or an empty list when the table has none. */
  primaryKey: string[];
  /**
   * The column that records the order rows arrived in — a counter or a creation time — when the table
   * has one. What a table opens sorted by, because a uuid key sorts in no order a person can see.
   */
  naturalOrder?: string;
}

/**
 * Quotes an identifier for SQL.
 *
 * Only ever applied to a name that came out of the catalogue, so this is the second lock rather than
 * the first. It stays because a lookup that is accidentally skipped one day should still not hand
 * PostgreSQL a name it can read as syntax.
 */
export function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** `schema.table`, both quoted. */
export function qualify(table: Table): string {
  return `${quote(table.schema)}.${quote(table.name)}`;
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/** The table a request names, or a refusal. Never a name the catalogue did not give us. */
export function findTable(tables: Table[], schema: unknown, name: unknown): Table {
  if (typeof schema !== 'string' || typeof name !== 'string') {
    throw new RequestError(400, 'A table is named by its schema and its name, both strings.');
  }

  const found = tables.find((table) => table.schema === schema && table.name === name);
  if (!found) throw new RequestError(404, `No table ${schema}.${name} in this database.`);
  return found;
}

/** The column a request names, checked against the table it is supposed to belong to. */
export function findColumn(table: Table, name: unknown): Column {
  if (typeof name !== 'string') throw new RequestError(400, 'A column is named by a string.');

  const found = table.columns.find((column) => column.name === name);
  if (!found) {
    throw new RequestError(400, `No column ${name} in ${table.schema}.${table.name}.`);
  }
  return found;
}

/**
 * Collects values for a parameterised statement, and hands out the placeholders.
 *
 * A small object rather than an index passed around: every `$n` in this package comes from here, so
 * a placeholder and its value cannot drift apart while a query is being assembled.
 */
export class Parameters {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}
