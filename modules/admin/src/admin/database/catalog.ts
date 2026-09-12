import { quote, type Column, type Table } from './identifiers.js';

/** What the interface needs to run a query, and the only source of table and column names. */
export interface Catalogue {
  tables: Table[];
}

/** A pool, as little of one as this database browser needs. */
export interface Queryable {
  query<Row>(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

/** Closed list: a new PostgreSQL type remains read-only until its edit tests exist. */
export const EDITABLE_PG_TYPES = new Set([
  'bool', 'int2', 'int4', 'int8', 'float4', 'float8', 'numeric', 'money',
  'char', 'bpchar', 'varchar', 'text', 'name', 'bytea', 'bit', 'varbit',
  'date', 'timestamp', 'timestamptz', 'time', 'timetz', 'interval',
  'uuid', 'json', 'jsonb', 'xml', 'inet', 'cidr', 'macaddr', 'macaddr8',
  'point', 'line', 'lseg', 'box', 'path', 'polygon', 'circle', 'tsvector', 'tsquery',
  'int4range', 'int8range', 'numrange', 'tsrange', 'tstzrange', 'daterange',
  'int4multirange', 'int8multirange', 'nummultirange', 'tsmultirange', 'tstzmultirange', 'datemultirange',
  'oid', 'pg_lsn',
]);

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  is_identity: 'YES' | 'NO';
  column_default: string | null;
  is_generated: 'ALWAYS' | 'NEVER';
  sql_type: string;
  server_encoding: string;
  type_name: string;
  type_schema: string;
  type_kind: string;
  element_name: string | null;
  element_schema: string | null;
  element_kind: string | null;
  complete_columns: boolean;
  unsafe_relation: boolean;
  unsafe_code: boolean;
  cascading_delete: boolean;
  cascading_update: boolean;
}

interface KeyRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

function supportedType(name: string, schema: string, kind: string): boolean {
  return kind === 'e' || (schema === 'pg_catalog' && EDITABLE_PG_TYPES.has(name));
}

/** Metadata is refreshed inside the write transaction after locking the relation. */
export async function readCatalogue(pool: Queryable, schema: string): Promise<Catalogue> {
  const { rows: columnRows } = await pool.query<ColumnRow>(
      `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable,
              c.is_identity, c.is_generated, c.column_default,
              format_type(a.atttypid, a.atttypmod) AS sql_type,
              current_setting('server_encoding') AS server_encoding,
              t.typname AS type_name, tn.nspname AS type_schema, t.typtype AS type_kind,
              et.typname AS element_name, en.nspname AS element_schema, et.typtype AS element_kind,
              (count(*) OVER (PARTITION BY r.oid) =
                (SELECT count(*) FROM pg_attribute physical
                  WHERE physical.attrelid = r.oid AND physical.attnum > 0 AND NOT physical.attisdropped)
              ) AS complete_columns,
              (r.relkind <> 'r' OR am.amname <> 'heap' OR r.relispartition OR r.relrowsecurity OR r.relhasrules
                OR EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = r.oid OR i.inhparent = r.oid)
                OR EXISTS (SELECT 1 FROM pg_trigger tr WHERE tr.tgrelid = r.oid AND NOT tr.tgisinternal)
              ) AS unsafe_relation,
              (EXISTS (
                 SELECT 1 FROM pg_depend d LEFT JOIN pg_proc p ON d.refclassid = 'pg_proc'::regclass AND p.oid = d.refobjid
                 LEFT JOIN pg_operator o ON d.refclassid = 'pg_operator'::regclass AND o.oid = d.refobjid
                 LEFT JOIN pg_namespace pn ON pn.oid = p.pronamespace
                 LEFT JOIN pg_namespace ons ON ons.oid = o.oprnamespace
                 WHERE (pn.nspname <> 'pg_catalog' OR ons.nspname <> 'pg_catalog')
                   AND ((d.classid = 'pg_attrdef'::regclass AND d.objid IN
                     (SELECT ad.oid FROM pg_attrdef ad WHERE ad.adrelid = r.oid))
                   OR (d.classid = 'pg_constraint'::regclass AND d.objid IN
                     (SELECT co.oid FROM pg_constraint co WHERE co.conrelid = r.oid))
                   OR (d.classid = 'pg_class'::regclass AND d.objid IN
                     (SELECT ix.indexrelid FROM pg_index ix WHERE ix.indrelid = r.oid)))
               ) OR EXISTS (
                 SELECT 1 FROM pg_index ix JOIN pg_opclass op ON op.oid = ANY(ix.indclass)
                 JOIN pg_namespace ns ON ns.oid = op.opcnamespace
                 JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_am iam ON iam.oid = ic.relam
                 WHERE ix.indrelid = r.oid AND (ns.nspname <> 'pg_catalog'
                   OR iam.amname NOT IN ('btree', 'hash', 'gist', 'gin', 'spgist', 'brin'))
               )) AS unsafe_code,
              EXISTS (SELECT 1 FROM pg_constraint fk WHERE fk.contype = 'f' AND fk.confrelid = r.oid
                AND fk.confdeltype NOT IN ('a', 'r')) AS cascading_delete,
              EXISTS (SELECT 1 FROM pg_constraint fk WHERE fk.contype = 'f' AND fk.confrelid = r.oid
                AND fk.confupdtype NOT IN ('a', 'r')) AS cascading_update
         FROM information_schema.columns c
         JOIN pg_namespace n ON n.nspname = c.table_schema
         JOIN pg_class r ON r.relnamespace = n.oid AND r.relname = c.table_name
         LEFT JOIN pg_am am ON am.oid = r.relam
         JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = c.column_name
         JOIN pg_type t ON t.oid = a.atttypid
         JOIN pg_namespace tn ON tn.oid = t.typnamespace
         LEFT JOIN pg_type et ON et.oid = t.typelem AND et.typarray = t.oid AND t.typtype = 'b'
         LEFT JOIN pg_namespace en ON en.oid = et.typnamespace
        WHERE c.table_schema = $1 AND r.relkind IN ('r', 'p', 'f')
        ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
      [schema],
    );
  const { rows: keyRows } = await pool.query<KeyRow>(
      `SELECT tc.table_schema, tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
          AND kcu.table_schema = tc.table_schema AND kcu.table_name = tc.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
        ORDER BY tc.table_schema, tc.table_name, kcu.ordinal_position`,
      [schema],
    );

  const tables = new Map<string, Table>();
  for (const row of columnRows) {
    const supported = supportedType(row.type_name, row.type_schema, row.type_kind)
      || (row.element_name !== null && row.element_schema !== null && row.element_kind !== null
        && supportedType(row.element_name, row.element_schema, row.element_kind));
    const column: Column = {
      name: row.column_name, type: row.data_type,
      nullable: row.is_nullable === 'YES',
      hasDefault: row.column_default !== null || row.is_identity === 'YES',
      generated: row.is_identity === 'YES' || row.is_generated === 'ALWAYS',
      sqlType: row.sql_type,
      readOnlyReason: !supported ? `Тип ${row.sql_type} пока не поддерживает безопасное редактирование.`
        : row.is_generated === 'ALWAYS' ? 'Вычисляемые колонки доступны только для чтения.' : null,
    };
    const table = tables.get(row.table_name) ?? {
      schema: row.table_schema, name: row.table_name, columns: [],
      primaryKey: keyRows.filter((key) => key.table_name === row.table_name).map((key) => key.column_name),
      // information_schema hides columns outside this role's privileges; a partial row cannot prove preservation.
      readOnlyReason: row.complete_columns !== true ? 'Не все колонки таблицы доступны текущей роли PostgreSQL. Безопасное редактирование невозможно.'
        : row.server_encoding !== 'UTF8' ? 'Безопасное редактирование поддерживается только для базы в кодировке UTF8.'
        : row.unsafe_relation ? 'Таблица использует триггеры, правила, RLS, наследование или секционирование.'
        : row.unsafe_code ? 'Выражения таблицы используют неподдержанные функции или операторы.'
        : row.cascading_update ? 'Обновление строк этой таблицы может изменять другие строки через внешний ключ.' : null,
      deleteReadOnlyReason: row.cascading_delete ? 'Удаление строк этой таблицы может изменять другие строки через внешний ключ.' : null,
    };
    table.columns.push(column);
    table.readOnlyReason ??= column.readOnlyReason;
    if (!table.naturalOrder && (row.is_identity === 'YES' || row.column_default?.startsWith('nextval(')
      || (/^(timestamp|date)/.test(row.data_type) && /now\(\)|CURRENT_TIMESTAMP|CURRENT_DATE/i.test(row.column_default ?? '')))) {
      table.naturalOrder = row.column_name;
    }
    tables.set(row.table_name, table);
  }
  for (const table of tables.values()) {
    if (!table.primaryKey.length) table.readOnlyReason ??= 'У таблицы нет первичного ключа для однозначного выбора строки.';
  }
  return { tables: [...tables.values()] };
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
