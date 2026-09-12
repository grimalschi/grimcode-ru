import type { AuthApi } from '@template/contracts/modules/auth';
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
  databaseUrl: 'postgres://unused/test_users',
  sessionCookieName: 'session',
};

function setup() {
  const auth = {
    resolveSession: vi.fn<AuthApi['resolveSession']>().mockResolvedValue({ identity: {
      id, email: 'person@example.com', emailVerifiedAt: null, blockedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    } }),
    revokeSessionByToken: vi.fn<AuthApi['revokeSessionByToken']>(),
    getFirstIdentity: vi.fn<AuthApi['getFirstIdentity']>(),
    getIdentitiesByIds: vi.fn<AuthApi['getIdentitiesByIds']>(),
    searchIdentities: vi.fn<AuthApi['searchIdentities']>(),
    getIdentityByEmail: vi.fn<AuthApi['getIdentityByEmail']>(),
  };
  return { auth, module: createModule({ env, modules: { auth } }) };
}

function request(path: string, input: unknown, method = 'GET') {
  const url = new URL(path, 'https://example.test');
  if (method === 'GET') url.searchParams.set('input', JSON.stringify(input));
  return new Request(url, {
    method, body: method === 'POST' ? JSON.stringify(input) : undefined,
    headers: {
      'content-type': 'application/json', cookie: 'session=active',
    },
  });
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Users RPC validation', () => {
  it('requires a handler context, ignores forged admin headers and keeps public sessions independent', async () => {
    const { module, auth } = setup();
    const forged = request('/admin/embed/module/users/rpc/listProfiles', {});
    forged.headers.set('x-template-admin-user-id', administrator.userId);
    forged.headers.set('x-template-admin-email', administrator.email);
    forged.headers.set('x-template-admin-role', administrator.role);

    const denied: Response = await Reflect.apply(module.adminFetch, module, [forged.clone()]);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { data: { code: 'FORBIDDEN' } } });
    expect(query).not.toHaveBeenCalled();

    const allowed = await module.adminFetch(request('/admin/embed/module/users/rpc/listProfiles', {}), administrator);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ result: { data: { items: [], total: 0 } } });
    query.mockClear();

    const later: Response = await Reflect.apply(module.adminFetch, module, [forged.clone()]);
    expect(later.status).toBe(403);
    const publicRequest = new Request('https://example.test/module/users/rpc/getOwnProfile?input={}', {
      headers: forged.headers,
    });
    publicRequest.headers.delete('cookie');
    const publicResponse = await module.publicFetch(publicRequest);
    expect(publicResponse.status).toBe(401);
    expect(query).not.toHaveBeenCalled();
    expect(auth.resolveSession).not.toHaveBeenCalled();
  });

  it('rejects malformed profile edits and admin lookups before accessing profiles', async () => {
    const { module, auth } = setup();
    const edited = await module.publicFetch(request('/module/users/rpc/updateOwnProfile', { displayName: 'x'.repeat(121) }, 'POST'));
    const lookup = await module.adminFetch(request('/admin/embed/module/users/rpc/getProfile', { id: 'invalid' }), administrator);
    expect(edited.status).toBe(400);
    expect(lookup.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(auth.getIdentitiesByIds).not.toHaveBeenCalled();
  });

  it('returns profile fields only and refuses invalid stored profile data', async () => {
    const { module } = setup();
    const row = {
      id, identity_id: id, display_name: 'Ada', private_note: 'internal only',
      created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
    };
    query.mockResolvedValue({ rows: [row], rowCount: 1 });
    const response = await module.publicFetch(request('/module/users/rpc/getOwnProfile', {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: { profile: {
      id, identityId: id, displayName: 'Ada', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    } } } });

    query.mockResolvedValue({ rows: [{ ...row, display_name: 123 }], rowCount: 1 });
    const invalid = await module.publicFetch(request('/module/users/rpc/getOwnProfile', {}));
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toMatchObject({ error: { message: 'Internal server error', data: { code: 'INTERNAL_SERVER_ERROR' } } });
  });
});
