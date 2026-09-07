import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ADMIN,
  AUTH,
  errorCode,
  errorMessage,
  Session,
  serviceAdmin,
  USERS,
  waitForStack,
} from './client.js';
import { createUser, RegistryRestore, resolveOwner, type TestUser } from './fixtures.js';

/**
 * Who can open what.
 *
 * Every check goes through Gateway over HTTP, because that is where the decision is made. They open
 * the protected URL directly, which is what an attacker would do.
 */

let owner: Session;
let restore: RegistryRestore;
let plainUser: TestUser;
let grantedAdmin: TestUser;

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
});

afterAll(async () => {
  await restore.restoreAll();
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

  it('lets the owner in and reports every service', async () => {
    const state = await owner.call<{ role: string; services: string[] }>(ADMIN, 'session');

    expect(state.role).toBe('owner');
    // The database is a section of the panel, reported separately from the services.
    expect((state as unknown as { database: boolean }).database).toBe(true);
    expect(new Set(state.services)).toEqual(new Set(['auth', 'users', 'notifications', 'email']));
  });

  /**
   * The assets are what the interface is made of, so serving them to someone who may not open the
   * panel would hand out the panel itself.
   */
  it('protects the admin assets, not only its pages', async () => {
    const anonymous = new Session();
    expect(await anonymous.status('/admin/assets/index.js')).toBe(403);
    expect(await anonymous.status('/admin/embed/service/email/assets/index.js')).toBe(403);
  });
});

describe('grants', () => {
  it('opens a service the administrator was granted', async () => {
    const status = await grantedAdmin.session.status(`${serviceAdmin('users')}/`);
    expect(status).toBe(200);
  });

  it('refuses a service the administrator was not granted', async () => {
    expect(await grantedAdmin.session.status(`${serviceAdmin('auth')}/`)).toBe(403);
    expect(await grantedAdmin.session.status(`${serviceAdmin('email')}/`)).toBe(403);
  });

  it('refuses the RPC of an ungranted service, not just its pages', async () => {
    const result = await grantedAdmin.session.rpc(serviceAdmin('auth'), 'listIdentities');
    expect(result.status).toBe(403);
  });

  it('lists only the granted services for that administrator', async () => {
    const state = await grantedAdmin.session.call<{ role: string; services: string[] }>(
      ADMIN,
      'session',
    );

    expect(state.role).toBe('admin');
    expect(state.services).toEqual(['users']);
  });

  /**
   * A direct URL is the whole point: hiding an entry in the sidebar is presentation, and the
   * server has to refuse the same request anyway.
   */
  it('takes effect on the next request after a change', async () => {
    expect(await grantedAdmin.session.status(`${serviceAdmin('users')}/`)).toBe(200);

    await owner.call(
      ADMIN,
      'updateAdministrator',
      { userId: grantedAdmin.userId, grants: [] },
      { csrf: true },
    );
    expect(await grantedAdmin.session.status(`${serviceAdmin('users')}/`)).toBe(403);

    await owner.call(
      ADMIN,
      'updateAdministrator',
      { userId: grantedAdmin.userId, grants: ['users'] },
      { csrf: true },
    );
    expect(await grantedAdmin.session.status(`${serviceAdmin('users')}/`)).toBe(200);
  });

  it('closes everything when the administrator is disabled', async () => {
    await owner.call(
      ADMIN,
      'updateAdministrator',
      { userId: grantedAdmin.userId, enabled: false },
      { csrf: true },
    );
    expect(await grantedAdmin.session.status('/admin/')).toBe(403);
    expect(await grantedAdmin.session.status(`${serviceAdmin('users')}/`)).toBe(403);

    await owner.call(
      ADMIN,
      'updateAdministrator',
      { userId: grantedAdmin.userId, enabled: true },
      { csrf: true },
    );
    expect(await grantedAdmin.session.status('/admin/')).toBe(200);
  });
});

/**
 * The database area is a section of the panel, not a service admin.
 *
 * That is why it lives at `/admin/database/`, why only the owner reaches it, and why no grant can
 * name it: there is nothing to hand out, so nothing can be handed out by mistake.
 *
 * Behind it is this template's own interface — its API today, its screen next — and the owner is the
 * only one who reaches either. The distinction from the ordinary administrator's 403 below is the
 * point: the check runs before anything is served.
 */
describe('the database area', () => {
  it('serves the interface to the owner', async () => {
    expect(await owner.status('/admin/embed/database/')).toBe(200);
  });

  it('shows the owner the databases of this installation, and only those', async () => {
    const response = await owner.fetch('/admin/embed/database/api/databases');
    const body = (await response.json()) as { databases: { name: string }[] };

    const names = body.databases.map((database) => database.name).sort();
    expect(names).toEqual(
      ['admin', 'auth', 'email', 'notifications', 'users']
        .map((module) => `${process.env.PROJECT_SLUG}_${module}`)
        .sort(),
    );
  });

  it('refuses a changing request that carries no header of ours', async () => {
    const response = await owner.fetch('/admin/embed/database/api/databases/x/rows/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 'public', table: 'identities', key: {} }),
    });

    expect(response.status).toBe(403);
  });

  it('is closed to an ordinary administrator, whatever their grants', async () => {
    await owner.call(
      ADMIN,
      'updateAdministrator',
      { userId: grantedAdmin.userId, grants: ['users', 'auth', 'notifications', 'email'] },
      { csrf: true },
    );

    expect(await grantedAdmin.session.status('/admin/embed/database/')).toBe(403);
  });

  it('is not a service, so nothing can grant it', async () => {
    const result = await owner.rpc(
      ADMIN,
      'updateAdministrator',
      { userId: grantedAdmin.userId, grants: ['database'] },
      { csrf: true },
    );

    // Rejected by the contract itself, before any handler could interpret it.
    expect(result.status).toBe(400);
  });

  it('is not reachable as a service admin either', async () => {
    expect(await owner.status('/admin/embed/service/database/')).toBe(404);
  });

  it('has no public route', async () => {
    const anonymous = new Session();
    expect(await anonymous.status('/service/database/')).toBe(404);
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
  it('does not expose a service that is not on the public allowlist', async () => {
    const anonymous = new Session();

    for (const service of ['admin', 'email', 'notifications', 'billing']) {
      expect(await anonymous.status(`/service/${service}/rpc/anything`)).toBe(404);
    }
  });

  it('exposes the two services that are on it', async () => {
    const anonymous = new Session();

    // Reached the service: it answers, even if the answer is "no session".
    const auth = await anonymous.rpc('/service/auth', 'currentSession');
    expect(auth.status).toBe(200);

    const users = await anonymous.rpc('/service/users', 'getOwnProfile');
    expect(users.status).toBe(401);
  });

  it('never lets a client supply its own admin context', async () => {
    const forged = new Session();

    const response = await forged.fetch('/service/auth/rpc/currentSession', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Gateway builds these itself and strips whatever arrived.
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

/**
 * Each module still works in a database of its own — and that is now a fact of the wiring rather than
 * something PostgreSQL enforces.
 *
 * What stood here before was the opposite check: a module's own credentials being refused a
 * neighbour's database, with `permission denied for database` as the proof. It was true while every
 * module had a role and a password of its own. A module now creates its own database on its first
 * request, which needs an account allowed to create databases — and such an account opens all of them.
 * The refusal is gone, so the check that asserted it is gone too rather than being weakened into
 * something that passes.
 *
 * What is left worth checking is that the separation itself is real: the five databases exist, they
 * are distinct, and each module's data is in its own. The first two are checked here; the third is
 * what every flow in this suite exercises through Gateway.
 */
describe('a database per module', () => {
  /**
   * The five databases exist and are distinct — and they come into being on first use, not at
   * deployment, so this asks each module for something first. One request per module is enough: the
   * pool opens, the database is created if it was missing, the migrations run.
   *
   * Written this way rather than trusting the rest of the suite to have warmed them: the files run in
   * parallel, and a check that depends on another file's order is a check that goes red on a Tuesday.
   */
  it('is five distinct databases, each one where it is expected', async () => {
    // Auth and Users answer these; Admin is asked by Gateway on any `/admin/**`; Notifications and
    // Email are woken by the registration in `beforeAll`, which is the only route into them.
    await owner.call(AUTH, 'currentSession', {});
    await owner.call(USERS, 'getOwnProfile', {});
    await owner.rpc(ADMIN, 'listAdministrators', {});

    /*
     * The names are spelled out here rather than imported from the program that builds them. That is
     * the point of the check: importing the derivation would compare the code with itself, and what
     * is being verified is the rule — one database per module, named `<slug>_<module>`.
     */
    const slug = process.env.PROJECT_SLUG;
    if (!slug) throw new Error('PROJECT_SLUG is not set, so the database names cannot be known');

    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    try {
      const names = ['admin', 'auth', 'email', 'notifications', 'users'].map(
        (module) => `${slug}_${module}`,
      );
      expect(new Set(names).size).toBe(names.length);

      const { rows } = await pool.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname = ANY($1)',
        [names],
      );
      expect(rows.map((row) => row.datname).sort()).toEqual([...names].sort());
    } finally {
      await pool.end();
    }
  });
});
