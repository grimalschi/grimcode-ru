import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migration as registryMigration } from '../../db/migrations/001-administrators-grants-audit.js';
import { SCHEMA } from '../../db/migrator.js';
import { createDatabaseBrowser } from './index.js';

/*
 * The registry screen keeps one owner able to enter the panel; this editor reaches the same table
 * directly. A real `admin` schema is built from the module's own migration in the disposable test
 * database named by DATABASE_URL, so the table here is the one the installation has. Auth is a stub
 * the tests steer: which identities exist and which are blocked.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required to run the Admin PostgreSQL tests.');
const database = new pg.Client({ connectionString });
/** Plays Auth's connection in the concurrency case: a second session next to the one holding the registry lock. */
const authSide = new pg.Client({ connectionString });
const pool = new pg.Pool({ connectionString, max: 2 });

const owner = { first: randomUUID(), second: randomUUID(), admin: randomUUID() };
const auth = { known: new Set(Object.values(owner)), blocked: new Set<string>(), asked: [] as string[][] };
const editor = createDatabaseBrowser(async () => pool, {
  ownersAbleToSignIn: async (userIds) => {
    auth.asked.push([...userIds]);
    return userIds.filter((id) => auth.known.has(id) && !auth.blocked.has(id));
  },
});
const table = { schema: SCHEMA, table: 'administrators' };
type Row = Record<string, string | null>;

let connected = false;
let created = false;

async function shown(): Promise<Row[]> {
  return (await editor.rows({ ...table, limit: 10 })).rows;
}

async function rowOf(userId: string): Promise<Row> {
  const row = (await shown()).find((candidate) => candidate.user_id === userId);
  if (!row) throw new Error(`No registry row for ${userId}`);
  return row;
}

/** The registry by user id, so a test reads one administrator without caring about row order. */
async function registry(): Promise<Record<string, { role: string; enabled: boolean }>> {
  const { rows } = await database.query<{ user_id: string; role: string; enabled: boolean }>(
    `SELECT user_id, role, enabled FROM "${SCHEMA}".administrators`,
  );
  return Object.fromEntries(rows.map(({ user_id, ...rest }) => [user_id, rest]));
}

async function refusedUnchanged(operation: Promise<unknown>, message: string): Promise<void> {
  const before = await registry();
  await expect(operation).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining(message) });
  expect(await registry()).toEqual(before);
}

/*
 * Auth's table, as far as the editor knows it: the module's schema, the table's name and its key.
 * Only those three are Auth's real ones; the other columns stand in for whatever Auth keeps there.
 */
const identities = { schema: 'auth', table: 'identities' };

async function identityOf(userId: string): Promise<Row> {
  const row = (await editor.rows({ ...identities, limit: 10 })).rows.find((candidate) => candidate.id === userId);
  if (!row) throw new Error(`No identity row for ${userId}`);
  return row;
}

async function identityBlockedAt(userId: string): Promise<string | null> {
  const { rows } = await database.query<{ blocked_at: string | null }>(
    'SELECT blocked_at::text FROM auth.identities WHERE id = $1', [userId],
  );
  return rows[0]?.blocked_at ?? null;
}

beforeAll(async () => {
  await database.connect();
  await authSide.connect();
  connected = true;
  await database.query(`CREATE SCHEMA "${SCHEMA}"; CREATE SCHEMA auth`);
  created = true;
  await database.query(`SET search_path TO "${SCHEMA}"`);
  await database.query(registryMigration.sql);
  await database.query(
    `INSERT INTO administrators (id, user_id, email, role, bootstrap) VALUES
       ($1, $2, 'first@example.test', 'owner', true),
       ($3, $4, 'second@example.test', 'owner', false),
       ($5, $6, 'admin@example.test', 'admin', false)`,
    [randomUUID(), owner.first, randomUUID(), owner.second, randomUUID(), owner.admin],
  );
  await database.query(`CREATE TABLE auth.identities (
    id uuid PRIMARY KEY, email text NOT NULL, password_hash text NOT NULL, blocked_at timestamptz
  )`);
  await database.query(
    `INSERT INTO auth.identities (id, email, password_hash) VALUES
       ($1, 'first@example.test', 'hash'), ($2, 'second@example.test', 'hash'), ($3, 'admin@example.test', 'hash')`,
    [owner.first, owner.second, owner.admin],
  );
});

afterAll(async () => {
  try {
    if (created) await database.query(`ROLLBACK; DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE; DROP SCHEMA IF EXISTS auth CASCADE`);
  }
  finally {
    await Promise.all([connected ? database.end() : Promise.resolve(), authSide.end().catch(() => undefined), pool.end()]);
  }
});

describe('the registry keeps one owner who can sign in, whatever the editor is asked', () => {
  it('warns above the registry table and nowhere else', async () => {
    const { tables } = await editor.tables({ schema: SCHEMA });
    const notices = Object.fromEntries(tables.map(({ name, notice }) => [name, notice]));
    expect(notices.administrators).toContain('экране «Администраторы»');
    expect(notices.administrator_grants).toBeNull();
    expect(notices.admin_audit).toBeNull();
    const page = await editor.rows({ ...table, limit: 10 });
    expect(page.notice).toBe(notices.administrators);
    expect(page.readOnlyReason).toBeNull();
  });

  it('lets an owner be disabled and demoted while another owner who can sign in remains', async () => {
    await expect(editor.update({ ...table, original: await rowOf(owner.first), values: { enabled: 'f' } }))
      .resolves.toEqual({ updated: 1 });
    await expect(editor.update({ ...table, original: await rowOf(owner.first), values: { enabled: 't', role: 'admin' } }))
      .resolves.toEqual({ updated: 1 });
    expect(await registry()).toEqual({
      [owner.first]: { role: 'admin', enabled: true },
      [owner.second]: { role: 'owner', enabled: true },
      [owner.admin]: { role: 'admin', enabled: true },
    });
    // Each write asked Auth about the owners left after it.
    expect(auth.asked.slice(-2)).toEqual([[owner.second], [owner.second]]);
  });

  it('refuses to disable or demote the last owner and rolls the write back', async () => {
    for (const values of [{ enabled: 'f' }, { role: 'admin' }, { role: 'admin', enabled: 'f' }]) {
      await refusedUnchanged(editor.update({ ...table, original: await rowOf(owner.second), values }), 'не останется включённого владельца');
    }
  });

  it('refuses to point the last owner\'s user_id at an account Auth does not know', async () => {
    await refusedUnchanged(
      editor.update({ ...table, original: await rowOf(owner.second), values: { user_id: randomUUID() } }),
      'не сможет войти',
    );
  });

  it('does not count a hand-inserted owner Auth does not know when the real one is disabled', async () => {
    const phantom = randomUUID();
    await expect(editor.insert({ ...table, values: { id: randomUUID(), user_id: phantom, email: 'phantom@example.test', role: 'owner' } }))
      .resolves.toMatchObject({ inserted: { user_id: phantom, role: 'owner', enabled: 't' } });
    await refusedUnchanged(editor.update({ ...table, original: await rowOf(owner.second), values: { enabled: 'f' } }), 'не сможет войти');
    expect(auth.asked.at(-1)).toEqual([phantom]);
    await database.query(`DELETE FROM administrators WHERE user_id = $1`, [phantom]);
  });

  it('refuses when the only other owner is blocked in Auth, and allows once unblocked', async () => {
    await expect(editor.update({ ...table, original: await rowOf(owner.first), values: { role: 'owner' } })).resolves.toEqual({ updated: 1 });
    auth.blocked.add(owner.first);
    await refusedUnchanged(editor.update({ ...table, original: await rowOf(owner.second), values: { enabled: 'f' } }), 'заблокирован');
    auth.blocked.delete(owner.first);
    await expect(editor.update({ ...table, original: await rowOf(owner.second), values: { enabled: 'f' } })).resolves.toEqual({ updated: 1 });
    await expect(editor.update({ ...table, original: await rowOf(owner.second), values: { enabled: 't' } })).resolves.toEqual({ updated: 1 });
    await expect(editor.update({ ...table, original: await rowOf(owner.first), values: { role: 'admin' } })).resolves.toEqual({ updated: 1 });
    expect(await registry()).toEqual({
      [owner.first]: { role: 'admin', enabled: true },
      [owner.second]: { role: 'owner', enabled: true },
      [owner.admin]: { role: 'admin', enabled: true },
    });
  });

  it('still edits the last owner\'s other columns and other administrators', async () => {
    await expect(editor.update({ ...table, original: await rowOf(owner.second), values: { email: 'renamed@example.test' } }))
      .resolves.toEqual({ updated: 1 });
    await expect(editor.update({ ...table, original: await rowOf(owner.admin), values: { enabled: 'f' } }))
      .resolves.toEqual({ updated: 1 });
    expect((await registry())[owner.admin]).toEqual({ role: 'admin', enabled: false });
    expect((await rowOf(owner.second)).email).toBe('renamed@example.test');
  });

  it('refuses to delete any administrator, because grants cascade from the row', async () => {
    expect((await editor.rows({ ...table, limit: 10 })).deleteReadOnlyReason).toContain('внешний ключ');
    await expect(editor.delete({ ...table, original: await rowOf(owner.second) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(editor.delete({ ...table, original: await rowOf(owner.admin) })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(Object.keys(await registry())).toHaveLength(3);
  });
});

describe('the account of the last owner who can sign in is not changed through Auth\'s table', () => {
  const BLOCKED = '2026-09-18 12:00:00+00';

  it('warns above the identities table', async () => {
    const { tables } = await editor.tables({ schema: 'auth' });
    expect(tables.find(({ name }) => name === 'identities')?.notice).toContain('последнего владельца');
    expect((await editor.rows({ ...identities, limit: 10 })).notice).toContain('последнего владельца');
  });

  it('refuses any change to the last owner\'s identity row, whichever column it is', async () => {
    for (const values of [{ blocked_at: BLOCKED }, { password_hash: 'other' }, { email: 'moved@example.test' }]) {
      await expect(editor.update({ ...identities, original: await identityOf(owner.second), values }))
        .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('последнего владельца') });
    }
    expect(await identityOf(owner.second)).toMatchObject({ email: 'second@example.test', password_hash: 'hash', blocked_at: null });
    await expect(editor.delete({ ...identities, original: await identityOf(owner.second) }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('последнего владельца') });
  });

  it('changes an identity that is not an enabled owner\'s', async () => {
    await expect(editor.update({ ...identities, original: await identityOf(owner.admin), values: { blocked_at: BLOCKED } }))
      .resolves.toEqual({ updated: 1 });
    expect(await identityBlockedAt(owner.admin)).not.toBeNull();
    // `first` is an administrator today, not an owner, so their account is not protected either.
    await expect(editor.update({ ...identities, original: await identityOf(owner.first), values: { blocked_at: BLOCKED } }))
      .resolves.toEqual({ updated: 1 });
    await database.query('UPDATE auth.identities SET blocked_at = NULL');
  });

  it('allows the change once another owner can sign in, and refuses again when Auth says they cannot', async () => {
    await expect(editor.update({ ...table, original: await rowOf(owner.first), values: { role: 'owner' } })).resolves.toEqual({ updated: 1 });
    await expect(editor.update({ ...identities, original: await identityOf(owner.second), values: { blocked_at: BLOCKED } }))
      .resolves.toEqual({ updated: 1 });
    expect(auth.asked.at(-1)).toEqual([owner.first]);
    await database.query('UPDATE auth.identities SET blocked_at = NULL');

    auth.blocked.add(owner.first);
    await expect(editor.update({ ...identities, original: await identityOf(owner.second), values: { blocked_at: BLOCKED } }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    auth.blocked.delete(owner.first);
    await expect(editor.update({ ...table, original: await rowOf(owner.first), values: { role: 'admin' } })).resolves.toEqual({ updated: 1 });
  });

  /*
   * The registry screen locks `administrators`, then has Auth update the identity row, then commits.
   * Here the screen is played by two connections: `database` holds the registry lock, `authSide`
   * is Auth updating the very row the editor is about to change. If the editor took the row before
   * the registry, Auth's update would hang on that row while the editor hangs on the registry — a
   * cycle PostgreSQL never sees whole, because the screen waits for Auth in application code.
   */
  it('takes the registry lock before the identity row, so the registry screen\'s Auth update is never stuck behind it', async () => {
    const original = await identityOf(owner.admin);
    await database.query(`BEGIN; LOCK TABLE ONLY "${SCHEMA}".administrators IN SHARE ROW EXCLUSIVE MODE`);
    let settled = false;
    const write = editor.update({ ...identities, original, values: { blocked_at: BLOCKED } })
      .finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      // Auth's side of the screen's operation: the row must be free, so this completes at once.
      await authSide.query('SET statement_timeout = 2000');
      await expect(authSide.query("UPDATE auth.identities SET blocked_at = '2026-09-18 13:00:00+00' WHERE id = $1", [owner.admin]))
        .resolves.toMatchObject({ rowCount: 1 });
    } finally {
      // Whatever the assertions said, the lock is released: an open transaction would otherwise make
      // afterAll's DROP SCHEMA part of it and leave the schemas behind for the next run.
      await database.query('COMMIT');
    }
    // The screen's change committed first; the editor then finds a row that no longer matches and stops.
    await expect(write).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Строка изменилась') });
    expect(await identityBlockedAt(owner.admin)).toContain('13:00:00');
    await database.query('UPDATE auth.identities SET blocked_at = NULL');
  });
});
