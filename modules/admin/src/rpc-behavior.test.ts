import type { AuthApi } from '@template/contracts/modules/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

const owner = { userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', role: 'owner' as const };

const query = vi.hoisted(() => vi.fn());
vi.mock('./db/database.js', () => ({ createDatabase: () => async () => ({ query }) }));

const id = '00000000-0000-4000-8000-000000000001';
const env = {
  databaseUrl: 'postgres://unused/test_admin',
  csrfCookieName: 'admin_csrf', sessionCookieName: 'session', publicOrigin: 'https://example.test',
};

function setup() {
  const auth = {
    resolveSession: vi.fn<AuthApi['resolveSession']>(),
    revokeSessionByToken: vi.fn<AuthApi['revokeSessionByToken']>(),
    getFirstIdentity: vi.fn<AuthApi['getFirstIdentity']>(),
    getIdentitiesByIds: vi.fn<AuthApi['getIdentitiesByIds']>(),
    searchIdentities: vi.fn<AuthApi['searchIdentities']>(),
    getIdentityByEmail: vi.fn<AuthApi['getIdentityByEmail']>(),
  };
  return { auth, module: createModule({ env, modules: { auth }, catalogue: [] }) };
}

function request(procedure: string, input: unknown, token: string | null = 'csrf-value') {
  const headers = new Headers({
    'content-type': 'application/json', cookie: 'admin_csrf=csrf-value; session=active-session',
  });
  if (token !== null) headers.set('x-csrf-token', token);
  return new Request(`https://example.test/admin/rpc/${procedure}`, {
    method: 'POST', headers, body: JSON.stringify(input),
  });
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Admin RPC boundaries', () => {
  it.each([
    { procedure: 'addAdministrator', input: { email: 'person@example.com', role: 'admin', grants: [] } },
    { procedure: 'updateAdministrator', input: { userId: id, enabled: false } },
    { procedure: 'logout', input: {} },
  ])('$procedure refuses missing or mismatched CSRF before storage or Auth', async ({ procedure, input }) => {
    const { module, auth } = setup();
    for (const token of [null, 'different-token']) {
      const response = await module.adminFetch(request(procedure, input, token), owner);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('CSRF') } });
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(query).not.toHaveBeenCalled();
      for (const call of Object.values(auth)) expect(call).not.toHaveBeenCalled();
    }
  });

  it('validates administrative and internal inputs before storage or Auth', async () => {
    const { module, auth } = setup();
    const response = await module.adminFetch(request('addAdministrator', { email: 'invalid', role: 'admin' }), owner);
    expect(response.status).toBe(400);
    await expect(module.internalCaller.authorize({ sessionToken: '', target: { area: 'panel' } }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(query).not.toHaveBeenCalled();
    for (const call of Object.values(auth)) expect(call).not.toHaveBeenCalled();
  });

  it('keeps overlapping administrator contexts separate across awaited work', async () => {
    const { module } = setup();
    const other = { userId: '00000000-0000-4000-8000-000000000002', email: 'other@example.com', role: 'admin' as const };
    const pending = new Map<string, () => void>();
    query.mockImplementation(async (_sql: string, [userId]: string[]) => {
      await new Promise<void>((resolve) => pending.set(userId, resolve));
      return { rows: [{ user_id: userId, role: userId === owner.userId ? 'owner' : 'admin', grants: [] }], rowCount: 1 };
    });
    const req = () => new Request('https://example.test/admin/rpc/session?input={}', {
      headers: { 'x-template-admin-user-id': 'forged', 'x-template-admin-email': 'forged@example.com', 'x-template-admin-role': 'owner' },
    });
    const first = Promise.resolve(module.adminFetch(req(), owner));
    const second = Promise.resolve(module.adminFetch(req(), other));
    await vi.waitFor(() => expect(pending.size).toBe(2));
    pending.get(other.userId)!();
    expect(await (await second).json()).toMatchObject({ result: { data: other } });
    pending.get(owner.userId)!();
    expect(await (await first).json()).toMatchObject({ result: { data: owner } });
  });

  it('uses the supplied role even when the request claims owner privileges', async () => {
    const { module, auth } = setup();
    const req = request('addAdministrator', { email: 'person@example.com', role: 'admin', grants: [] });
    req.headers.set('x-template-admin-role', 'owner');
    req.headers.set('x-template-admin-user-id', owner.userId);
    req.headers.set('x-template-admin-email', owner.email);
    const response = await module.adminFetch(req, { ...owner, role: 'admin' });
    expect(response.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
    for (const call of Object.values(auth)) expect(call).not.toHaveBeenCalled();
  });

  it('validates the authorization decision returned to Router', async () => {
    const { module, auth } = setup();
    auth.resolveSession.mockResolvedValue({ identity: {
      id, email: 'owner@example.com', emailVerifiedAt: null, blockedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    } });
    const row = { user_id: id, email: 'owner@example.com', role: 'owner', enabled: true, count: '1' };
    query.mockResolvedValue({ rows: [row], rowCount: 1 });
    const input = { sessionToken: 'active', target: { area: 'panel' as const } };
    await expect(module.internalCaller.authorize(input)).resolves.toEqual({
      state: 'allowed', userId: id, email: row.email, role: 'owner',
    });

    query.mockResolvedValue({ rows: [{ ...row, role: 'invalid-stored-role' }], rowCount: 1 });
    await expect(module.internalCaller.authorize(input))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Output validation failed' });
  });
});

describe('Admin error responses carry no stack', () => {
  it('omits the stack from a CSRF refusal and from an internal failure', async () => {
    const { module } = setup();
    const refused = await module.adminFetch(request('logout', {}, null), owner);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.data).not.toHaveProperty('stack');

    query.mockRejectedValue(new Error('private database detail'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failed = await module.adminFetch(request('listAdministrators', {}), owner);
      expect(failed.status).toBe(500);
      const body = await failed.json();
      expect(body.error.message).toBe('Внутренняя ошибка');
      expect(body.error.data).not.toHaveProperty('stack');
    } finally {
      log.mockRestore();
    }
  });
});
