import type { AuthApi } from '@template/contracts/modules/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

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
    'x-template-admin-user-id': id, 'x-template-admin-email': 'owner@example.com',
    'x-template-admin-role': 'owner',
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
      const response = await module.adminFetch(request(procedure, input, token));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('CSRF') } });
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(query).not.toHaveBeenCalled();
      for (const call of Object.values(auth)) expect(call).not.toHaveBeenCalled();
    }
  });

  it('validates administrative and internal inputs before storage or Auth', async () => {
    const { module, auth } = setup();
    const response = await module.adminFetch(request('addAdministrator', { email: 'invalid', role: 'admin' }));
    expect(response.status).toBe(400);
    await expect(module.internalCaller.authorize({ sessionToken: '', target: { area: 'panel' } }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
