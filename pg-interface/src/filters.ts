import { findColumn, quote, RequestError, type Parameters, type Table } from './identifiers.js';

/**
  * The conditions a person can put on a column, and nothing beyond them: a closed list, because the
  * alternative is accepting a fragment of SQL from the browser, and then every other guard here is
  * decoration.
  */
export const TEXT_CONDITIONS = [
  'is',
  'is-not',
  'contains',
  'not-contains',
  'starts-with',
  'not-starts-with',
  'ends-with',
  'not-ends-with',
  'one-of',
  'not-one-of',
  'is-empty',
  'is-not-empty',
] as const;

/**
 * Numbers and dates: the same set, because "between two of them" is the same question either way and
 * it is the one people actually come for.
 */
export const VALUE_CONDITIONS = [
  'equals',
  'not-equals',
  'greater-than',
  'at-least',
  'less-than',
  'at-most',
  'between',
  'one-of',
  'not-one-of',
  'is-empty',
  'is-not-empty',
] as const;

/** A boolean is true, false or nothing. Comparing one with `>` is nonsense, so it is not offered. */
export const BOOLEAN_CONDITIONS = ['is-true', 'is-false', 'is-empty', 'is-not-empty'] as const;

/**
 * An identifier is matched, not ordered: `>` on a uuid means nothing a person could use. Matching a
 * fragment stays, because a uuid is usually recognised by its first few characters.
 */
export const UUID_CONDITIONS = [
  'is',
  'is-not',
  'contains',
  'starts-with',
  'one-of',
  'not-one-of',
  'is-empty',
  'is-not-empty',
] as const;

/**
 * A json document is searched, not compared. Equality would be equality of the whole document as text,
 * which is true only of a document somebody already has in front of them.
 */
export const JSON_CONDITIONS = ['contains', 'not-contains', 'is-empty', 'is-not-empty'] as const;

export type Condition =
  | (typeof TEXT_CONDITIONS)[number]
  | (typeof VALUE_CONDITIONS)[number]
  | (typeof BOOLEAN_CONDITIONS)[number]
  | (typeof UUID_CONDITIONS)[number]
  | (typeof JSON_CONDITIONS)[number];

/**
 * Which conditions apply to a column, by what `information_schema` calls its type.
 *
 * Five sets rather than two: offering "greater than" for a boolean or "contains" for a number is how an
 * interface teaches a person not to trust its menus. The sets are the only place types are read, and
 * every condition in them is an ordinary comparison — nothing here belongs to PostgreSQL.
 */
export function conditionsFor(type: string): readonly Condition[] {
  if (isJson(type)) return JSON_CONDITIONS;
  if (isUuid(type)) return UUID_CONDITIONS;
  if (isBoolean(type)) return BOOLEAN_CONDITIONS;
  return isTextual(type) ? TEXT_CONDITIONS : VALUE_CONDITIONS;
}

/**
 * Types that take text conditions: matching a fragment of them makes sense.
 *
 * Wider than the types that are actually text, on purpose — a uuid or a timestamp is recognised by its
 * first characters, and `contains` on one is a question people ask. That works because the column is
 * cast to text first. What does **not** follow is that such a column can hold an empty string — see
 * `holdsEmptyString`.
 */
function isTextual(type: string): boolean {
  return /char|text|uuid|json|name/i.test(type);
}

/**
 * Types where the empty string is a value the column can hold.
 *
 * Only real text. Asking `uuid = ''` or `jsonb = ''` is not a filter that finds nothing — it is a value
 * PostgreSQL refuses to read, and the request fails with `invalid input syntax`.
 *
 * These names are what `information_schema` calls the type, which is narrower than the names of the
 * types themselves — checked by listing them. An enum column arrives as `USER-DEFINED` (the enum's own
 * name is in `udt_name`, which this package does not read), so it takes the ordinary conditions and
 * asks only about null: right, because PostgreSQL refuses `''` for an enum as well. A domain arrives as
 * the type it is built on, so a domain over `jsonb` cannot slip in here either.
 */
function holdsEmptyString(type: string): boolean {
  return /char|text|name/i.test(type);
}

function isJson(type: string): boolean {
  return /json/i.test(type);
}

function isUuid(type: string): boolean {
  return /uuid/i.test(type);
}

function isBoolean(type: string): boolean {
  return /bool/i.test(type);
}

/** Conditions that ask about presence or truth rather than content, so they carry no value. */
const WITHOUT_VALUE = new Set<Condition>(['is-empty', 'is-not-empty', 'is-true', 'is-false']);

const WITH_LIST = new Set<Condition>(['one-of', 'not-one-of']);
const WITH_RANGE = new Set<Condition>(['between']);

export interface Filter {
  column: string;
  condition: Condition;
  value?: unknown;
}

export type Combine = 'and' | 'or';

/** Every column is looked up, every condition is from the lists above, every value is a parameter. */
export function whereClause(
  table: Table,
  filters: unknown,
  combine: unknown,
  parameters: Parameters,
): string | null {
  if (filters === undefined || filters === null) return null;
  if (!Array.isArray(filters)) throw new RequestError(400, 'Filters are a list.');
  if (filters.length === 0) return null;

  const joiner = combineOf(combine);
  const fragments = filters.map((filter) => fragmentOf(table, filter, parameters));

  return fragments.join(` ${joiner.toUpperCase()} `);
}

function combineOf(combine: unknown): Combine {
  if (combine === undefined || combine === null) return 'and';
  if (combine !== 'and' && combine !== 'or') {
    throw new RequestError(400, 'Filters are combined with "and" or "or".');
  }
  return combine;
}

function fragmentOf(table: Table, filter: unknown, parameters: Parameters): string {
  if (typeof filter !== 'object' || filter === null) {
    throw new RequestError(400, 'A filter is an object with a column and a condition.');
  }

  const { column: columnName, condition, value } = filter as Filter;
  const column = findColumn(table, columnName);
  const allowed = conditionsFor(column.type);

  if (!allowed.includes(condition)) {
    throw new RequestError(
      400,
      `Condition "${String(condition)}" does not apply to ${column.name} (${column.type}).`,
    );
  }

  const target = quote(column.name);

  if (WITHOUT_VALUE.has(condition)) {
    if (condition === 'is-true') return `${target} IS TRUE`;
    if (condition === 'is-false') return `${target} IS FALSE`;

    /*
     * Empty is null, and for text the empty string too — a person filtering an empty cell does not care
     * which. Only for text: `uuid` and `jsonb` counted as textual here once, so "is empty" on an id
     * column asked `id = ''` and PostgreSQL answered `invalid input syntax for type uuid: ""`.
     */
    const empty = holdsEmptyString(column.type)
      ? `(${target} IS NULL OR ${target} = '')`
      : `${target} IS NULL`;
    return condition === 'is-empty' ? empty : `NOT ${empty}`;
  }

  if (value === undefined || value === null) {
    throw new RequestError(400, `Condition "${condition}" needs a value.`);
  }

  if (WITH_LIST.has(condition)) {
    const values = listOf(value, condition);
    // `IN (…)` with one placeholder per value rather than an array: this is the same SQL everywhere,
    // where PostgreSQL's own `= ANY($1)` would have to be rewritten for another database.
    const placeholders = values.map((entry) => parameters.add(entry)).join(', ');
    return condition === 'one-of' ? `${target} IN (${placeholders})` : `${target} NOT IN (${placeholders})`;
  }

  if (WITH_RANGE.has(condition)) {
    const [from, to] = rangeOf(value);
    // Both ends included: a person asking for 1 to 10 means ten numbers, not eight.
    return `${target} BETWEEN ${parameters.add(from)} AND ${parameters.add(to)}`;
  }

  switch (condition) {
    case 'is':
    case 'equals':
      return `${target} = ${parameters.add(value)}`;
    case 'is-not':
    case 'not-equals':
      return `${target} <> ${parameters.add(value)}`;
    case 'greater-than':
      return `${target} > ${parameters.add(value)}`;
    case 'at-least':
      return `${target} >= ${parameters.add(value)}`;
    case 'less-than':
      return `${target} < ${parameters.add(value)}`;
    case 'at-most':
      return `${target} <= ${parameters.add(value)}`;
    /*
     * `ILIKE` on the text of the column rather than on the column itself: a uuid or a timestamp has
     * no `ILIKE`, and casting is what lets "contains" mean the same thing everywhere in the
     * interface. The pattern is a parameter, and the wildcards are added to the value, not to the
     * SQL — so a `%` a person typed is a literal `%`.
     */
    case 'contains':
      return `${target}::text ILIKE ${parameters.add(`%${escapeLike(value)}%`)}`;
    case 'not-contains':
      return `${target}::text NOT ILIKE ${parameters.add(`%${escapeLike(value)}%`)}`;
    case 'starts-with':
      return `${target}::text ILIKE ${parameters.add(`${escapeLike(value)}%`)}`;
    case 'not-starts-with':
      return `${target}::text NOT ILIKE ${parameters.add(`${escapeLike(value)}%`)}`;
    case 'ends-with':
      return `${target}::text ILIKE ${parameters.add(`%${escapeLike(value)}`)}`;
    case 'not-ends-with':
      return `${target}::text NOT ILIKE ${parameters.add(`%${escapeLike(value)}`)}`;
    default:
      throw new RequestError(400, `Unknown condition "${String(condition)}".`);
  }
}

/**
 * The values of a list condition.
 *
 * A list arrives as a list; a single value is accepted as a list of one, because a filter typed into
 * one box and then switched to "one of" would otherwise be refused for no reason a person can see.
 */
function listOf(value: unknown, condition: Condition): unknown[] {
  const values = (Array.isArray(value) ? value : [value]).filter(
    (entry) => entry !== undefined && entry !== null && entry !== '',
  );

  if (values.length === 0) throw new RequestError(400, `Condition "${condition}" needs at least one value.`);
  if (values.length > LIST_LIMIT) {
    throw new RequestError(400, `Condition "${condition}" takes at most ${LIST_LIMIT} values.`);
  }

  return values;
}

/** How many values one list condition may carry. A bound, not a judgement of what is reasonable. */
const LIST_LIMIT = 200;

/** The two ends of a range, in the order they were given — a range needs both to mean anything. */
function rangeOf(value: unknown): [unknown, unknown] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new RequestError(400, 'Condition "between" takes two values: the start and the end.');
  }

  const [from, to] = value;
  if (from === undefined || from === null || from === '' || to === undefined || to === null || to === '') {
    throw new RequestError(400, 'Condition "between" needs both ends of the range.');
  }

  return [from, to];
}

/**
 * A pattern the person typed is text, not syntax: `50%` finds `50%` and not "starts with 50".
 * `\` is the default escape character in `LIKE`, so it has to be escaped first.
 */
function escapeLike(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/[%_]/g, (character) => `\\${character}`);
}

export interface Order {
  column: string;
  direction: 'asc' | 'desc';
}

/** `ORDER BY` from what a request asked for, or null. Directions are a pair, never a string. */
export interface OrderBy {
  /** The `ORDER BY` levels a person asked for, ready to go into the statement. */
  sql: string;
  /** Which columns they name — what keeps the key from being appended a second time. */
  columns: string[];
}

export function orderClause(table: Table, order: unknown): OrderBy | null {
  if (order === undefined || order === null) return null;
  if (!Array.isArray(order)) throw new RequestError(400, 'Sorting is a list.');
  if (order.length === 0) return null;

  const columns: string[] = [];

  const fragments = order.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new RequestError(400, 'A sort entry is an object with a column and a direction.');
    }
    const { column: columnName, direction } = entry as Order;
    const column = findColumn(table, columnName);

    if (direction !== 'asc' && direction !== 'desc') {
      throw new RequestError(400, 'A direction is "asc" or "desc".');
    }

    columns.push(column.name);

    /*
     * Nulls last, but only where nulls can occur.
     *
     * Nulls last in both directions is a decision about reading: they are the least interesting rows
     * either way, and PostgreSQL's default puts them first on `DESC`, which reads as a fault in a
     * table. On a `NOT NULL` column it says nothing — and costs a great deal, because `DESC NULLS
     * LAST` does not match the order of a btree index, so the whole table is sorted where a backward
     * walk of the index would have done. Measured on 200 000 rows: 15.3 ms against 0.024 ms, and the
     * plan changes from `Index Only Scan Backward` to a full sort. PostgreSQL does not work this out
     * from the column being `NOT NULL`, so the catalogue is asked here instead.
     */
    const nulls = column.nullable ? ' NULLS LAST' : '';
    return `${quote(column.name)} ${direction.toUpperCase()}${nulls}`;
  });

  return { sql: fragments.join(', '), columns };
}
