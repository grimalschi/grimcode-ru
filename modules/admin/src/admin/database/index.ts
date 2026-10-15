import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import type { Pool, PoolClient } from '../../db/database.js';
import { countRows, readCatalogue } from './catalog.js';
import { conditionsFor } from './filters.js';
import { findColumn, findTable, Parameters, qualify, quote, type Table } from './identifiers.js';
import { deleteRow, insertRow, keyClause, returnedColumns, selectRows, updateRow, type Statement } from './statements.js';
import type { rowsInputSchema, tableInputSchema } from './schemas.js';
import { SCHEMA } from '../../db/migrator.js';

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

/** What the editor asks the registry's neighbours; the module wires the real Auth in, tests a stub. */
export interface RegistryGuards {
  /** Of these registry owners, the ones Auth knows and has not blocked — the same question the registry screen asks. */
  ownersAbleToSignIn(userIds: readonly string[]): Promise<string[]>;
}

const isRegistry = (table: Table) => table.schema === SCHEMA && table.name === 'administrators';

const REGISTRY_NOTICE = 'Администраторов меняют на экране «Администраторы»: там журнал и правило последнего владельца. '
  + 'Здесь редактор пропустит только правку, после которой хотя бы один владелец сможет войти.';

/**
 * Auth's identities are the accounts the registry's owners sign in with. The editor knows that table
 * by the module's id and its key column and nothing more about it: which column blocks an account,
 * which holds the password, is Auth's business. So the rule is drawn around the whole row — the
 * account of the last owner who can sign in is not changed here at all. Blocking it, replacing its
 * password hash or its e-mail would lock the panel as surely as disabling the owner in the registry.
 */
const isIdentities = (table: Table) => table.schema === 'auth' && table.name === 'identities';

const IDENTITIES_NOTICE = 'Здесь аккаунты, под которыми входят владельцы панели. Строку последнего владельца, который может войти, '
  + 'редактор не меняет: иначе в панель никто не попадёт. Блокировать аккаунты — на экране «Профили».';

/**
 * The registry screen refuses to demote or disable the last owner who can still sign in; this editor
 * reaches the same table without that screen, so the same rule is asked here, after the write and
 * before the commit. Counting `role = 'owner' AND enabled` is not enough: a `user_id` pointing at
 * nobody, or a row inserted by hand, looks like an owner and lets nobody in. So the remaining owners
 * are checked with Auth, as the screen checks them — under the table lock, the price the registry
 * already pays for the same answer.
 */
async function registryKeepsAnOwner(client: PoolClient, table: Table, guards: RegistryGuards): Promise<void> {
  if (!isRegistry(table)) return;
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT user_id FROM ${qualify(table)} WHERE role = 'owner' AND enabled`,
  );
  if (rows.length === 0) {
    throw new TRPCError({ code: 'CONFLICT', message: 'После этой правки в реестре не останется включённого владельца. Запись отменена.' });
  }
  const eligible = await guards.ownersAbleToSignIn(rows.map((row) => row.user_id));
  if (eligible.length === 0) {
    throw new TRPCError({ code: 'CONFLICT', message: 'После этой правки ни один включённый владелец не сможет войти: '
      + 'Auth не знает такого аккаунта или он заблокирован. Запись отменена.' });
  }
}

/**
 * Lock order, and it is the whole of the deadlock question. The registry screen locks
 * `administrators` and then has Auth update the identity row. A write here to an identity must take
 * the same locks in the same order: registry first, then the identity's table and row. Taken the
 * other way round, the editor would hold the row and wait for the registry while the screen holds
 * the registry and waits for Auth, whose update waits for that row — and PostgreSQL cannot break the
 * cycle, because the screen's wait for Auth happens in the application, not in a lock queue.
 * The mode is the one the editor uses for its own table writes: it conflicts with the screen's lock
 * and with editor writes to `administrators`, so disabling an owner there and blocking one here are
 * serialized. Called before the catalogue is read, so the check needs only the request's names.
 */
async function lockRegistryBeforeIdentity(client: PoolClient, input: TableInput): Promise<void> {
  if (input.schema !== 'auth' || input.table !== 'identities') return;
  await client.query(`LOCK TABLE ONLY ${quote(SCHEMA)}.administrators IN SHARE UPDATE EXCLUSIVE MODE`);
}

/**
 * Before a write to an Auth identity: if it belongs to an enabled owner, another owner must still be
 * able to sign in. The answer cannot come from Auth after the write — Auth reads committed rows and
 * would not see this transaction — so the row is protected as a whole, before anything is written.
 * Runs under the registry lock taken by `lockRegistryBeforeIdentity`.
 */
async function keepsLastOwnerAbleToSignIn(
  client: PoolClient, table: Table, key: Record<string, string | null | undefined>, guards: RegistryGuards,
): Promise<void> {
  if (!isIdentities(table)) return;
  const { rows } = await client.query<{ user_id: string }>(
    `SELECT user_id FROM ${quote(SCHEMA)}.administrators WHERE role = 'owner' AND enabled`,
  );
  const identityId = table.primaryKey.length === 1 ? key[table.primaryKey[0]!] : undefined;
  const owners = rows.map((row) => row.user_id);
  if (typeof identityId !== 'string' || !owners.includes(identityId)) return;
  const eligible = await guards.ownersAbleToSignIn(owners.filter((id) => id !== identityId));
  if (eligible.length === 0) {
    throw new TRPCError({ code: 'CONFLICT', message: 'Это аккаунт последнего владельца, который может войти в панель. Правка отменена.' });
  }
}

/** The browser changes only values whose exact native PostgreSQL representation it can preserve. */
export function createDatabaseBrowser(database: () => Promise<Pool>, guards: RegistryGuards) {
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
        WHERE table_type IN ('BASE TABLE', 'FOREIGN', 'VIEW') AND table_schema <> 'information_schema'
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

  const columns = (table: Table) => table.columns.map((column) => ({ ...column, references: column.references ?? null, conditions: [...conditionsFor(column.type)] }));
  const access = (table: Table) => ({
    readOnlyReason: table.readOnlyReason, deleteReadOnlyReason: table.deleteReadOnlyReason,
    notice: isRegistry(table) ? REGISTRY_NOTICE : isIdentities(table) ? IDENTITIES_NOTICE : null,
  });

  return {
    schemas: () => session(schemas),
    tables: ({ schema }: { schema: string }) => session(async (client) => {
      const tables = [];
      for (const table of await catalogue(client, schema)) {
        tables.push({
          schema: table.schema, name: table.name, kind: table.kind ?? 'table', primaryKey: table.primaryKey, ...access(table),
          foreignKeys: table.foreignKeys ?? [], referencedBy: table.referencedBy ?? [],
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
      await lockRegistryBeforeIdentity(client, input);
      const table = await lockedTable(client, input);
      const key = await existingRow(client, table, input.original);
      await keepsLastOwnerAbleToSignIn(client, table, key, guards);
      // Validate even a redundant patch, including attempted changes to generated/key columns.
      if (Object.keys(input.values).length) updateRow(table, { key, values: input.values });
      const values = Object.fromEntries(Object.entries(input.values).filter(([name, value]) => value !== input.original[name]));
      if (!Object.keys(values).length) return { updated: 0 };
      await canonicalValues(client, table, values);
      const result = await rawQuery(client, updateRow(table, { key, values }));
      if (result.rowCount !== 1 || !result.rows[0] || !sameRow(result.rows[0], { ...input.original, ...values })) {
        throw new TRPCError({ code: 'CONFLICT', message: 'PostgreSQL изменил другие значения строки. Сохранение отменено.' });
      }
      await registryKeepsAnOwner(client, table, guards);
      return { updated: 1 };
    }),
    delete: (input: TableInput & { original: Row }) => session(async (client) => {
      await lockRegistryBeforeIdentity(client, input);
      const table = await lockedTable(client, input, true);
      const key = await existingRow(client, table, input.original);
      await keepsLastOwnerAbleToSignIn(client, table, key, guards);
      const result = await rawQuery(client, deleteRow(table, { key }));
      if (result.rowCount !== 1) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Число удаляемых строк изменилось. Удаление отменено.' });
      }
      // Today the grants' foreign key already refuses this delete; the rule holds if that key changes.
      await registryKeepsAnOwner(client, table, guards);
      return { deleted: 1 };
    }),
  };
}
