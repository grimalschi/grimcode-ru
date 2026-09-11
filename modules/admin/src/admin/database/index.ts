import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import { countRows, readCatalogue, type Queryable } from './catalog.js';
import { conditionsFor } from './filters.js';
import { findTable } from './identifiers.js';
import { deleteRow, insertRow, selectRows, updateRow } from './statements.js';
import type { rowsInputSchema, tableInputSchema } from './schemas.js';

/** The owner's browser shares Admin's prepared pool; it never changes a connection's search_path. */
export function createDatabaseBrowser(database: () => Promise<Queryable>) {
  async function schemas() {
    const pool = await database();
    const { rows } = await pool.query<{ name: string }>(
      `SELECT DISTINCT table_schema AS name FROM information_schema.tables
        WHERE table_type = 'BASE TABLE' AND table_schema <> 'information_schema'
          AND table_schema !~ '^pg_' AND table_name <> 'schema_migrations'
        ORDER BY name`,
    );
    return { schemas: rows };
  }

  async function catalogue(schema: string) {
    if (schema === 'information_schema' || schema.startsWith('pg_')
      || !(await schemas()).schemas.some(({ name }) => name === schema)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: `No user schema named ${schema}.` });
    }
    const pool = await database();
    const { tables } = await readCatalogue(pool, schema);
    return { pool, tables: tables.filter((table) => table.name !== 'schema_migrations') };
  }

  async function requestedTable(input: z.infer<typeof tableInputSchema>) {
    const { pool, tables } = await catalogue(input.schema);
    return { pool, table: findTable(tables, input.schema, input.table) };
  }

  return {
    schemas,
    async tables({ schema }: { schema: string }) {
      const { pool, tables } = await catalogue(schema);
      return { tables: await Promise.all(tables.map(async (table) => ({
        schema: table.schema, name: table.name, primaryKey: table.primaryKey,
        rows: await countRows(pool, table), naturalOrder: table.naturalOrder ?? null,
        columns: table.columns.map((column) => ({ ...column, conditions: [...conditionsFor(column.type)] })),
      }))) };
    },
    async rows(input: z.infer<typeof rowsInputSchema>) {
      const { pool, table } = await requestedTable(input);
      const statements = selectRows(table, input);
      const [page, counted] = await Promise.all([
        pool.query<Record<string, unknown>>(statements.rows.text, statements.rows.values),
        pool.query<{ total: string }>(statements.total.text, statements.total.values),
      ]);
      return {
        columns: table.columns.map((column) => ({ ...column, conditions: [...conditionsFor(column.type)] })),
        primaryKey: table.primaryKey, rows: page.rows, total: Number(counted.rows[0]?.total ?? 0),
      };
    },
    async insert(input: z.infer<typeof tableInputSchema> & { values: Record<string, unknown> }) {
      const { pool, table } = await requestedTable(input);
      const statement = insertRow(table, input);
      const result = await pool.query<Record<string, unknown>>(statement.text, statement.values);
      return { inserted: result.rows[0] ?? null };
    },
    async update(input: z.infer<typeof tableInputSchema> & { key: Record<string, unknown>; values: Record<string, unknown> }) {
      const { pool, table } = await requestedTable(input);
      const statement = updateRow(table, input);
      const result = await pool.query(statement.text, statement.values);
      const updated = result.rowCount ?? 0;
      if (updated === 0) throw new TRPCError({ code: 'CONFLICT', message: 'No row has that key any more; the table may have changed.' });
      return { updated };
    },
    async delete(input: z.infer<typeof tableInputSchema> & { key: Record<string, unknown> }) {
      const { pool, table } = await requestedTable(input);
      const statement = deleteRow(table, input);
      const result = await pool.query(statement.text, statement.values);
      const deleted = result.rowCount ?? 0;
      if (deleted === 0) throw new TRPCError({ code: 'CONFLICT', message: 'No row has that key any more; the table may have changed.' });
      return { deleted };
    },
  };
}
