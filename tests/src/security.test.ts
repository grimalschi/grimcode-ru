import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import {
  ADMIN,
  AUTH,
  BASE_URL,
  errorMessage,
  Session,
  moduleAdmin,
  USERS,
  waitForStack,
} from './client.js';
import {
  createUser,
  PASSWORD,
  RegistryRestore,
  resolveOwner,
  signIn,
  testEmail,
  type TestUser,
} from './fixtures.js';

/**
 * The security flows themselves: sessions, blocking, recovery and signing out.
 *
 * These are the parts a product inherits and rarely re-reads, so they are checked against the
 * running stack rather than trusted.
 */

let owner: Session;
let restore: RegistryRestore;
let authAdmin: TestUser;
let forgedOwnerHeaders: Record<string, string>;
const database = new Pool({ connectionString: process.env.DATABASE_URL });

async function notificationToken(email: string, type: string, field: string): Promise<string> {
  const { rows } = await database.query<{ payload: Record<string, string> }>(
    'SELECT payload FROM notifications.events WHERE recipient_email = $1 AND type = $2', [email, type],
  );
  expect(rows).toHaveLength(1);
  const token = new URL(rows[0]!.payload[field]!).searchParams.get('token');
  if (!token) throw new Error('The notification has no confirmation token');
  return token;
}

beforeAll(async () => {
  await waitForStack();
  owner = await resolveOwner();
  const state = await owner.call<{ userId: string; email: string }>(ADMIN, 'session');
  forgedOwnerHeaders = {
    'x-template-admin-user-id': state.userId,
    'x-template-admin-email': state.email,
    'x-template-admin-role': 'owner',
    adminContext: JSON.stringify({ userId: state.userId, email: state.email, role: 'owner' }),
  };
  restore = new RegistryRestore(owner);

  authAdmin = await createUser('authadmin');
  await restore.remember(authAdmin.userId);
  await owner.call(
    ADMIN,
    'addAdministrator',
    { email: authAdmin.email, role: 'admin', grants: ['auth'] },
    { csrf: true },
  );
});

afterAll(async () => {
  try { await restore?.restoreAll(); } finally { await database.end(); }
});

describe('sessions', () => {
  it('is what identifies the caller, and the browser never reads it', async () => {
    const user = await createUser('session');

    const state = await user.session.call<{ identity: { email: string } | null }>(
      AUTH,
      'currentSession',
    );
    expect(state.identity?.email).toBe(user.email);

    // HttpOnly, so it exists as a cookie but the page it belongs to cannot read it.
    expect(user.session.hasSession).toBe(true);
  });

  it('closes protected endpoints as soon as it is revoked', async () => {
    const user = await createUser('revoked');

    // Works while the session is valid.
    await user.session.call(USERS, 'getOwnProfile');

    await user.session.call(AUTH, 'revokeOwnSessions');

    const after = await user.session.rpc(USERS, 'getOwnProfile');
    expect(after.status).toBe(401);
  });

  /**
   * Removing the cookie in the browser alone would leave a usable session behind, so signing out
   * has to invalidate it on the server first.
   */
  it('is invalidated on the server by signing out, not only cleared in the browser', async () => {
    const user = await createUser('logout');
    const stolen = new Session();

    // A second browser holding the same cookie value stands in for a copied session.
    const cookie = user.session.cookieHeader;
    await user.session.call(AUTH, 'logout');

    const response = await fetch(`${BASE_URL}/module/auth/rpc/currentSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });

    const body = (await response.json()) as { result: { data: { identity: unknown } } };
    expect(body.result.data.identity).toBeNull();
    expect(stolen.hasSession).toBe(false);
  });

  it('is cleared from the browser as well', async () => {
    const user = await createUser('cookie');
    await user.session.call(AUTH, 'logout');
    expect(user.session.hasSession).toBe(false);
  });

  /**
   * The same session and the same rule, reached from another door: the panel has its own `logout`,
   * and a version that only cleared the cookie would look identical to the person clicking it.
   */
  it('is invalidated by signing out of the admin panel too', async () => {
    const admin = await createUser('panellogout');
    await restore.remember(admin.userId);
    await owner.call(
      ADMIN,
      'addAdministrator',
      { email: admin.email, role: 'admin', grants: [] },
      { csrf: true },
    );

    // The panel answers this session before it signs out.
    await admin.session.call(ADMIN, 'session');

    const cookie = admin.session.cookieHeader;
    await admin.session.call(ADMIN, 'logout', {}, { csrf: true });

    // The browser's copy is gone.
    expect(admin.session.hasSession).toBe(false);

    // And so is the session behind it: a copy of the cookie taken beforehand is refused as well.
    const response = await fetch(`${BASE_URL}/module/auth/rpc/currentSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });

    const body = (await response.json()) as { result: { data: { identity: unknown } } };
    expect(body.result.data.identity).toBeNull();
  });

  /**
   * And signing out of the panel needs the token, like every other change. Nothing else can see the
   * difference — the call succeeds either way — which is why the check has to exist.
   */
  it('cannot be ended by a forged panel logout', async () => {
    const admin = await createUser('csrflogout');
    await restore.remember(admin.userId);
    await owner.call(
      ADMIN,
      'addAdministrator',
      { email: admin.email, role: 'admin', grants: [] },
      { csrf: true },
    );

    admin.session.forgetCsrf();
    const refused = await admin.session.rpc(ADMIN, 'logout');

    expect(refused.status).toBe(403);
    expect(errorMessage(refused.body)).toMatch(/csrf/i);

    // Refused means nothing happened: the session still opens the panel.
    expect(admin.session.hasSession).toBe(true);
    await admin.session.call(ADMIN, 'session');
  });
});

describe('sign-in attempts', () => {
  /**
   * Guessing one account's password has to become useless before the guessing succeeds. The limit
   * is counted per address, so it is the attacked account that closes, not the whole login form.
   */
  it('stop being answered after enough failures, and the account is not simply open again', async () => {
    const user = await createUser('bruteforce');
    const attacker = new Session();

    let refusedByLimit = false;
    for (let attempt = 0; attempt < 12 && !refusedByLimit; attempt += 1) {
      const result = await attacker.rpc(AUTH, 'login', {
        email: user.email,
        password: `wrong-passphrase-${attempt}`,
      });
      refusedByLimit = result.status === 429;
    }
    expect(refusedByLimit).toBe(true);

    // The correct password is refused too while the window lasts — otherwise the limit would only
    // slow down a guess that had already failed.
    const correct = await new Session().rpc(AUTH, 'login', {
      email: user.email,
      password: PASSWORD,
    });
    expect(correct.status).toBe(429);

    // And another address is unaffected.
    const other = await createUser('unaffected');
    expect(other.session.hasSession).toBe(true);
  });
});

describe('recovery', () => {
  /**
   * Whether an address is registered is not something the recovery form is willing to reveal, so
   * both answers have to look the same.
   */
  it('answers the same way for a known and an unknown address', async () => {
    const user = await createUser('recovery');

    const known = await new Session().rpc(AUTH, 'requestPasswordReset', { email: user.email });
    const unknown = await new Session().rpc(AUTH, 'requestPasswordReset', {
      email: testEmail('nobody'),
    });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
  });

  it('never hands an administrator the token', async () => {
    const user = await createUser('adminrecovery');

    const result = await authAdmin.session.call<Record<string, unknown>>(
      moduleAdmin('auth'),
      'sendRecovery',
      { id: user.userId },
      { csrf: true },
    );

    // Only an acknowledgement: the link goes to the mailbox, not to the panel.
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toMatch(/token/i);
  });

  it('refuses a token that was never issued', async () => {
    const result = await new Session().rpc(AUTH, 'resetPassword', {
      token: 'x'.repeat(40),
      password: 'a-completely-new-passphrase',
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});

describe('an administrator acting on an identity', () => {
  it('serializes concurrent owner blocks and rechecks the acting session', async () => {
    const pair = await Promise.all([createUser('owner-race-a'), createUser('owner-race-b')]);
    for (const user of pair) {
      await restore.remember(user.userId);
      await owner.call(ADMIN, 'addAdministrator', { email: user.email, role: 'owner', grants: [] }, { csrf: true });
    }
    try {
      const results = await Promise.all(pair.map((user, index) => user.session.rpc(
        ADMIN, 'setIdentityBlocked', { userId: pair[1 - index]!.userId, blocked: true }, { csrf: true },
      )));
      expect(results.filter(({ status }) => status === 200)).toHaveLength(1);
      expect(results.filter(({ status }) => [401, 403, 409].includes(status))).toHaveLength(1);
    } finally {
      for (const user of pair) {
        await owner.call(ADMIN, 'setIdentityBlocked', { userId: user.userId, blocked: false }, { csrf: true });
        await owner.call(ADMIN, 'updateAdministrator', { userId: user.userId, role: 'admin', enabled: false, grants: [] }, { csrf: true });
      }
    }
  });
  it('can sign every session of that person out', async () => {
    const user = await createUser('kicked');
    await user.session.call(USERS, 'getOwnProfile');

    await authAdmin.session.call(
      moduleAdmin('auth'),
      'revokeSessions',
      { id: user.userId },
      { csrf: true },
    );

    const after = await user.session.rpc(USERS, 'getOwnProfile');
    expect(after.status).toBe(401);
  });

  it('cannot block anyone unless they are the owner', async () => {
    const user = await createUser('blocktarget');

    const refused = await authAdmin.session.rpc(
      ADMIN,
      'setIdentityBlocked',
      { userId: user.userId, blocked: true },
      { csrf: true },
    );
    expect(refused.status).toBe(403);
  });

  it('blocks an identity as the owner, and blocking prevents signing in again', async () => {
    const user = await createUser('blocked');

    await owner.call(
      ADMIN,
      'setIdentityBlocked',
      { userId: user.userId, blocked: true },
      { csrf: true },
    );

    const attempt = await new Session().rpc(AUTH, 'login', {
      email: user.email,
      password: PASSWORD,
    });
    expect(attempt.status).toBeGreaterThanOrEqual(400);

    // And it is reversible.
    await owner.call(
      ADMIN,
      'setIdentityBlocked',
      { userId: user.userId, blocked: false },
      { csrf: true },
    );
    const allowed = await signIn(user.email);
    expect(allowed.hasSession).toBe(true);
  });

  it('counts a blocked owner as unable to enter when rights are taken away', async ({ skip }) => {
    const acting = await owner.call<{ userId: string }>(ADMIN, 'session');
    const { items } = await owner.call<{ items: { userId: string; role: string; enabled: boolean }[] }>(ADMIN, 'listAdministrators', { limit: 100, offset: 0 });
    if (items.some((row) => row.userId !== acting.userId && row.role === 'owner' && row.enabled)) skip();
    const second = await createUser('secondowner');
    await restore.remember(second.userId);
    await owner.call(
      ADMIN,
      'addAdministrator',
      { email: second.email, role: 'owner', grants: [] },
      { csrf: true },
    );

    const blocked = await owner.rpc(
      ADMIN,
      'setIdentityBlocked',
      { userId: second.userId, blocked: true },
      { csrf: true },
    );
    expect(blocked.status).toBe(200);

    // 409: the other owner is blocked, so giving up these rights would leave nobody able to enter.
    const refused = await owner.rpc(
      ADMIN,
      'updateAdministrator',
      { userId: acting.userId, role: 'admin' },
      { csrf: true },
    );
    expect(refused.status).toBe(409);

    // Unblocked, that owner counts again, and the ordinary last-owner path still allows the change.
    await owner.call(
      ADMIN,
      'setIdentityBlocked',
      { userId: second.userId, blocked: false },
      { csrf: true },
    );
    const allowed = await owner.rpc(
      ADMIN,
      'updateAdministrator',
      { userId: second.userId, role: 'admin', grants: [] },
      { csrf: true },
    );
    expect(allowed.status).toBe(200);
  });

  it('cannot block themselves, even as the owner', async () => {
    const state = await owner.call<{ userId: string }>(ADMIN, 'session');

    const result = await owner.rpc(
      ADMIN,
      'setIdentityBlocked',
      { userId: state.userId, blocked: true },
      { csrf: true },
    );

    expect(result.status).toBeGreaterThanOrEqual(400);

    // Still able to work afterwards.
    const after = await owner.call<{ role: string }>(ADMIN, 'session');
    expect(after.role).toBe('owner');
  });
});

describe('recovery token lifecycle across modules', () => {
  it('keeps the delivered link usable after concurrent reset requests', async () => {
    const user = await createUser('reset-repeat');
    await Promise.all([0, 1].map(() => new Session().call(AUTH, 'requestPasswordReset', { email: user.email })));
    const token = await notificationToken(user.email, 'auth.password.reset_requested', 'resetUrl');
    await new Session().call(AUTH, 'resetPassword', { token, password: `${PASSWORD}-new` });
    expect((await signIn(user.email, `${PASSWORD}-new`)).hasSession).toBe(true);
  });

  it('revokes old reset links when the password changes', async () => {
    const user = await createUser('reset-password-changed');
    await new Session().call(AUTH, 'requestPasswordReset', { email: user.email });
    const token = await notificationToken(user.email, 'auth.password.reset_requested', 'resetUrl');
    await user.session.call(AUTH, 'changePassword', { currentPassword: PASSWORD, password: `${PASSWORD}-new` });
    const stale = await new Session().rpc(AUTH, 'resetPassword', { token, password: `${PASSWORD}-stale` });
    expect(stale.status).toBe(400);
    expect((await signIn(user.email, `${PASSWORD}-new`)).hasSession).toBe(true);
  });

  it('revokes links sent to the old mailbox when the email changes', async () => {
    const user = await createUser('reset-email-changed');
    const email = testEmail('new-mailbox');
    await new Session().call(AUTH, 'requestPasswordReset', { email: user.email });
    const oldToken = await notificationToken(user.email, 'auth.password.reset_requested', 'resetUrl');
    await user.session.call(AUTH, 'requestEmailChange', { email });
    const token = await notificationToken(email, 'auth.email.change_requested', 'confirmUrl');
    await user.session.call(AUTH, 'confirmEmailChange', { token });
    const stale = await new Session().rpc(AUTH, 'resetPassword', { token: oldToken, password: `${PASSWORD}-stale` });
    expect(stale.status).toBe(400);
    expect((await signIn(email)).hasSession).toBe(true);
  });
});

async function batch(session: Session, prefix: string, calls: [string, unknown][], headers: HeadersInit = {}) {
  return session.fetch(`${prefix}/rpc/${calls.map(([procedure]) => procedure).join(',')}?batch=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify(Object.fromEntries(calls.map(([, input], index) => [index, input]))),
  });
}

interface BatchReply {
  result?: { data: unknown };
  error?: { data: { code: string } };
}

describe('module HTTP boundaries', () => {
  it.each([
    ['/admin/embed/module/auth/../email/rpc/listTemplates', 403],
    ['/admin/embed/module/auth/%2e%2e/email/rpc/listTemplates', 403],
    ['/admin//embed/module/email/rpc/listTemplates', 403],
    ['/admin/embed/module/auth%2f..%2femail/rpc/listTemplates', 404],
    ['/admin/embed/module/%65mail/rpc/listTemplates', 404],
  ])('does not inherit Auth access through %s', async (path, status) => {
    const response = await authAdmin.session.fetch(path, { headers: {
      ...forgedOwnerHeaders,
      'x-original-url': '/admin/embed/module/auth/',
      'x-rewrite-url': '/admin/embed/module/auth/',
    } });
    expect(response.status).toBe(status);
  });

  it('keeps internal and administrative procedures out of the public Auth batch', async () => {
    const response = await batch(authAdmin.session, AUTH, [
      ['currentSession', {}], ['getFirstIdentity', {}], ['getIdentity', { id: authAdmin.userId }],
    ], forgedOwnerHeaders);
    const replies = await response.json() as BatchReply[];
    expect(replies).toHaveLength(3);
    expect(replies[0]?.result?.data).toMatchObject({ identity: { id: authAdmin.userId } });
    for (const reply of replies.slice(1)) {
      expect(reply.result).toBeUndefined();
      expect(reply.error?.data.code).toBe('NOT_FOUND');
    }
  });

  it('denies a private batch to anonymous and non-administrator sessions despite supplied owner headers', async () => {
    const plain = await createUser('batch-plain');
    for (const session of [new Session(), plain.session]) {
      const response = await batch(session, moduleAdmin('auth'), [
        ['listIdentities', {}], ['listAudit', {}],
      ], forgedOwnerHeaders);
      expect(response.status).toBe(403);
    }
  });

  it('rechecks batch access after a grant, administrator or session is revoked', async () => {
    const admin = await createUser('batch-access');
    await restore.remember(admin.userId);
    await owner.call(ADMIN, 'addAdministrator', { email: admin.email, role: 'admin', grants: ['auth'] }, { csrf: true });
    const read = () => batch(admin.session, moduleAdmin('auth'), [['listIdentities', {}], ['listAudit', {}]]);
    expect((await read()).status).toBe(200);
    await owner.call(ADMIN, 'updateAdministrator', { userId: admin.userId, grants: [] }, { csrf: true });
    expect((await read()).status).toBe(403);
    await owner.call(ADMIN, 'updateAdministrator', { userId: admin.userId, grants: ['auth'], enabled: false }, { csrf: true });
    expect((await read()).status).toBe(403);
    await owner.call(ADMIN, 'updateAdministrator', { userId: admin.userId, enabled: true }, { csrf: true });
    expect((await read()).status).toBe(200);
    await authAdmin.session.call(moduleAdmin('auth'), 'revokeSessions', { id: admin.userId }, { csrf: true });
    expect((await read()).status).toBe(403);
    expect(await admin.session.call(AUTH, 'currentSession')).toEqual({ identity: null });
  });

  it('does not execute administrative mutations via GET or a plain-text body', async () => {
    const user = await createUser('mutation-transport');
    const prefix = moduleAdmin('auth');
    const csrf = await authAdmin.session.fetch(`${prefix}/csrf`);
    const token = (await csrf.json() as { token: string }).token;
    const input = JSON.stringify({ id: user.userId });
    const requests = [
      [`${prefix}/rpc/revokeSessions?input=${encodeURIComponent(input)}`, {
        method: 'GET', headers: { 'x-csrf-token': token },
      }],
      [`${prefix}/rpc/revokeSessions`, {
        method: 'POST', headers: { 'x-csrf-token': token, 'content-type': 'text/plain' }, body: input,
      }],
    ] satisfies [string, RequestInit][];
    for (const [path, init] of requests) {
      const response = await authAdmin.session.fetch(path, init);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await user.session.call(AUTH, 'currentSession')).toMatchObject({ identity: { id: user.userId } });
    }
  });

  it('checks CSRF for every mutation in a batch and rejects a different surface token', async () => {
    const user = await createUser('batch-csrf');
    const prefix = moduleAdmin('auth');
    const calls: [string, unknown][] = [['revokeSessions', { id: user.userId }], ['sendRecovery', { id: user.userId }]];
    const authResponse = await authAdmin.session.fetch(`${prefix}/csrf`);
    const authToken = (await authResponse.json() as { token: string }).token;
    const panelResponse = await authAdmin.session.fetch(`${ADMIN}/csrf`);
    const panelToken = (await panelResponse.json() as { token: string }).token;

    for (const token of [null, panelToken]) {
      const headers = new Headers();
      if (token) headers.set('x-csrf-token', token);
      const response = await batch(authAdmin.session, prefix, calls, headers);
      const replies = await response.json() as BatchReply[];
      expect(replies).toHaveLength(calls.length);
      expect(replies.every((reply) => !reply.result && reply.error?.data.code === 'FORBIDDEN')).toBe(true);
      expect(await user.session.call(AUTH, 'currentSession')).toMatchObject({ identity: { id: user.userId } });
      const { rows } = await database.query<{ count: string }>(
        "SELECT count(*) FROM notifications.events WHERE recipient_email = $1 AND type = 'auth.password.reset_requested'", [user.email],
      );
      expect(rows[0]?.count).toBe('0');
    }

    const response = await batch(authAdmin.session, prefix, calls, { 'x-csrf-token': authToken });
    expect(response.status).toBe(200);
    expect((await response.json() as BatchReply[]).every((reply) => !!reply.result && !reply.error)).toBe(true);
    expect(await user.session.call(AUTH, 'currentSession')).toEqual({ identity: null });
  });
});

describe('the application shell', () => {
  /**
   * The guard runs in the browser, so what is checked here is the part that survives without it:
   * the page is served to anyone, and every protected call behind it is refused.
   */
  it('serves its pages to anyone but answers nothing protected without a session', async () => {
    const anonymous = new Session();

    expect(await anonymous.status('/app/')).toBe(200);
    expect(await anonymous.status('/app/settings')).toBe(200);

    const profile = await anonymous.rpc(USERS, 'getOwnProfile');
    expect(profile.status).toBe(401);

    const sessions = await anonymous.rpc(AUTH, 'listOwnSessions');
    expect(sessions.status).toBe(401);
  });

  it('answers protected calls once signed in', async () => {
    const user = await createUser('appuser');

    const profile = await user.session.call<{ profile: { identityId: string } }>(
      USERS,
      'getOwnProfile',
    );
    expect(profile.profile.identityId).toBe(user.userId);
  });
});
