import { quote, type Column, type Table } from './identifiers.js';

/** What the interface needs to run a query, and the only source of table and column names. */
export interface Catalogue {
  tables: Table[];
}

/** A pool, as little of one as this package needs. */
export interface Queryable {
  query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/**
 * Schemas that belong to PostgreSQL rather than to the project. Excluded rather than listing the
 * project's own, because a module is free to create a schema and the interface should show it.
 */
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'];

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  /** `YES` for a generated identity column — one of the two marks of "the order rows arrived in". */
  is_identity: 'YES' | 'NO';
  /** The column's default, which is where `nextval(…)` and `now()` show up. */
  column_default: string | null;
  /** `ALWAYS` for a column computed from other columns; `NEVER` for an ordinary one. */
  is_generated: 'ALWAYS' | 'NEVER';
}

interface KeyRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  position: number;
}

/**
 * The catalogue of one database: columns and primary keys, no joins between them. Only `BASE TABLE` —
 * a view has no key to address a row by, and this interface changes rows.
 *
 * Read on every request, not remembered: a migration runs on the first request to a module, so a
 * catalogue cached at start-up would describe the database as it was before the modules woke up.
 */
export async function readCatalogue(pool: Queryable): Promise<Catalogue> {
  /*
   * Both halves in one round: neither needs the other, and this is the expensive read of the package.
   * Measured on a live database — keys 1.6 ms beside 5.2 ms for columns, and 72 ms beside 160 ms on a
   * database of two hundred tables. Awaited one after another that cost was added on every request.
   */
  const [{ rows: columnRows }, { rows: keyRows }] = await Promise.all([
    pool.query<ColumnRow>(
      `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable,
              c.is_identity, c.is_generated, c.column_default
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema <> ALL ($1) AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
      [SYSTEM_SCHEMAS],
    ),
    pool.query<KeyRow>(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name, kcu.ordinal_position AS position
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema <> ALL ($1)
        ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position`,
      [SYSTEM_SCHEMAS],
    ),
  ]);

  const keys = new Map<string, string[]>();
  for (const row of keyRows) {
    const at = `${row.table_schema}.${row.table_name}`;
    keys.set(at, [...(keys.get(at) ?? []), row.column_name]);
  }

  const tables = new Map<string, Table>();
  const natural = new Map<string, string>();

  for (const row of columnRows) {
    const at = `${row.table_schema}.${row.table_name}`;
    const column: Column = {
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      // An identity column has no `column_default`, and it is the one thing that fills itself in.
      hasDefault: row.column_default !== null || row.is_identity === 'YES',
      generated: row.is_identity === 'YES' || row.is_generated === 'ALWAYS',
    };

    if (!natural.has(at) && arrivalOrder(row)) natural.set(at, row.column_name);

    const table = tables.get(at);
    if (table) table.columns.push(column);
    else {
      tables.set(at, {
        schema: row.table_schema,
        name: row.table_name,
        columns: [column],
        primaryKey: keys.get(at) ?? [],
      });
    }
  }

  for (const [at, column] of natural) {
    const table = tables.get(at);
    if (table) table.naturalOrder = column;
  }

  return { tables: [...tables.values()] };
}

/**
 * Whether a column records the order rows arrived in — what a person expects a table to open in, since
 * a uuid key sorts in no order anyone can see. Two schema facts count: an identity or `serial` column,
 * and a timestamp defaulting to now. Not the name: a `created_at` without a default is somebody's data.
 */
function arrivalOrder(row: ColumnRow): boolean {
  if (row.is_identity === 'YES') return true;
  if (row.column_default?.startsWith('nextval(')) return true;

  const timestamp = row.data_type.startsWith('timestamp') || row.data_type === 'date';
  const defaulted = /now\(\)|CURRENT_TIMESTAMP|CURRENT_DATE/i.test(row.column_default ?? '');
  return timestamp && defaulted;
}

/** Above this many rows the list stops counting and says "more than". */
export const COUNT_LIMIT = 10_000;

export interface RowCount {
  count: number;
  /**
   * Where the number came from, because the three cases read differently on screen: `exact` is the
   * count, `estimate` is the planner's `reltuples` for a table too large to count, and `more` says the
   * count stopped at `COUNT_LIMIT` — the number is a floor, not an approximation.
   */
  kind: 'exact' | 'estimate' | 'more';
}

/**
 * How many rows a table holds: the exact number, unless counting is expensive. `reltuples` is read
 * first and answers one question — is it cheap? Above `COUNT_LIMIT` the estimate comes back marked as
 * such; at or below, and when there is no estimate (`-1`, every table nothing has analysed), the rows
 * are counted. An estimate is never shown for a small table: `~3` beside a plain `5` reads as a fault,
 * and the only difference between them was whether autovacuum had been past.
 */
export async function countRows(pool: Queryable, table: Table): Promise<RowCount> {
  const { rows } = await pool.query<{ estimate: string }>(
    `SELECT c.reltuples::bigint AS estimate
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    [table.schema, table.name],
  );

  const estimate = Number(rows[0]?.estimate ?? -1);
  if (estimate > COUNT_LIMIT) return { count: estimate, kind: 'estimate' };

  const counted = await pool.query<{ total: string }>(
    `SELECT count(*)::bigint AS total FROM (
       SELECT 1 FROM ${quote(table.schema)}.${quote(table.name)} LIMIT ${COUNT_LIMIT + 1}
     ) AS capped`,
  );

  const total = Number(counted.rows[0]?.total ?? 0);
  return total > COUNT_LIMIT ? { count: COUNT_LIMIT, kind: 'more' } : { count: total, kind: 'exact' };
}
