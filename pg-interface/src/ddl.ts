/**
 * The three statements that change a table's shape, and the rules that make them safe to build.
 *
 * DDL cannot be parameterised — PostgreSQL takes no `$1` in `ALTER TABLE` — so everything here ends up
 * in the text of a statement. That is why this file accepts so little: a name that matches a strict
 * pattern, and a type from a closed list.
 *
 * One value does reach SQL as text, and only one: the default of a required column, which is what makes
 * `NOT NULL` safe — the module's `INSERT` has never heard of the column, so nothing but a default can
 * satisfy it. It is written by type rather than passed through, and `defaultFor` below is the whole of
 * that. Filling the existing rows of an optional column is a row edit instead, which goes through the
 * parameterised path like every other value in this package.
 */

import { quote, qualify, RequestError, type Table } from './identifiers.js';

/**
 * Types a column may be given: a closed list, every one of which the screen knows how to show and
 * filter. Keys are what a request sends, values are what PostgreSQL is told.
 */
export const COLUMN_TYPES: Record<string, string> = {
  text: 'text',
  integer: 'integer',
  bigint: 'bigint',
  numeric: 'numeric',
  boolean: 'boolean',
  timestamptz: 'timestamptz',
  date: 'date',
  uuid: 'uuid',
  jsonb: 'jsonb',
};

/**
 * The table this interface never reshapes: a column added to the record of applied migrations would
 * describe something that never happened — and this interface writes its own changes into that very
 * record, so it would be reshaping the ground it stands on.
 */
export const PROTECTED_TABLES = new Set(['schema_migrations']);

/**
 * A column name, narrower than what PostgreSQL accepts inside quotes: a space, a dot or cyrillic is
 * legal SQL and a nuisance in every URL and menu afterwards. 63 bytes is where PostgreSQL truncates an
 * identifier — silently, which is how this project once had five databases named after a cut slug.
 */
const NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const NAME_LIMIT = 63;

export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new RequestError(
      400,
      'A column name starts with a letter or underscore and holds only letters, digits and underscores.',
    );
  }

  if (Buffer.byteLength(name, 'utf8') > NAME_LIMIT) {
    throw new RequestError(400, `A column name is at most ${NAME_LIMIT} bytes; PostgreSQL cuts the rest.`);
  }

  return name;
}

/** The table a reshaping request names, refused when the table is one this interface protects. */
export function checkReshapable(table: Table): Table {
  if (PROTECTED_TABLES.has(table.name)) {
    throw new RequestError(400, `The shape of ${table.name} belongs to this project, not to this interface.`);
  }
  return table;
}

export function typeOf(requested: unknown): string {
  if (typeof requested !== 'string' || !(requested in COLUMN_TYPES)) {
    throw new RequestError(
      400,
      `A column is one of these types: ${Object.keys(COLUMN_TYPES).join(', ')}.`,
    );
  }
  return COLUMN_TYPES[requested] as string;
}

/**
 * What a required column of each type gets when nothing else is said.
 *
 * A required column has to have a default and has to keep it: the module's `INSERT` names the columns it
 * knows, so a column it has never heard of is satisfied by the default and by nothing else. Take the
 * default away later and the next insert fails.
 *
 * `uuid` is deliberately absent. An identifier has no zero, so the only sensible default generates one —
 * and a generating default is volatile, which makes PostgreSQL rewrite the whole table and its indexes
 * instead of just recording the default. A required uuid is refused rather than made slow.
 */
const REQUIRED_DEFAULTS: Record<string, string> = {
  text: `''`,
  integer: '0',
  bigint: '0',
  numeric: '0',
  boolean: 'false',
  timestamptz: 'now()',
  date: 'CURRENT_DATE',
  jsonb: `'{}'::jsonb`,
};

export interface NewColumn {
  /** Unchecked, like everything else out of a request body: `typeOf` is what makes it a type. */
  type: unknown;
  /** True for `NOT NULL`, which is only allowed with a default — see `REQUIRED_DEFAULTS`. */
  required?: unknown;
  /** A default of the caller's own. Parsed by type; when absent, the type's own default is used. */
  default?: unknown;
}

/**
 * `ADD COLUMN`, nullable unless asked otherwise.
 *
 * Nullable is the safe shape: the module's `INSERT` names the columns it knows, and a column it has
 * never heard of has to be satisfied by being left out. `NOT NULL` is allowed because a default makes it
 * safe again — the insert leaves the column out and PostgreSQL fills it in.
 *
 * The default is the one place in this package where a value reaches SQL as text, and that is why it is
 * parsed by type first: a number has to be a number, a date a date, a json document has to parse. A
 * string is quoted by doubling its quotes, the way an identifier is.
 */
export function addColumn(table: Table, column: string, requested: NewColumn): string {
  if (table.columns.some((existing) => existing.name === column)) {
    throw new RequestError(400, `${table.schema}.${table.name} already has a column ${column}.`);
  }

  const type = typeOf(requested.type);
  const required = requested.required === true;
  const given = requested.default;

  const value =
    given === undefined || given === null || given === ''
      ? defaultFor(requested.type, required)
      : literalOf(requested.type, given);

  const parts = [`ALTER TABLE ${qualify(table)} ADD COLUMN ${quote(column)} ${type}`];
  if (value !== null) parts.push(`DEFAULT ${value}`);
  if (required) parts.push('NOT NULL');

  return parts.join(' ');
}

/** The type's own default, or a refusal when the type has none and the column is required. */
function defaultFor(requested: unknown, required: boolean): string | null {
  if (!required) return null;

  const value = REQUIRED_DEFAULTS[String(requested)];
  if (value === undefined) {
    throw new RequestError(
      400,
      `A required ${String(requested)} column needs a default value of its own: this type has no ` +
        'neutral one, and generating a value for every existing row would rewrite the table.',
    );
  }

  return value;
}

/**
 * A default the caller chose, as SQL — checked against the type it is going into.
 *
 * The check is the whole point: PostgreSQL would refuse `'вчера'` in a date column anyway, but it would
 * refuse it at `ALTER TABLE` time with a message about syntax. Refusing here says which value and which
 * type, before anything is written down.
 */
function literalOf(requested: unknown, value: unknown): string {
  const type = String(requested);

  if (type === 'boolean') {
    if (value === true || value === 'true') return 'true';
    if (value === false || value === 'false') return 'false';
    throw new RequestError(400, 'A boolean default is true or false.');
  }

  if (type === 'integer' || type === 'bigint') {
    const number = Number(value);
    if (!Number.isInteger(number)) throw new RequestError(400, `A ${type} default is a whole number.`);
    return String(number);
  }

  if (type === 'numeric') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new RequestError(400, 'A numeric default is a number.');
    return String(number);
  }

  if (type === 'uuid') {
    const text = String(value);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
      throw new RequestError(400, 'A uuid default is a uuid.');
    }
    return `${quoteLiteral(text)}::uuid`;
  }

  if (type === 'jsonb') {
    const text = String(value);
    try {
      JSON.parse(text);
    } catch {
      throw new RequestError(400, 'A jsonb default is a json document.');
    }
    return `${quoteLiteral(text)}::jsonb`;
  }

  if (type === 'timestamptz' || type === 'date') {
    const text = String(value).trim();
    // "now" is what a person means by "the moment the row appears", and it is not a date to parse.
    if (/^now(\(\))?$/i.test(text)) return type === 'date' ? 'CURRENT_DATE' : 'now()';

    if (Number.isNaN(Date.parse(text))) {
      throw new RequestError(400, `A ${type} default is a date, or "now".`);
    }
    return `${quoteLiteral(text)}::${type}`;
  }

  return quoteLiteral(String(value));
}

/**
 * A string as a SQL literal: quotes doubled, and nothing else let through.
 *
 * A null byte is refused rather than escaped — PostgreSQL cannot hold one in text at all, and a value
 * carrying one is a mistake somewhere upstream.
 */
function quoteLiteral(value: string): string {
  if (value.includes('\0')) throw new RequestError(400, 'A default cannot carry a null byte.');
  return `'${value.replace(/'/g, "''")}'`;
}

export function renameColumn(table: Table, column: string, to: string): string {
  if (table.columns.some((existing) => existing.name === to)) {
    throw new RequestError(400, `${table.schema}.${table.name} already has a column ${to}.`);
  }

  return `ALTER TABLE ${qualify(table)} RENAME COLUMN ${quote(column)} TO ${quote(to)}`;
}

export function dropColumn(table: Table, column: string): string {
  return `ALTER TABLE ${qualify(table)} DROP COLUMN ${quote(column)}`;
}
