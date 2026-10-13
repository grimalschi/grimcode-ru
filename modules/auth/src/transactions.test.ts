import { describe, expect, it, vi } from 'vitest';

import type { AuthEnv } from './env.js';
import type { Notifier } from './notifier.js';
import { AuthRepository } from './repository.js';
import type { Pool } from './db/database.js';
import { adminRouter } from './admin/router.js';
import { internalRouter } from './internal/router.js';
import { publicRouter, type PublicContext } from './public/router.js';
import { createRateLimiter } from './rate-limit.js';

/*
 * A change and its audit entry commit together. The pool here is a recorder: it hands out one
 * connection per transaction and keeps every statement in order, so a test can read where BEGIN,
 * the change, the audit and COMMIT fell — and that an audit that fails leaves ROLLBACK, not COMMIT.
 */
const env: AuthEnv = {
  databaseUrl: 'postgres://unused/auth', sessionTtlSeconds: 90, publicOrigin: 'https://example.test',
  sessionCookieName: 'session', csrfCookieName: 'auth_csrf',
};
const identity = {
  id: '00000000-0000-4000-8000-000000000001', email: 'person@example.test', password_hash: 'stored-hash',
  email_verified_at: null, blocked_at: null, blocking_protected_at: null as Date | null, created_at: new Date('2026-01-01T00:00:00Z'), last_login_at: null,
};

function recorder(options: { auditFails?: boolean; commitFails?: boolean; addressTaken?: boolean } = {}) {
  /** Statements in order, tagged with the connection they ran on: `pool` or `tx<n>`. */
  const statements: { on: string; text: string; values: unknown[] }[] = [];
  let transactions = 0;
  const answer = (text: string, values: unknown[] = []) => {
    if (options.auditFails && text.includes('INSERT INTO auth_audit')) throw new Error('audit storage refused');
    if (options.commitFails && text === 'COMMIT') throw new Error('commit lost');
    // The password change is visible to the session opened right after it, as it would be in one transaction.
    if (text.includes('SET password_hash = $2')) identity.password_hash = String(values[1]);
    // The "is this address registered" read: empty for a registration, the known account otherwise.
    if (text.includes('WHERE email = $1')) return options.addressTaken === false ? { rows: [], rowCount: 0 } : { rows: [identity], rowCount: 1 };
    if (text.includes('FROM identities') || text.includes('INSERT INTO identities') || text.includes('UPDATE sessions s')) {
      return { rows: [identity], rowCount: 1 };
    }
    if (text.includes('FROM auth_tokens WHERE token_hash')) return { rows: [{ identity_id: identity.id }], rowCount: 1 };
    if (text.includes('UPDATE auth_tokens SET used_at = now()') && text.includes('RETURNING')) {
      return { rows: [{ id: 'token-1', identity_id: identity.id, purpose: 'email-verification', payload: {}, expires_at: new Date() }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const pool = {
    query: vi.fn(async (text: string, values: unknown[] = []) => { statements.push({ on: 'pool', text, values }); return answer(text, values); }),
    connect: vi.fn(async () => {
      const name = `tx${++transactions}`;
      return {
        query: async (text: string, values: unknown[] = []) => { statements.push({ on: name, text, values }); return answer(text, values); },
        release: vi.fn(),
      };
    }),
  } as unknown as Pool;
  return { pool, statements };
}

function publicContext(pool: Pool, cookie?: string): PublicContext {
  return {
    repo: new AuthRepository(pool), notifier: { emit: vi.fn(async () => undefined) } as unknown as Notifier,
    request: new Request('https://example.test/module/auth/rpc', { headers: cookie ? { cookie } : {} }),
    resHeaders: new Headers(), env, loginAttempts: createRateLimiter({ limit: 10, windowMs: 60_000 }),
  };
}

/** The statements of one transaction, reduced to what they do. */
function transaction(statements: { on: string; text: string }[], name = 'tx1'): string[] {
  return statements.filter(({ on }) => on === name).map(({ text }) => text.trim().split(/\s+/).slice(0, 3).join(' '));
}

describe('a change and its audit entry share one transaction', () => {
  it('registers the account, its audit entry, its verification token and its session between one BEGIN and one COMMIT', async () => {
    const { pool, statements } = recorder({ addressTaken: false });
    const context = publicContext(pool);
    await publicRouter.createCaller(context).register({ email: 'new@example.test', password: 'long-enough-password' });

    const inside = transaction(statements);
    expect(inside[0]).toBe('BEGIN');
    expect(inside.at(-1)).toBe('COMMIT');
    expect(inside).toEqual(expect.arrayContaining(['INSERT INTO identities', 'INSERT INTO auth_audit', 'INSERT INTO auth_tokens', 'INSERT INTO sessions']));
    // Nothing was written outside the transaction: the pool only answered the "is the address taken" read.
    expect(statements.filter(({ on }) => on === 'pool').map(({ text }) => text.trim().slice(0, 6))).toEqual(['SELECT']);
    expect(statements.some(({ on }) => on === 'tx2')).toBe(false);
    // The notification hand-off happened after the commit, not inside the transaction.
    expect(context.notifier.emit).toHaveBeenCalledOnce();
  });

  it('rolls the registration back when the audit entry cannot be written, and hands nothing to Notifications', async () => {
    const { pool, statements } = recorder({ auditFails: true, addressTaken: false });
    const context = publicContext(pool);
    await expect(publicRouter.createCaller(context).register({ email: 'new@example.test', password: 'long-enough-password' }))
      .rejects.toThrow('audit storage refused');

    const inside = transaction(statements);
    expect(inside).toContain('INSERT INTO identities');
    expect(inside.at(-1)).toBe('ROLLBACK');
    expect(inside).not.toContain('COMMIT');
    expect(inside).not.toContain('INSERT INTO sessions');
    expect(context.notifier.emit).not.toHaveBeenCalled();
    expect(context.resHeaders.get('set-cookie')).toBeNull();
  });

  it('registers no cookie when the commit itself is lost', async () => {
    const { pool, statements } = recorder({ commitFails: true, addressTaken: false });
    const context = publicContext(pool);
    await expect(publicRouter.createCaller(context).register({ email: 'new@example.test', password: 'long-enough-password' }))
      .rejects.toThrow('commit lost');
    expect(transaction(statements)).toContain('INSERT INTO sessions');
    expect(transaction(statements).at(-1)).toBe('ROLLBACK');
    expect(context.resHeaders.get('set-cookie')).toBeNull();
    expect(context.notifier.emit).not.toHaveBeenCalled();
  });

  it('signs in with the session, the login stamp and the audit entry in one transaction', async () => {
    const { pool, statements } = recorder();
    const context = publicContext(pool);
    // The stored hash is not a real scrypt hash; the check is skipped by making it match a real one.
    const { hashPassword } = await import('./crypto.js');
    identity.password_hash = await hashPassword('correct-password');
    await publicRouter.createCaller(context).login({ email: identity.email, password: 'correct-password' });

    const inside = transaction(statements);
    expect(inside[0]).toBe('BEGIN');
    expect(inside.at(-1)).toBe('COMMIT');
    expect(inside).toEqual(expect.arrayContaining(['INSERT INTO sessions', 'UPDATE identities SET', 'INSERT INTO auth_audit']));
    expect(context.resHeaders.get('set-cookie')).toContain('session=');
  });

  /*
   * The session row rolls back with the transaction; a header already added to the response would
   * not, and the browser would swap its working cookie for the token of a session that never existed.
   */
  it.each([
    ['the audit entry cannot be written', { auditFails: true }, 'audit storage refused'],
    ['the commit is lost', { commitFails: true }, 'commit lost'],
  ])('sets no session cookie on sign-in when %s', async (_case, options, message) => {
    const { pool, statements } = recorder(options);
    const context = publicContext(pool);
    const { hashPassword } = await import('./crypto.js');
    identity.password_hash = await hashPassword('correct-password');
    await expect(publicRouter.createCaller(context).login({ email: identity.email, password: 'correct-password' }))
      .rejects.toThrow(message);
    expect(transaction(statements)).toContain('INSERT INTO sessions');
    expect(transaction(statements).at(-1)).toBe('ROLLBACK');
    expect(context.resHeaders.get('set-cookie')).toBeNull();
  });

  it('sets the fresh cookie after a password change only once the change has committed', async () => {
    const { hashPassword } = await import('./crypto.js');
    for (const [options, message] of [[{}, null], [{ auditFails: true }, 'audit storage refused'], [{ commitFails: true }, 'commit lost']] as const) {
      identity.password_hash = await hashPassword('current-password');
      const { pool, statements } = recorder(options);
      const context = publicContext(pool, 'session=some-token');
      const call = publicRouter.createCaller(context).changePassword({ currentPassword: 'current-password', password: 'another-long-password' });
      if (message) {
        await expect(call).rejects.toThrow(message);
        expect(transaction(statements).at(-1)).toBe('ROLLBACK');
        expect(context.resHeaders.get('set-cookie')).toBeNull();
      } else {
        await expect(call).resolves.toEqual({ ok: true });
        expect(transaction(statements).at(-1)).toBe('COMMIT');
        expect(context.resHeaders.get('set-cookie')).toContain('session=');
      }
      // The password was written in every case; the session only where the audit let the flow reach it.
      expect(transaction(statements)).toContain('UPDATE identities SET');
      if (!('auditFails' in options)) expect(transaction(statements)).toContain('INSERT INTO sessions');
    }
  });

  it('verifies the address and records it together, joining the token transaction instead of opening a second one', async () => {
    const { pool, statements } = recorder();
    await publicRouter.createCaller(publicContext(pool)).verifyEmail({ token: 'a-token-that-is-long-enough' });

    const inside = transaction(statements);
    expect(inside[0]).toBe('BEGIN');
    expect(inside.at(-1)).toBe('COMMIT');
    expect(inside.filter((text) => text === 'BEGIN')).toHaveLength(1);
    expect(inside).toEqual(expect.arrayContaining(['UPDATE auth_tokens SET', 'UPDATE identities SET', 'INSERT INTO auth_audit']));
    expect(statements.some(({ on }) => on === 'tx2')).toBe(false);
  });

  /*
   * Blocking is asked for by Admin over the internal API. The account change, the revocation of its
   * sessions and tokens and the audit entry with Admin's verified actor are one transaction here —
   * the only place where all three can commit together.
   */
  it.each([true, false])('blocks (%s) an account and records the actor in one transaction, or rolls all of it back', async (blocked) => {
    const actor = { userId: '00000000-0000-4000-8000-000000000002', role: 'owner' as const };
    for (const auditFails of [false, true]) {
      const { pool, statements } = recorder({ auditFails });
      const call = internalRouter.createCaller({ repo: new AuthRepository(pool) }).setIdentityBlocked({ userId: identity.id, blocked, actor });
      if (auditFails) await expect(call).rejects.toThrow('audit storage refused');
      else await expect(call).resolves.toEqual({ ok: true });

      const inside = transaction(statements);
      expect(inside[0]).toBe('BEGIN');
      expect(inside).toContain('UPDATE identities SET');
      if (blocked) expect(inside).toEqual(expect.arrayContaining(['UPDATE auth_tokens SET', 'UPDATE sessions SET']));
      expect(inside.filter((text) => text === 'BEGIN')).toHaveLength(1);
      expect(inside.at(-1)).toBe(auditFails ? 'ROLLBACK' : 'COMMIT');
      const audit = statements.find(({ text }) => text.includes('INSERT INTO auth_audit'));
      expect(audit?.on).toBe('tx1');
    }
  });

  it('refuses to block a protected identity after locking its row, writing nothing', async () => {
    const { pool, statements } = recorder();
    const actor = { userId: '00000000-0000-4000-8000-000000000002', role: 'owner' as const };
    identity.blocking_protected_at = new Date('2026-02-01T00:00:00Z');
    try {
      await expect(internalRouter.createCaller({ repo: new AuthRepository(pool) }).setIdentityBlocked({ userId: identity.id, blocked: true, actor }))
        .rejects.toMatchObject({ code: 'CONFLICT' });
      const inside = transaction(statements);
      // The row was locked and nothing else touched: no UPDATE, no audit, a rollback.
      expect(inside.filter((text) => text.startsWith('UPDATE') || text.startsWith('INSERT'))).toEqual([]);
      expect(inside.at(-1)).toBe('ROLLBACK');
      // Unblocking a protected identity is not refused.
      await internalRouter.createCaller({ repo: new AuthRepository(pool) }).setIdentityBlocked({ userId: identity.id, blocked: false, actor });
    } finally {
      identity.blocking_protected_at = null;
    }
  });

  it('sets and clears the protection with its audit entry in one transaction, and stays quiet when nothing changes', async () => {
    const actor = { userId: '00000000-0000-4000-8000-000000000002', role: 'owner' as const };
    for (const isProtected of [true, false]) {
      // The stored mark is the opposite of what is asked, so the call changes it.
      identity.blocking_protected_at = isProtected ? null : new Date('2026-02-01T00:00:00Z');
      const { pool, statements } = recorder();
      await internalRouter.createCaller({ repo: new AuthRepository(pool) }).setBlockingProtection({ userId: identity.id, protected: isProtected, actor });
      const inside = transaction(statements);
      expect(inside[0]).toBe('BEGIN');
      expect(inside).toEqual(expect.arrayContaining(['UPDATE identities SET', 'INSERT INTO auth_audit']));
      expect(inside.at(-1)).toBe('COMMIT');
      const audit = statements.find(({ text }) => text.includes('INSERT INTO auth_audit'))!;
      expect(audit.values.slice(1, 5)).toEqual([identity.id, isProtected ? 'identity.protected' : 'identity.unprotected', actor.userId, 'owner']);
    }
    identity.blocking_protected_at = null;
    // Asking for what is already there: the row is locked, nothing is written — the panel may ask on every start.
    const { pool, statements } = recorder();
    await internalRouter.createCaller({ repo: new AuthRepository(pool) }).setBlockingProtection({ userId: identity.id, protected: false, actor });
    expect(transaction(statements).filter((text) => text.startsWith('UPDATE') || text.startsWith('INSERT'))).toEqual([]);
  });

  it('records the actor Admin verified and the account it acted on', async () => {
    const { pool, statements } = recorder();
    const actor = { userId: '00000000-0000-4000-8000-000000000002', role: 'admin' as const };
    await internalRouter.createCaller({ repo: new AuthRepository(pool) }).setIdentityBlocked({ userId: identity.id, blocked: false, actor });
    const audit = statements.find(({ text }) => text.includes('INSERT INTO auth_audit'))!;
    // id, identity, action, actor id, actor role, details
    expect(audit.values.slice(1)).toEqual([identity.id, 'identity.unblocked', actor.userId, 'admin', '{}']);
  });

  it('refuses an actor that is not an administrator role, before touching the account', async () => {
    const { pool, statements } = recorder();
    await expect(internalRouter.createCaller({ repo: new AuthRepository(pool) }).setIdentityBlocked({
      userId: identity.id, blocked: true, actor: { userId: identity.id, role: 'root' as never },
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(statements).toEqual([]);
  });

  it('revokes sessions from the module admin with the audit entry in the same transaction, or not at all', async () => {
    for (const auditFails of [false, true]) {
      const { pool, statements } = recorder({ auditFails });
      const caller = adminRouter.createCaller({
        repo: new AuthRepository(pool), notifier: { emit: vi.fn() } as unknown as Notifier, env,
        request: new Request('https://example.test/admin/embed/module/auth/rpc', { headers: { cookie: 'auth_csrf=v', 'x-csrf-token': 'v' } }),
        resHeaders: new Headers(),
        adminContext: { userId: '00000000-0000-4000-8000-000000000002', email: 'owner@example.test', role: 'owner' },
      });
      const call = caller.revokeSessions({ id: identity.id });
      if (auditFails) await expect(call).rejects.toThrow('audit storage refused');
      else await expect(call).resolves.toEqual({ ok: true });

      const inside = transaction(statements);
      expect(inside).toContain('UPDATE sessions SET');
      expect(inside.at(-1)).toBe(auditFails ? 'ROLLBACK' : 'COMMIT');
    }
  });
});
