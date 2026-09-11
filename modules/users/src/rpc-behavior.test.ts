import type { AuthApi } from '@template/contracts/modules/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

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
      'x-template-admin-user-id': id, 'x-template-admin-email': 'owner@example.com',
      'x-template-admin-role': 'owner',
    },
  });
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Users RPC validation', () => {
  it('rejects malformed profile edits and admin lookups before accessing profiles', async () => {
    const { module, auth } = setup();
    const edited = await module.publicFetch(request('/module/users/rpc/updateOwnProfile', { displayName: 'x'.repeat(121) }, 'POST'));
    const lookup = await module.adminFetch(request('/admin/embed/module/users/rpc/getProfile', { id: 'invalid' }));
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
