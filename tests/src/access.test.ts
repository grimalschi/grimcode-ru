import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADMIN,
  BASE_URL,
  errorCode,
  errorMessage,
  Session,
  moduleAdmin,
  waitForStack,
} from './client.js';
import { createUser, ensureFixtureTemplate, RegistryRestore, resolveOwner, type TestUser } from './fixtures.js';

/**
 * Who can open what.
 *
 * Every check goes through Router over HTTP, because that is where the decision is made. They open
 * the protected URL directly, which is what an attacker would do.
 */

let owner: Session;
let restore: RegistryRestore;
let plainUser: TestUser;
let grantedAdmin: TestUser;
let emptyAdmin: TestUser;
let emailAdmin: TestUser;
let disabledAdmin: TestUser;
let templateId: string;

beforeAll(async () => {
  await waitForStack();
  owner = await resolveOwner();
  restore = new RegistryRestore(owner);

  plainUser = await createUser('plain');
  grantedAdmin = await createUser('granted');

  await restore.remember(grantedAdmin.userId);
  await owner.call(
    ADMIN,
    'addAdministrator',
    { email: grantedAdmin.email, role: 'admin', grants: ['users'] },
    { csrf: true },
  );
  emptyAdmin = await createUser('no-grants');
  emailAdmin = await createUser('email-only');
  disabledAdmin = await createUser('disabled');
  for (const [user, grants] of [[emptyAdmin, []], [emailAdmin, ['email']], [disabledAdmin, ['users', 'email']]] as const) {
    await restore.remember(user.userId);
    await owner.call(ADMIN, 'addAdministrator', { email: user.email, role: 'admin', grants }, { csrf: true });
  }
  await owner.call(ADMIN, 'updateAdministrator', { userId: disabledAdmin.userId, enabled: false }, { csrf: true });
  templateId = await ensureFixtureTemplate(owner, 'acceptance-access-guards', []);
});

afterAll(async () => {
  await restore?.restoreAll();
});

const moduleQueries = { email: 'listTemplates', notifications: 'listEvents', auth: 'listIdentities', users: 'listProfiles' };

function actor(name: string): Session {
  return ({ owner, plain: plainUser.session, users: grantedAdmin.session, email: emailAdmin.session,
    empty: emptyAdmin.session, disabled: disabledAdmin.session })[name] ?? new Session();
}

describe('administrator access matrix', () => {
  it.each([
    { role: 'owner', panel: true, modules: ['email', 'notifications', 'auth', 'users'] },
    { role: 'users', panel: true, modules: ['users'] },
    { role: 'email', panel: true, modules: ['email'] },
    { role: 'empty', panel: true, modules: [] },
    { role: 'disabled', panel: false, modules: [] },
    { role: 'plain', panel: false, modules: [] },
    { role: 'anonymous', panel: false, modules: [] },
  ])('$role receives only its permitted panel and module entrypoints', async ({ role, panel, modules }) => {
    const session = actor(role);
    expect(await session.status('/admin/')).toBe(panel ? 200 : 403);
    const state = await session.rpc<{ modules: string[] }>(ADMIN, 'session');
    expect(state.status).toBe(panel ? 200 : 403);
    if (panel) expect(state.body.modules).toEqual(modules);
    for (const [module, procedure] of Object.entries(moduleQueries)) {
      const expected = modules.includes(module) ? 200 : 403;
      expect(await session.status(`${moduleAdmin(module)}/`), `${role}: ${module} page`).toBe(expected);
      expect((await session.rpc(moduleAdmin(module), procedure)).status, `${role}: ${module} RPC`).toBe(expected);
    }
  });

  it.each(['empty', 'email', 'users'])('keeps owner procedures unavailable to %s administrators', async (role) => {
    const session = actor(role);
    for (const [procedure, input, mutation] of [
      ['listAdministrators', {}, false], ['listAudit', {}, false],
      ['searchUsers', { query: plainUser.email }, false],
      ['addAdministrator', { email: plainUser.email, role: 'owner', grants: [] }, true],
      ['setIdentityBlocked', { userId: plainUser.userId, blocked: true }, true],
      ['database.schemas', {}, false], ['database.tables', { schema: 'admin' }, false],
      ['database.rows', { schema: 'admin', table: 'administrators' }, false],
      ...['insert', 'update', 'delete'].map((action) => [`database.${action}`, databaseProbe(action), true] as const),
    ] as const) {
      const result = await session.rpc(ADMIN, procedure, input, { csrf: mutation });
      expect(result.status, `${role}: ${procedure}`).toBe(403);
      expect(errorCode(result.body), `${role}: ${procedure}`).toBe('FORBIDDEN');
    }
  });

  it.each(['empty', 'email', 'users'])('rejects self-escalation by a %s administrator', async (role) => {
    const session = actor(role);
    const before = await session.call<{ userId: string; role: string; modules: string[] }>(ADMIN, 'session');
    for (const patch of [{ role: 'owner' }, { grants: ['auth', 'users', 'notifications', 'email'] }]) {
      const result = await session.rpc(ADMIN, 'updateAdministrator', { userId: before.userId, ...patch }, { csrf: true });
      expect(result.status).toBe(403);
    }
    expect(await session.call(ADMIN, 'session')).toMatchObject(before);
  });

  it('invalidates a granted mutation immediately when the grant is revoked', async () => {
    const prefix = moduleAdmin('email');
    await emailAdmin.session.call(prefix, 'updateTemplate', { id: templateId, name: 'Access guard fixture' }, { csrf: true });
    try {
      await owner.call(ADMIN, 'updateAdministrator', { userId: emailAdmin.userId, grants: [] }, { csrf: true });
      const denied = await emailAdmin.session.rpc(prefix, 'updateTemplate', { id: templateId, name: 'Forbidden edit' }, { csrf: true });
      expect(denied.status).toBe(403);
      expect((await emailAdmin.session.fetch(`${prefix}/csrf`)).status).toBe(403);
      const state = await emailAdmin.session.call<{ modules: string[] }>(ADMIN, 'session');
      expect(state.modules).toEqual([]);
      const result = await owner.call<{ template: { name: string } }>(prefix, 'getTemplate', { id: templateId });
      expect(result.template.name).toBe('Access guard fixture');
    } finally {
      await owner.call(ADMIN, 'updateAdministrator', { userId: emailAdmin.userId, grants: ['email'] }, { csrf: true });
    }
    await emailAdmin.session.call(prefix, 'updateTemplate', { id: templateId, name: 'Access guard fixture' }, { csrf: true });
  });
});

async function tokenFor(session: Session, prefix: string): Promise<string> {
  const response = await session.fetch(`${prefix}/csrf`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return ((await response.json()) as { token: string }).token;
}

describe('administrative CSRF boundaries', () => {
  it('refuses missing, mismatched and another surface’s token without changing data', async () => {
    const prefix = moduleAdmin('email');
    const before = await owner.call<{ template: { name: string } }>(prefix, 'getTemplate', { id: templateId });
    const panelToken = await tokenFor(owner, ADMIN);
    const emailToken = await tokenFor(owner, prefix);
    const authToken = await tokenFor(owner, moduleAdmin('auth'));
    for (const token of [undefined, 'wrong-token', panelToken, authToken]) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token !== undefined) headers['x-csrf-token'] = token;
      const response = await owner.fetch(`${prefix}/rpc/updateTemplate`, {
        method: 'POST', headers, body: JSON.stringify({ id: templateId, name: 'Forbidden CSRF edit' }),
      });
      expect(response.status).toBe(403);
      expect(errorMessage(await response.json())).toMatch(/csrf/i);
    }
    const response = await owner.fetch(`${ADMIN}/rpc/updateAdministrator`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': emailToken },
      body: JSON.stringify({ userId: emptyAdmin.userId, role: 'owner' }),
    });
    expect(response.status).toBe(403);
    expect(errorMessage(await response.json())).toMatch(/csrf/i);
    expect((await owner.call<{ template: { name: string } }>(prefix, 'getTemplate', { id: templateId })).template.name).toBe(before.template.name);
    expect((await emptyAdmin.session.call<{ role: string }>(ADMIN, 'session')).role).toBe('admin');
  });

  it('requires the cookie as well as the correct header token', async () => {
    const token = await tokenFor(owner, ADMIN);
    const cookie = owner.cookieHeader.split('; ').filter((part) => !part.endsWith(`=${token}`)).join('; ');
    const response = await fetch(`${BASE_URL}/admin/rpc/updateAdministrator`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ userId: emptyAdmin.userId, role: 'owner' }),
    });
    expect(response.status).toBe(403);
    expect(errorMessage(await response.json())).toMatch(/csrf/i);
  });

  it('keeps one tab’s token usable after a second tab requests it', async () => {
    const token = await tokenFor(emailAdmin.session, moduleAdmin('email'));
    expect(await tokenFor(emailAdmin.session, moduleAdmin('email'))).toBe(token);
    const response = await emailAdmin.session.fetch(`${moduleAdmin('email')}/rpc/updateTemplate`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: JSON.stringify({ id: templateId, name: 'Access guard fixture' }),
    });
    expect(response.status).toBe(200);
  });
});

describe('the admin panel itself', () => {
  it('refuses anyone without a session', async () => {
    const anonymous = new Session();
    expect(await anonymous.status('/admin')).toBe(403);
    expect(await anonymous.status('/admin/')).toBe(403);
  });

  it('refuses a signed-in person who is not an administrator', async () => {
    expect(await plainUser.session.status('/admin/')).toBe(403);

    const result = await plainUser.session.rpc(ADMIN, 'session');
    expect(result.status).toBe(403);
  });

  it('lets the owner in and reports modules in catalogue order', async () => {
    const state = await owner.call<{ role: string; modules: string[]; catalogue: { id: string }[] }>(ADMIN, 'session');

    expect(state.role).toBe('owner');
    expect(state.modules).toEqual(['email', 'notifications', 'auth', 'users']);
    expect(state.catalogue.map(({ id }) => id)).toEqual(state.modules);
  });

  /**
   * The assets are what the interface is made of, so serving them to someone who may not open the
   * panel would hand out the panel itself.
   */
  it('protects the admin assets, not only its pages', async () => {
    const anonymous = new Session();
    expect(await anonymous.status('/admin/assets/index.js')).toBe(403);
    expect(await anonymous.status('/admin/embed/module/email/assets/index.js')).toBe(403);
  });
});

describe('grants', () => {
  it('opens a module the administrator was granted', async () => {
    const status = await grantedAdmin.session.status(`${moduleAdmin('users')}/`);
    expect(status).toBe(200);
  });

  it('refuses a module the administrator was not granted', async () => {
    expect(await grantedAdmin.session.status(`${moduleAdmin('auth')}/`)).toBe(403);
    expect(await grantedAdmin.session.status(`${moduleAdmin('email')}/`)).toBe(403);
  });

  it('refuses the RPC of an ungranted module, not just its pages', async () => {
    const result = await grantedAdmin.session.rpc(moduleAdmin('auth'), 'listIdentities');
    expect(result.status).toBe(403);
  });

  it('lists only the granted modules for that administrator', async () => {
    const state = await grantedAdmin.session.call<{ role: string; modules: string[] }>(
      ADMIN,
      'session',
    );

    expect(state.role).toBe('admin');
    expect(state.modules).toEqual(['users']);
  });

  /**
   * A direct URL is the whole point: hiding an entry in the sidebar is presentation, and the
   * server has to refuse the same request anyway.
   */
  it('takes effect on the next request after a change', async () => {
    expect(await grantedAdmin.session.status(`${moduleAdmin('users')}/`)).toBe(200);

    await owner.call(
      ADMIN,
      'updateAdministrator',
      { userId: grantedAdmin.userId, grants: [] },
      { csrf: true },
    );
    expect(await grantedAdmin.session.status(`${moduleAdmin('users')}/`)).toBe(403);

    await owner.call(
      ADMIN,
      'updateAdministrator',
      { userId: grantedAdmin.userId, grants: ['users'] },
      { csrf: true },
    );
    expect(await grantedAdmin.session.status(`${moduleAdmin('users')}/`)).toBe(200);
  });

  it('closes everything when the administrator is disabled', async () => {
    await owner.call(
      ADMIN,
      'updateAdministrator',
      { userId: grantedAdmin.userId, enabled: false },
      { csrf: true },
    );
    expect(await grantedAdmin.session.status('/admin/')).toBe(403);
    expect(await grantedAdmin.session.status(`${moduleAdmin('users')}/`)).toBe(403);

    await owner.call(
      ADMIN,
      'updateAdministrator',
      { userId: grantedAdmin.userId, enabled: true },
      { csrf: true },
    );
    expect(await grantedAdmin.session.status('/admin/')).toBe(200);
  });
});

/** Valid input shapes with nonexistent keys and incomplete inserts keep refusal probes harmless. */
function databaseProbe(action: string, table = 'auth_audit') {
  return {
    schema: 'auth', table,
    ...(['update', 'delete'].includes(action) ? {
      key: table === 'schema_migrations'
        ? { version: -1 }
        : { id: '00000000-0000-4000-8000-000000000000' },
    } : {}),
    ...(['insert', 'update'].includes(action) ? {
      values: table === 'schema_migrations' ? { name: '__probe__' } : { action: '__probe__' },
    } : {}),
  };
}

/** The database is a native owner-only Admin section; its data API uses Admin's tRPC and CSRF. */
describe('the database area', () => {
  it('serves the native page to the owner', async () => {
    expect(await owner.status('/admin/database')).toBe(200);
  });

  it('shows the owner the module schemas, and only those', async () => {
    const body = await owner.call<{ schemas: { name: string }[] }>(ADMIN, 'database.schemas');
    expect(body.schemas.map((schema) => schema.name).sort()).toEqual([
      'admin', 'auth', 'email', 'notifications', 'users',
    ]);
  });

  it('looks up tables only inside the requested module schema', async () => {
    const { tables } = await owner.call<{ tables: { schema: string; name: string }[] }>(
      ADMIN, 'database.tables', { schema: 'auth' },
    );
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.every((table) => table.schema === 'auth')).toBe(true);
    expect(tables.some((table) => table.name === 'identities')).toBe(true);

    for (const input of [
      { schema: 'auth', table: 'profiles' },
      { schema: 'auth', table: 'users.profiles' },
      { schema: 'public', table: 'identities' },
    ]) {
      const result = await owner.rpc(ADMIN, 'database.rows', input);
      expect(result.status).toBe(404);
      expect(errorCode(result.body)).toBe('NOT_FOUND');
    }
  });

  it.each(['insert', 'update', 'delete'])('requires Admin CSRF for database.%s', async (action) => {
    owner.forgetCsrf();
    const result = await owner.rpc(ADMIN, `database.${action}`, databaseProbe(action));
    expect(result.status).toBe(403);
    expect(errorMessage(result.body)).toMatch(/csrf/i);
  });

  it('omits migration tables from every schema catalogue', async () => {
    for (const schema of ['admin', 'auth', 'email', 'notifications', 'users']) {
      const { tables } = await owner.call<{ tables: { name: string }[] }>(ADMIN, 'database.tables', { schema });
      expect(tables.length).toBeGreaterThan(0);
      expect(tables.some((table) => table.name === 'schema_migrations')).toBe(false);
    }
  });

  it.each(['rows', 'insert', 'update', 'delete'])('does not expose migration records through database.%s', async (action) => {
    const result = await owner.rpc(ADMIN, `database.${action}`, databaseProbe(action, 'schema_migrations'), { csrf: action !== 'rows' });
    expect(result.status).toBe(404);
    expect(errorCode(result.body)).toBe('NOT_FOUND');
  });

  it.each(['addColumn', 'renameColumn', 'dropColumn', 'migrate'])('has no database.%s procedure', async (action) => {
    const result = await owner.rpc(ADMIN, `database.${action}`, {}, { csrf: true });
    expect(result.status).toBe(404);
    expect(errorCode(result.body)).toBe('NOT_FOUND');
  });

  it('denies every database operation to an ordinary administrator, whatever their grants', async () => {
    await owner.call(ADMIN, 'updateAdministrator', {
      userId: grantedAdmin.userId, grants: ['users', 'auth', 'notifications', 'email'],
    }, { csrf: true });
    for (const action of ['schemas', 'tables', 'rows', 'insert', 'update', 'delete']) {
      const input = action === 'schemas' ? {} : action === 'tables' ? { schema: 'auth' } : databaseProbe(action);
      const result = await grantedAdmin.session.rpc(ADMIN, `database.${action}`, input, {
        csrf: ['insert', 'update', 'delete'].includes(action),
      });
      expect(result.status, action).toBe(403);
      expect(errorCode(result.body), action).toBe('FORBIDDEN');
    }
  });

  it('does not accept a forged owner context for the database API', async () => {
    const response = await grantedAdmin.session.fetch('/admin/rpc/database.schemas', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-template-admin-user-id': plainUser.userId,
        'x-template-admin-role': 'owner',
        'x-template-admin-grants': 'database',
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
    expect(errorCode(await response.json())).toBe('FORBIDDEN');
  });

  it('does not publish the database API to anonymous or ordinary users', async () => {
    for (const session of [new Session(), plainUser.session]) {
      expect((await session.rpc(ADMIN, 'database.schemas')).status).toBe(403);
    }
  });

  it('does not list the database page among assignable modules', async () => {
    const result = await owner.rpc(ADMIN, 'updateAdministrator', {
      userId: grantedAdmin.userId, grants: ['database'],
    }, { csrf: true });
    expect(result.status).toBe(400);
  });

  it('has no embedded or public database endpoint', async () => {
    for (const path of [
      '/admin/embed/database/', '/admin/embed/database/api/schemas',
      '/admin/embed/module/database/', '/module/database/',
    ]) {
      expect(await owner.status(path), path).toBe(404);
    }
  });
});

describe('the owner-only registry', () => {
  it('is hidden from an ordinary administrator', async () => {
    const result = await grantedAdmin.session.rpc(ADMIN, 'listAdministrators');
    expect(result.status).toBe(403);
  });

  it('refuses an ordinary administrator granting anyone anything', async () => {
    const result = await grantedAdmin.session.rpc(
      ADMIN,
      'addAdministrator',
      { email: plainUser.email, role: 'admin', grants: ['users'] },
      { csrf: true },
    );

    expect(result.status).toBe(403);
  });

  it('will not demote or disable the last active owner', async () => {
    const state = await owner.call<{ userId: string }>(ADMIN, 'session');

    const demote = await owner.rpc(
      ADMIN,
      'updateAdministrator',
      { userId: state.userId, role: 'admin' },
      { csrf: true },
    );
    expect(demote.status).toBe(409);
    expect(errorCode(demote.body)).toBe('CONFLICT');

    const disable = await owner.rpc(
      ADMIN,
      'updateAdministrator',
      { userId: state.userId, enabled: false },
      { csrf: true },
    );
    expect(disable.status).toBe(409);

    // Still the owner afterwards, so a refused call changed nothing.
    const after = await owner.call<{ role: string }>(ADMIN, 'session');
    expect(after.role).toBe('owner');
  });

  it('refuses a mutation that carries no CSRF token', async () => {
    owner.forgetCsrf();

    const result = await owner.rpc(ADMIN, 'updateAdministrator', {
      userId: grantedAdmin.userId,
      grants: ['users'],
    });

    expect(result.status).toBe(403);
    expect(errorMessage(result.body)).toMatch(/csrf/i);
  });
});

describe('public routing', () => {
  it('refuses unavailable modules, special destinations and prototype names', async () => {
    const anonymous = new Session();
    const unavailable = ['billing', 'site', 'app', 'admin', 'router', '__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    for (const module of ['email', 'notifications', ...unavailable]) {
      const path = `/module/${module}/rpc/anything`;
      expect(await anonymous.status(path), path).toBe(404);
    }
    for (const module of unavailable) {
      const path = `${moduleAdmin(module)}/`;
      expect(await owner.status(path), path).toBe(404);
      expect(await anonymous.status(path), path).toBe(404);
    }
  });

  it('exposes the two catalogue modules with public handlers', async () => {
    const anonymous = new Session();

    // Reached the module: it answers, even if the answer is "no session".
    const auth = await anonymous.rpc('/module/auth', 'currentSession');
    expect(auth.status).toBe(200);

    const users = await anonymous.rpc('/module/users', 'getOwnProfile');
    expect(users.status).toBe(401);
  });

  it('never lets a client supply its own admin context', async () => {
    const forged = new Session();

    const response = await forged.fetch('/module/auth/rpc/currentSession', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Router builds these itself and strips whatever arrived.
        'x-template-admin-user-id': '00000000-0000-4000-8000-000000000001',
        'x-template-admin-role': 'owner',
        'x-template-admin-grants': 'auth,users,notifications,email',
      },
      body: JSON.stringify({}),
    });

    const body = (await response.json()) as { result: { data: { identity: unknown } } };
    expect(body.result.data.identity).toBeNull();
  });
});

/** Shared credentials do not enforce this boundary: the test verifies storage ownership. */
describe('a schema per module', () => {
  it('prepares all five schemas and separate migration histories before serving HTTP', async () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      const schemas = ['admin', 'auth', 'email', 'notifications', 'users'];
      const { rows } = await pool.query<{ table_schema: string }>(
        `SELECT table_schema FROM information_schema.tables
          WHERE table_schema = ANY($1) AND table_name = 'schema_migrations'`,
        [schemas],
      );
      expect(rows.map((row) => row.table_schema).sort()).toEqual(schemas);
      const { rows: publicTables } = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [['schema_migrations', 'identities', 'administrators', 'templates', 'profiles']],
      );
      expect(publicTables).toEqual([]);
      for (const schema of schemas) {
        const { rows: history } = await pool.query(`SELECT version FROM "${schema}".schema_migrations`);
        expect(history.length).toBeGreaterThan(0);
      }
    } finally {
      await pool.end();
    }
  });
});
