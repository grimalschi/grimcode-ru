import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

const administrator = {
  userId: '00000000-0000-4000-8000-000000000002',
  email: 'owner@example.com', role: 'owner' as const,
};

const query = vi.hoisted(() => vi.fn());
vi.mock('./db/database.js', () => ({ createDatabase: () => async () => ({ query }) }));

const id = '00000000-0000-4000-8000-000000000001';
const env = {
  databaseUrl: 'postgres://unused/test_auth',
  csrfCookieName: 'auth_csrf', sessionCookieName: 'session', publicOrigin: 'https://example.test', sessionTtlSeconds: 90,
};

function request(procedure: string, input: unknown, token: string | null = 'csrf-value') {
  const headers = new Headers({
    'content-type': 'application/json', cookie: 'auth_csrf=csrf-value',
  });
  if (token !== null) headers.set('x-csrf-token', token);
  return new Request(`https://example.test/admin/embed/module/auth/rpc/${procedure}`, {
    method: 'POST', headers, body: JSON.stringify(input),
  });
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Auth RPC boundaries', () => {
  it('logs unexpected failures while returning a generic HTTP error without a stack', async () => {
    const failure = new Error('private database detail');
    query.mockRejectedValue(failure);
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const module = createModule({ env, modules: { notifications: { emit: vi.fn() } } });
      const response = await module.publicFetch(new Request('https://example.test/module/auth/rpc/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'person@example.com', password: 'password123' }),
      }));
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body).toMatchObject({ error: { message: 'Не удалось выполнить запрос', data: { code: 'INTERNAL_SERVER_ERROR' } } });
      expect(JSON.stringify(body)).not.toMatch(/private database detail|stack|password123/);
      expect(log).toHaveBeenCalledWith(expect.any(String), failure);
    } finally { log.mockRestore(); }
  });

  it.each([
    { procedure: 'sendRecovery', input: { id } },
    { procedure: 'resendVerification', input: { id } },
    { procedure: 'revokeSessions', input: { id } },
  ])('$procedure refuses missing or mismatched CSRF before storage or notifications', async ({ procedure, input }) => {
    const emit = vi.fn();
    const module = createModule({ env, modules: { notifications: { emit } } });
    for (const token of [null, 'different-token']) {
      const response = await module.adminFetch(request(procedure, input, token), administrator);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('CSRF') } });
      expect(query).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    }
  });

  it('validates administrative and internal inputs before repository calls', async () => {
    const emit = vi.fn();
    const module = createModule({ env, modules: { notifications: { emit } } });
    const response = await module.adminFetch(request('sendRecovery', { id: 'invalid-id' }), administrator);
    expect(response.status).toBe(400);
    await expect(module.internalCaller.getIdentityByEmail({ email: 'not-an-email' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(query).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('returns only identity data and rejects a stored value outside the output contract', async () => {
    const row = {
      id, email: 'person@example.com', password_hash: 'private-password-hash',
      email_verified_at: null, blocked_at: null, created_at: new Date('2026-01-01T00:00:00Z'),
    };
    query.mockResolvedValue({ rows: [row], rowCount: 1 });
    const { internalCaller } = createModule({ env, modules: { notifications: { emit: vi.fn() } } });
    const result = await internalCaller.getIdentityByEmail({ email: row.email });
    expect(result.identity).toEqual({
      id, email: row.email, emailVerifiedAt: null, blockedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    });

    query.mockResolvedValue({ rows: [{ ...row, email: 'invalid-stored-email' }], rowCount: 1 });
    await expect(internalCaller.getIdentityByEmail({ email: row.email }))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Output validation failed' });
  });
});

describe('Auth error responses carry no stack', () => {
  it('omits the stack from an anonymous refusal on both surfaces', async () => {
    const module = createModule({ env, modules: { notifications: { emit: vi.fn() } } });
    const anonymous = await module.publicFetch(new Request('https://example.test/module/auth/rpc/listOwnSessions?input={}'));
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.data).not.toHaveProperty('stack');

    const refused = await module.adminFetch(request('revokeSessions', { userId: id }, null), administrator);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.data).not.toHaveProperty('stack');
  });
});
