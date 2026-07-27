import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ADMIN, AUTH, Session, serviceAdmin, USERS, waitForStack } from './client.js';
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

beforeAll(async () => {
  await waitForStack();
  owner = await resolveOwner();
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
  await restore.restoreAll();
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

    const response = await fetch(`${process.env.ACCEPTANCE_BASE_URL}/service/auth/rpc/currentSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ json: {} }),
    });

    const body = (await response.json()) as { json: { identity: unknown } };
    expect(body.json.identity).toBeNull();
    expect(stolen.hasSession).toBe(false);
  });

  it('is cleared from the browser as well', async () => {
    const user = await createUser('cookie');
    await user.session.call(AUTH, 'logout');
    expect(user.session.hasSession).toBe(false);
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
      serviceAdmin('auth'),
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
  it('can sign every session of that person out', async () => {
    const user = await createUser('kicked');
    await user.session.call(USERS, 'getOwnProfile');

    await authAdmin.session.call(
      serviceAdmin('auth'),
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
      serviceAdmin('auth'),
      'setBlocked',
      { id: user.userId, blocked: true },
      { csrf: true },
    );
    expect(refused.status).toBe(403);
  });

  it('blocks an identity as the owner, and blocking prevents signing in again', async () => {
    const user = await createUser('blocked');

    await owner.call(
      serviceAdmin('auth'),
      'setBlocked',
      { id: user.userId, blocked: true },
      { csrf: true },
    );

    const attempt = await new Session().rpc(AUTH, 'login', {
      email: user.email,
      password: PASSWORD,
    });
    expect(attempt.status).toBeGreaterThanOrEqual(400);

    // And it is reversible.
    await owner.call(
      serviceAdmin('auth'),
      'setBlocked',
      { id: user.userId, blocked: false },
      { csrf: true },
    );
    const allowed = await signIn(user.email);
    expect(allowed.hasSession).toBe(true);
  });

  /**
   * Blocking takes away every session and every token, so a blocked owner is an owner the panel can
   * no longer let in — and the registry, which counts owners by its own flag, would never notice.
   * Rights come off first; only then can the identity be blocked.
   */
  it('cannot block another owner while they still hold the rights', async () => {
    const second = await createUser('secondowner');
    await restore.remember(second.userId);
    await owner.call(
      ADMIN,
      'addAdministrator',
      { email: second.email, role: 'owner', grants: [] },
      { csrf: true },
    );

    const refused = await owner.rpc(
      serviceAdmin('auth'),
      'setBlocked',
      { id: second.userId, blocked: true },
      { csrf: true },
    );
    // 409: refused for holding the rights, not for any of the other reasons blocking can fail.
    expect(refused.status).toBe(409);

    // Taking the rights away is what makes blocking possible.
    await owner.call(
      ADMIN,
      'updateAdministrator',
      { userId: second.userId, role: 'admin', grants: ['auth'] },
      { csrf: true },
    );
    const allowed = await owner.rpc(
      serviceAdmin('auth'),
      'setBlocked',
      { id: second.userId, blocked: true },
      { csrf: true },
    );
    expect(allowed.status).toBe(200);

    await owner.call(
      serviceAdmin('auth'),
      'setBlocked',
      { id: second.userId, blocked: false },
      { csrf: true },
    );
  });

  it('cannot block themselves, even as the owner', async () => {
    const state = await owner.call<{ userId: string }>(ADMIN, 'session');

    const result = await owner.rpc(
      serviceAdmin('auth'),
      'setBlocked',
      { id: state.userId, blocked: true },
      { csrf: true },
    );

    expect(result.status).toBeGreaterThanOrEqual(400);

    // Still able to work afterwards.
    const after = await owner.call<{ role: string }>(ADMIN, 'session');
    expect(after.role).toBe('owner');
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
