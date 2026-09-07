/**
 * Which columns this interface may rename or drop, and how a change of shape is recorded.
 *
 * Nothing in `information_schema` says who created a column, and the difference matters: a column a
 * module's code reads by name would take the module down the moment it were renamed. So the answer has
 * to be recorded somewhere — and the place it is recorded is the list of applied migrations the
 * database already keeps.
 *
 * A change made here becomes a migration like any other, named after what it did:
 *
 *     interface-add-public-profiles-notes
 *     interface-rename-public-profiles-notes-remarks
 *     interface-drop-public-profiles-remarks
 *
 * Replaying those names gives the set of columns this interface owns. Nothing else is stored, and no
 * table of its own is created: the record travels with the migration that carries the change, so a
 * colleague who pulls the code gets the column and the right to rename it in the same commit.
 */

import type { Queryable } from './catalog.js';

export const MIGRATIONS_TABLE = 'schema_migrations';

/** The mark that tells this interface's migrations from a module's own. */
const PREFIX = 'interface';

/** Namespace for the advisory lock that keeps two people from taking the same version. */
const LOCK_KEY = 0x5f100001;

export type ChangeKind = 'add' | 'rename' | 'drop';

export interface Change {
  kind: ChangeKind;
  schema: string;
  table: string;
  /** The column the change is about. For a rename, the name it had before. */
  column: string;
  /** Only a rename has one. */
  to?: string;
}

/**
 * The name a change is recorded under.
 *
 * The parts are joined by a hyphen, which no identifier this interface accepts may contain — that is
 * what makes the name readable back. An identifier that came from elsewhere and does hold one is
 * refused rather than encoded, because a name that cannot be read back is ownership silently lost.
 */
export function changeName(change: Change): string {
  const parts = [PREFIX, change.kind, change.schema, change.table, change.column];
  if (change.to !== undefined) parts.push(change.to);

  const offending = parts.find((part) => part.includes('-'));
  if (offending !== undefined) {
    throw new Error(
      `"${offending}" holds a hyphen, so a migration named after this change could not be read back.`,
    );
  }

  return parts.join('-');
}

/** One recorded name, back into the change it describes, or null when it is a module's own migration. */
export function parseChangeName(name: string): Change | null {
  const parts = name.split('-');
  if (parts[0] !== PREFIX) return null;

  const [, kind, schema, table, column, to] = parts;
  if (kind !== 'add' && kind !== 'rename' && kind !== 'drop') return null;
  if (!schema || !table || !column) return null;
  if (kind === 'rename' ? !to : to !== undefined) return null;

  return kind === 'rename'
    ? { kind, schema, table, column, to: to as string }
    : { kind, schema, table, column };
}

/** PostgreSQL for "no such table" — here it means no migration has ever been applied. */
const UNDEFINED_TABLE = '42P01';

function undefinedTable(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === UNDEFINED_TABLE;
}

/**
 * The changes this interface made to one database, oldest first.
 *
 * Read from the applied migrations rather than from anything of this package's own: what is applied is
 * what the database actually has, and a migration carried in from another installation is applied by
 * the module itself long before this interface is ever opened.
 */
export async function readChanges(pool: Queryable): Promise<Change[]> {
  let rows: { name: string }[];

  try {
    ({ rows } = await pool.query<{ name: string }>(
      `SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY version`,
    ));
  } catch (error) {
    if (undefinedTable(error)) return [];
    throw error;
  }

  return rows.map((row) => parseChangeName(row.name)).filter((change): change is Change => change !== null);
}

/**
 * Which columns this interface owns, worked out by replaying its changes.
 *
 * Replayed rather than kept as a list of its own: two records of the same fact drift, and this one is
 * cheap — a handful of rows read once per request that needs it. Keys are `schema.table.column`.
 */
export function ownColumns(changes: Change[]): Set<string> {
  const owned = new Set<string>();
  const at = (change: Change, column: string) => `${change.schema}.${change.table}.${column}`;

  for (const change of changes) {
    if (change.kind === 'add') owned.add(at(change, change.column));
    if (change.kind === 'drop') owned.delete(at(change, change.column));
    if (change.kind === 'rename') {
      owned.delete(at(change, change.column));
      if (change.to) owned.add(at(change, change.to));
    }
  }

  return owned;
}

/**
 * A client that can hold a transaction.
 *
 * `Queryable` is a pool, and a pool hands each query whatever connection is free — `BEGIN` on one
 * connection and `ALTER TABLE` on another is not a transaction. So a change asks for a connection of
 * its own.
 */
export interface Transactional extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

function transactional(pool: Queryable): pool is Transactional {
  return typeof (pool as { connect?: unknown }).connect === 'function';
}

/** Everything one change of shape needs, from the two sides that know different halves of it. */
export interface ReshapePlan {
  /** The statement, already built from checked identifiers. */
  sql: string;
  /** What the migration is called, and therefore what is replayed as ownership later. */
  name: string;
  /**
   * The highest version the project holds for this database. Asked for inside the lock, and only half
   * of the answer: the database is asked too, and the higher of the two decides — see `applyReshape`.
   */
  highest(): Promise<number> | number;
  /** Writes the migration into the project. Inside the transaction, so a refusal undoes the change. */
  write(version: number): Promise<void> | void;
  /** The rule the project's migrator uses, so the recorded row matches the written file. */
  checksum(sql: string): string;
}

/**
 * Changes the shape, records the version, and writes the file — all three or none of them.
 *
 * The order inside is the reason this is worth reading: the statement and the row go first, the file
 * last, and the commit after that. Of the ways this can end badly, the only one left is a commit that
 * fails after the file was written — which leaves a migration in the project that this database has
 * not run yet. That is not a broken state at all: it is exactly what a colleague's copy looks like,
 * and the module applies it on its next start. The other order — a column in the database that is in
 * no file — is the one this whole design exists to avoid.
 */
export async function applyReshape(pool: Queryable, plan: ReshapePlan): Promise<number> {
  if (!transactional(pool)) throw new Error('This pool cannot hold a transaction.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);

    /*
     * The next version, from both sides. The files say what the project holds; the database says what
     * it has actually run, and the two are not always the same — a database keeps what was applied to
     * it after a branch is changed underneath it, and taking the files' word alone answered `duplicate
     * key value violates unique constraint "schema_migrations_pkey"`. Measured, not imagined.
     */
    const { rows } = await client.query<{ highest: number }>(
      `SELECT COALESCE(MAX(version), 0) AS highest FROM ${MIGRATIONS_TABLE}`,
    );
    const version = Math.max(await plan.highest(), Number(rows[0]?.highest ?? 0)) + 1;

    await client.query(plan.sql);
    await client.query(
      `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
      [version, plan.name, plan.checksum(plan.sql)],
    );

    await plan.write(version);

    await client.query('COMMIT');
    return version;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
