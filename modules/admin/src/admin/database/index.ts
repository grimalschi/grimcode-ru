import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import type { Pool, PoolClient } from '../../db/database.js';
import { countRows, readCatalogue } from './catalog.js';
import { conditionsFor } from './filters.js';
import { findColumn, findTable, Parameters, qualify, quote, type Table } from './identifiers.js';
import { deleteRow, insertRow, keyClause, returnedColumns, selectRows, updateRow, type Statement } from './statements.js';
import type { rowsInputSchema, tableInputSchema } from './schemas.js';

type Row = Record<string, string | null>;
type TableInput = z.infer<typeof tableInputSchema>;

// Query-local parsers preserve every native text value, including microseconds and JSON numbers.
const rawTypes = { getTypeParser: () => (value: string) => value };
const rawQuery = (client: PoolClient, statement: Statement) => client.query<Row>({ ...statement, types: rawTypes });

function sameRow(left: Row, right: Row): boolean {
  return Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([name, value]) => Object.hasOwn(right, name) && value === right[name]);
}

function writable(table: Table, deleting = false): void {
  const reason = table.readOnlyReason ?? (deleting ? table.deleteReadOnlyReason : null);
  if (reason) throw new TRPCError({ code: 'FORBIDDEN', message: reason });
}

/** The browser changes only values whose exact native PostgreSQL representation it can preserve. */
export function createDatabaseBrowser(database: () => Promise<Pool>) {
  async function session<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await (await database()).connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL search_path = pg_catalog;
        SET LOCAL DateStyle = 'ISO, YMD'; SET LOCAL TimeZone = 'UTC';
        SET LOCAL IntervalStyle = 'postgres'; SET LOCAL extra_float_digits = 3;
        SET LOCAL bytea_output = 'hex'; SET LOCAL client_encoding = 'UTF8'; SET LOCAL lc_monetary = 'C'`);
      const result = await handler(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async function schemas(client: PoolClient) {
    const { rows } = await client.query<{ name: string }>(
      `SELECT DISTINCT table_schema AS name FROM information_schema.tables
        WHERE table_type IN ('BASE TABLE', 'FOREIGN') AND table_schema <> 'information_schema'
          AND table_schema !~ '^pg_' AND table_name <> 'schema_migrations'
        ORDER BY name`,
    );
    return { schemas: rows };
  }

  async function catalogue(client: PoolClient, schema: string) {
    if (schema === 'information_schema' || schema.startsWith('pg_')
      || !(await schemas(client)).schemas.some(({ name }) => name === schema)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `No user schema named ${schema}.` });
    }
    const { tables } = await readCatalogue(client, schema);
    return tables.filter((table) => table.name !== 'schema_migrations');
  }

  async function requestedTable(client: PoolClient, input: TableInput) {
    return findTable(await catalogue(client, input.schema), input.schema, input.table);
  }

  async function lockedTable(client: PoolClient, input: TableInput, deleting = false) {
    const initial = await requestedTable(client, input);
    writable(initial, deleting);
    // Prevent concurrent DDL from changing our proof; ordinary row writers remain compatible.
    await client.query(`LOCK TABLE ONLY ${qualify(initial)} IN SHARE UPDATE EXCLUSIVE MODE`);
    const table = await requestedTable(client, input);
    writable(table, deleting);
    return table;
  }

  async function existingRow(client: PoolClient, table: Table, original: Row) {
    if (Object.keys(original).length !== table.columns.length
      || table.columns.some(({ name }) => !Object.hasOwn(original, name))) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Структура строки изменилась. Обновите таблицу.' });
    }
    const key = Object.fromEntries(table.primaryKey.map((name) => [name, original[name]]));
    const parameters = new Parameters();
    const where = keyClause(table, key, parameters);
    const result = await rawQuery(client, {
      text: `SELECT ${returnedColumns(table)} FROM ONLY ${qualify(table)} WHERE ${where} FOR UPDATE`,
      values: parameters.values,
    });
    if (result.rows.length !== 1 || !sameRow(result.rows[0]!, original)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Строка изменилась или удалена. Обновите таблицу перед сохранением.' });
    }
    return key;
  }

  async function canonicalValues(client: PoolClient, table: Table, values: Row) {
    const names = Object.keys(values);
    if (!names.length) return;
    const parameters = new Parameters();
    const expressions = names.map((name) => {
      const column = findColumn(table, name);
      if (column.readOnlyReason || column.generated) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `${name} доступна только для чтения.` });
      }
      // sqlType is format_type(atttypid, atttypmod), never request text. No ::text cast: bpchar trims there.
      return `${parameters.add(values[name])}::${column.sqlType} AS ${quote(name)}`;
    });
    const result = await rawQuery(client, { text: `SELECT ${expressions.join(', ')}`, values: parameters.values });
    const canonical = result.rows[0]!;
    for (const name of names) {
      if (canonical[name] !== values[name]) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `${name}: PostgreSQL изменит представление значения. `
          + `Запись отменена. Ожидаемый исходный текст: ${JSON.stringify(canonical[name])}.` });
      }
    }
  }

  const columns = (table: Table) => table.columns.map((column) => ({ ...column, conditions: [...conditionsFor(column.type)] }));
  const access = (table: Table) => ({ readOnlyReason: table.readOnlyReason, deleteReadOnlyReason: table.deleteReadOnlyReason });

  return {
    schemas: () => session(schemas),
    tables: ({ schema }: { schema: string }) => session(async (client) => {
      const tables = [];
      for (const table of await catalogue(client, schema)) {
        tables.push({
          schema: table.schema, name: table.name, primaryKey: table.primaryKey, ...access(table),
          rows: await countRows(client, table), naturalOrder: table.naturalOrder ?? null, columns: columns(table),
        });
      }
      return { tables };
    }),
    rows: (input: z.infer<typeof rowsInputSchema>) => session(async (client) => {
      const table = await requestedTable(client, input);
      const statements = selectRows(table, input);
      const page = await rawQuery(client, statements.rows);
      const counted = await rawQuery(client, statements.total);
      return { columns: columns(table), primaryKey: table.primaryKey, ...access(table),
        rows: page.rows, total: Number(counted.rows[0]?.total ?? 0) };
    }),
    insert: (input: TableInput & { values: Row }) => session(async (client) => {
      const table = await lockedTable(client, input);
      const statement = insertRow(table, input);
      await canonicalValues(client, table, input.values);
      const result = await rawQuery(client, statement);
      if (result.rowCount !== 1 || !result.rows[0]
        || Object.entries(input.values).some(([name, value]) => result.rows[0]![name] !== value)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'PostgreSQL изменил записанные значения. Вставка отменена.' });
      }
      return { inserted: result.rows[0] };
    }),
    update: (input: TableInput & { original: Row; values: Row }) => session(async (client) => {
      const table = await lockedTable(client, input);
      const key = await existingRow(client, table, input.original);
      // Validate even a redundant patch, including attempted changes to generated/key columns.
      if (Object.keys(input.values).length) updateRow(table, { key, values: input.values });
      const values = Object.fromEntries(Object.entries(input.values).filter(([name, value]) => value !== input.original[name]));
      if (!Object.keys(values).length) return { updated: 0 };
      await canonicalValues(client, table, values);
      const result = await rawQuery(client, updateRow(table, { key, values }));
      if (result.rowCount !== 1 || !result.rows[0] || !sameRow(result.rows[0], { ...input.original, ...values })) {
        throw new TRPCError({ code: 'CONFLICT', message: 'PostgreSQL изменил другие значения строки. Сохранение отменено.' });
      }
      return { updated: 1 };
    }),
    delete: (input: TableInput & { original: Row }) => session(async (client) => {
      const table = await lockedTable(client, input, true);
      const key = await existingRow(client, table, input.original);
      const result = await rawQuery(client, deleteRow(table, { key }));
      if (result.rowCount !== 1) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Число удаляемых строк изменилось. Удаление отменено.' });
      }
      return { deleted: 1 };
    }),
  };
}
