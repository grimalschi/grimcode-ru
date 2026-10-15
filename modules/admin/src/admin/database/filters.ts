import { TRPCError } from '@trpc/server';

import { findColumn, quote, type Column, type Parameters, type Table } from './identifiers.js';

/**
 * The conditions a person can put on a column, and nothing beyond them: a closed list, because the
 * alternative is accepting a fragment of SQL from the browser, and then every other guard here is
 * decoration.
 *
 * Every "… or empty" condition exists because of how SQL treats a missing value: `city <> 'Москва'`
 * is neither true nor false for an empty cell, so the row is dropped — and a person asking for
 * "everything except Москва" expects to see it. The plain condition keeps SQL's answer; the "or empty"
 * one gives the person's.
 */
export const TEXT_CONDITIONS = [
  'is',
  'is-not',
  'not-equals-or-empty',
  'contains',
  'not-contains',
  'not-contains-or-empty',
  'starts-with',
  'not-starts-with',
  'ends-with',
  'not-ends-with',
  'one-of',
  'not-one-of',
  'empty-string',
  'not-empty-string',
  'length-over',
  'length-under',
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
  'not-equals-or-empty',
  'greater-than',
  'at-least',
  'less-than',
  'at-most',
  'between',
  'not-between',
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
  'not-equals-or-empty',
  'contains',
  'starts-with',
  'one-of',
  'not-one-of',
  'is-empty',
  'is-not-empty',
] as const;

/**
 * A json document is searched as text, asked about its keys, or compared whole — the last mostly to
 * find `{}`. Key conditions take a path (`nested.deep`); `has-key` needs `jsonb`, plain `json` has no
 * such operator and gets the set without it.
 */
export const JSON_CONDITIONS = [
  'equals',
  'not-equals',
  'not-equals-or-empty',
  'contains',
  'not-contains',
  'not-contains-or-empty',
  'has-key',
  'lacks-key',
  'key-equals',
  'key-contains',
  'is-empty',
  'is-not-empty',
] as const;

const JSON_TEXT_CONDITIONS = JSON_CONDITIONS.filter((condition) => condition !== 'has-key' && condition !== 'lacks-key');

/**
 * An array is asked about its elements. Comparing two arrays with `<` is element by element and then
 * by length — an order nobody can use — so only equality of the whole literal remains from the
 * ordinary set.
 */
export const ARRAY_CONDITIONS = [
  'equals',
  'not-equals',
  'not-equals-or-empty',
  'one-of',
  'not-one-of',
  'array-has',
  'array-lacks',
  'array-has-all',
  'count-over',
  'count-under',
  'is-empty',
  'is-not-empty',
] as const;

/** A range is asked whether it contains a value; ordering two ranges is as meaningless as for arrays. */
export const RANGE_CONDITIONS = [
  'equals',
  'not-equals',
  'not-equals-or-empty',
  'one-of',
  'not-one-of',
  'range-has',
  'is-empty',
  'is-not-empty',
] as const;

/** Network addresses: matched, never ordered. */
export const PLAIN_CONDITIONS = [
  'equals',
  'not-equals',
  'not-equals-or-empty',
  'one-of',
  'not-one-of',
  'is-empty',
  'is-not-empty',
] as const;

export type Condition =
  | (typeof TEXT_CONDITIONS)[number]
  | (typeof VALUE_CONDITIONS)[number]
  | (typeof BOOLEAN_CONDITIONS)[number]
  | (typeof UUID_CONDITIONS)[number]
  | (typeof JSON_CONDITIONS)[number]
  | (typeof ARRAY_CONDITIONS)[number]
  | (typeof RANGE_CONDITIONS)[number]
  | (typeof PLAIN_CONDITIONS)[number];

/**
 * Which conditions apply to a column, by what `information_schema` calls its type (`data_type`).
 *
 * Eight sets rather than two: offering "greater than" for a boolean or "contains" for a number is how
 * an interface teaches a person not to trust its menus. The sets are the only place types are read.
 * `data_type` is enough to choose: an array is `ARRAY`, a range is its own name (`int4range`), json
 * and jsonb are spelled apart. A range whose element type is not known here (see
 * `rangeElementType`) is offered no "contains value", because the cast could not be written.
 */
export function conditionsFor(type: string): readonly Condition[] {
  if (type === 'jsonb') return JSON_CONDITIONS;
  if (type === 'json') return JSON_TEXT_CONDITIONS;
  if (isUuid(type)) return UUID_CONDITIONS;
  if (isBoolean(type)) return BOOLEAN_CONDITIONS;
  if (type === 'ARRAY') return ARRAY_CONDITIONS;
  if (isRange(type)) {
    return rangeElementType(type) ? RANGE_CONDITIONS : RANGE_CONDITIONS.filter((condition) => condition !== 'range-has');
  }
  if (isNetwork(type)) return PLAIN_CONDITIONS;
  return holdsEmptyString(type) ? TEXT_CONDITIONS : VALUE_CONDITIONS;
}

/**
 * Types where the empty string is a value the column can hold — real text, and the only types that
 * get the text conditions. A uuid or a timestamp is searched by fragment through its own set.
 *
 * These names are what `information_schema` calls the type, which is narrower than the names of the
 * types themselves — checked by listing them. An enum column arrives as `USER-DEFINED` (the enum's own
 * name is in `udt_name`, which this database browser does not read), so it takes the ordinary
 * conditions. A domain arrives as the type it is built on, so a domain over `jsonb` cannot slip in.
 */
function holdsEmptyString(type: string): boolean {
  return /char|text|name/i.test(type);
}

function isUuid(type: string): boolean {
  return /uuid/i.test(type);
}

function isBoolean(type: string): boolean {
  return /bool/i.test(type);
}

function isRange(type: string): boolean {
  return /(multi)?range$/.test(type);
}

function isNetwork(type: string): boolean {
  return /^(inet|cidr|macaddr8?)$/.test(type);
}

/**
 * What a range holds, for `range @> value`: PostgreSQL cannot infer the parameter's type from the
 * operator, so the value is cast explicitly. The names are PostgreSQL's own and never come from a
 * request.
 */
function rangeElementType(type: string): string | undefined {
  const base = type.replace(/multirange$/, 'range');
  return {
    int4range: 'integer', int8range: 'bigint', numrange: 'numeric',
    daterange: 'date', tsrange: 'timestamp', tstzrange: 'timestamptz',
  }[base];
}

/** Conditions that ask about presence or truth rather than content, so they carry no value. */
const WITHOUT_VALUE = new Set<Condition>([
  'is-empty', 'is-not-empty', 'is-true', 'is-false', 'empty-string', 'not-empty-string',
]);

const WITH_LIST = new Set<Condition>(['one-of', 'not-one-of', 'array-has-all']);
const WITH_RANGE = new Set<Condition>(['between', 'not-between']);
/** A key (or dotted path) and a value: two strings, both needed. */
const WITH_PAIR = new Set<Condition>(['key-equals', 'key-contains']);

export type Join = 'and' | 'or';

export interface Filter {
  column: string;
  condition: Condition;
  value?: unknown;
  /** How this condition attaches to the one before it. The first condition has none. */
  join?: Join;
}

/**
 * Every column is looked up, every condition is from the lists above, every value is a parameter.
 *
 * Conditions form a chain, each joined to the previous one with `and` or `or`, and the chain reads
 * the way SQL does: `and` binds tighter, so `a OR b AND c` is `a OR (b AND c)`. The clause makes
 * that explicit — consecutive `and` conditions become one parenthesised group, `or` separates the
 * groups — so what PostgreSQL evaluates is what the screen draws as blocks. The owner chose SQL's
 * precedence over left-to-right reading (8 October 2026); the panel shows the blocks so nobody has
 * to remember it.
 *
 * `caseSensitive` turns every `ILIKE` into `LIKE`; `=` and `IN` never ignore case anyway.
 */
export function whereClause(
  table: Table,
  filters: unknown,
  caseSensitive: unknown,
  parameters: Parameters,
): string | null {
  if (filters === undefined || filters === null) return null;
  if (!Array.isArray(filters)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Filters are a list.' });
  if (filters.length === 0) return null;

  const like = caseSensitive === true ? 'LIKE' : 'ILIKE';
  const groups: string[][] = [];
  filters.forEach((filter, index) => {
    const fragment = fragmentOf(table, filter, parameters, like);
    if (index === 0 || joinOf(filter) === 'or') groups.push([fragment]);
    else groups[groups.length - 1]!.push(fragment);
  });

  if (groups.length === 1) return groups[0]!.join(' AND ');
  return groups.map((group) => (group.length === 1 ? group[0]! : `(${group.join(' AND ')})`)).join(' OR ');
}

function joinOf(filter: unknown): Join {
  const join = typeof filter === 'object' && filter !== null ? (filter as Filter).join : undefined;
  if (join === undefined || join === null) return 'and';
  if (join !== 'and' && join !== 'or') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A condition joins the previous one with "and" or "or".' });
  }
  return join;
}

function fragmentOf(table: Table, filter: unknown, parameters: Parameters, like: 'LIKE' | 'ILIKE'): string {
  if (typeof filter !== 'object' || filter === null) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A filter is an object with a column and a condition.' });
  }

  const { column: columnName, condition, value } = filter as Filter;
  const column = findColumn(table, columnName);
  const allowed = conditionsFor(column.type);

  if (!allowed.includes(condition)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Condition "${String(condition)}" does not apply to ${column.name} (${column.type}).` });
  }

  const target = quote(column.name);

  if (WITHOUT_VALUE.has(condition)) {
    switch (condition) {
      case 'is-true': return `${target} IS TRUE`;
      case 'is-false': return `${target} IS FALSE`;
      // Empty is null and only null; text has its own "empty string", because the two look alike on
      // screen but are different values, and a person who asks for one should not get the other.
      case 'is-empty': return `${target} IS NULL`;
      case 'is-not-empty': return `${target} IS NOT NULL`;
      case 'empty-string': return `${target} = ''`;
      default: return `${target} <> ''`;
    }
  }

  if (value === undefined || value === null) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Condition "${condition}" needs a value.` });
  }

  if (WITH_LIST.has(condition)) {
    const values = listOf(value, condition);
    const placeholders = values.map((entry) => parameters.add(entry)).join(', ');
    /*
     * `ARRAY[$1, $2]` is a text array until told otherwise, and `uuid[] @> text[]` has no operator —
     * measured: the probe failed with 42883. The cast names the column's own type as the catalogue
     * reports it (`format_type`: `uuid[]`, `character varying(50)[]`), never anything from a request.
     */
    if (condition === 'array-has-all') return `${target} @> ARRAY[${placeholders}]${arrayCast(column)}`;
    // `IN (…)` with one placeholder per value rather than an array: this is the same SQL everywhere,
    // where PostgreSQL's own `= ANY($1)` would have to be rewritten for another database.
    return condition === 'one-of' ? `${target} IN (${placeholders})` : `${target} NOT IN (${placeholders})`;
  }

  if (WITH_RANGE.has(condition)) {
    const [from, to] = rangeOf(value, condition);
    // Both ends included: a person asking for 1 to 10 means ten numbers, not eight.
    const between = `BETWEEN ${parameters.add(from)} AND ${parameters.add(to)}`;
    return condition === 'between' ? `${target} ${between}` : `${target} NOT ${between}`;
  }

  if (WITH_PAIR.has(condition)) {
    const [path, text] = pairOf(value, condition);
    // `#>>` walks a path given as a text array; the driver sends a JavaScript array as one.
    const walked = `${target} #>> ${parameters.add(path.split('.'))}`;
    return condition === 'key-equals'
      ? `${walked} = ${parameters.add(text)}`
      : `${walked} ${like} ${parameters.add(`%${escapeLike(text)}%`)}`;
  }

  switch (condition) {
    case 'is':
    case 'equals':
      return `${target} = ${parameters.add(value)}`;
    case 'is-not':
    case 'not-equals':
      return `${target} <> ${parameters.add(value)}`;
    case 'not-equals-or-empty':
      return `${target} IS DISTINCT FROM ${parameters.add(value)}`;
    case 'greater-than':
      return `${target} > ${parameters.add(value)}`;
    case 'at-least':
      return `${target} >= ${parameters.add(value)}`;
    case 'less-than':
      return `${target} < ${parameters.add(value)}`;
    case 'at-most':
      return `${target} <= ${parameters.add(value)}`;
    /*
     * `ILIKE` (or `LIKE`) on the text of the column rather than on the column itself: a uuid or a
     * json document has no `ILIKE`, and casting is what lets "contains" mean the same thing
     * everywhere in the interface. The pattern is a parameter, and the wildcards are added to the
     * value, not to the SQL — so a `%` a person typed is a literal `%`.
     */
    case 'contains':
      return `${target}::text ${like} ${parameters.add(`%${escapeLike(value)}%`)}`;
    case 'not-contains':
      return `${target}::text NOT ${like} ${parameters.add(`%${escapeLike(value)}%`)}`;
    case 'not-contains-or-empty':
      return `(${target} IS NULL OR ${target}::text NOT ${like} ${parameters.add(`%${escapeLike(value)}%`)})`;
    case 'starts-with':
      return `${target}::text ${like} ${parameters.add(`${escapeLike(value)}%`)}`;
    case 'not-starts-with':
      return `${target}::text NOT ${like} ${parameters.add(`${escapeLike(value)}%`)}`;
    case 'ends-with':
      return `${target}::text ${like} ${parameters.add(`%${escapeLike(value)}`)}`;
    case 'not-ends-with':
      return `${target}::text NOT ${like} ${parameters.add(`%${escapeLike(value)}`)}`;
    // Length in characters, which is what a person counts; `octet_length` would count bytes.
    case 'length-over':
      return `length(${target}) > ${parameters.add(value)}`;
    case 'length-under':
      return `length(${target}) < ${parameters.add(value)}`;
    // `= ANY` infers the element type from the array, so a uuid typed as text is read as a uuid.
    case 'array-has':
      return `${parameters.add(value)} = ANY(${target})`;
    case 'array-lacks':
      return `NOT (${parameters.add(value)} = ANY(${target}))`;
    case 'count-over':
      return `cardinality(${target}) > ${parameters.add(value)}`;
    case 'count-under':
      return `cardinality(${target}) < ${parameters.add(value)}`;
    // The function rather than `?`: the driver's placeholders are `$n`, but a bare `?` in SQL is a
    // trap for every tool that reads the statement later.
    case 'has-key':
      return `jsonb_exists(${target}, ${parameters.add(value)})`;
    case 'lacks-key':
      return `NOT jsonb_exists(${target}, ${parameters.add(value)})`;
    case 'range-has':
      return `${target} @> ${parameters.add(value)}::${rangeElementType(column.type)}`;
    default:
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Unknown condition "${String(condition)}".` });
  }
}

/** The column's own array type for a cast, from the catalogue; nothing when the catalogue did not say. */
function arrayCast(column: Column): string {
  return typeof column.sqlType === 'string' && column.sqlType.endsWith('[]') ? `::${column.sqlType}` : '';
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

  if (values.length === 0) throw new TRPCError({ code: 'BAD_REQUEST', message: `Condition "${condition}" needs at least one value.` });
  if (values.length > LIST_LIMIT) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Condition "${condition}" takes at most ${LIST_LIMIT} values.` });
  }

  return values;
}

/** How many values one list condition may carry. A bound, not a judgement of what is reasonable. */
const LIST_LIMIT = 200;

/** The two ends of a range, in the order they were given — a range needs both to mean anything. */
function rangeOf(value: unknown, condition: Condition): [unknown, unknown] {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Condition "${condition}" takes two values: the start and the end.` });
  }

  const [from, to] = value;
  if (from === undefined || from === null || from === '' || to === undefined || to === null || to === '') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Condition "${condition}" needs both ends of the range.` });
  }

  return [from, to];
}

/** A key path and a value, both text and both present. */
function pairOf(value: unknown, condition: Condition): [string, string] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'string') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Condition "${condition}" takes two values: the key and the value.` });
  }
  if (value[0] === '' || value[1] === '') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Condition "${condition}" needs both the key and the value.` });
  }
  return [value[0], value[1]];
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
  if (!Array.isArray(order)) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Sorting is a list.' });
  if (order.length === 0) return null;

  const columns: string[] = [];

  const fragments = order.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'A sort entry is an object with a column and a direction.' });
    }
    const { column: columnName, direction } = entry as Order;
    const column = findColumn(table, columnName);

    if (direction !== 'asc' && direction !== 'desc') {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'A direction is "asc" or "desc".' });
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
