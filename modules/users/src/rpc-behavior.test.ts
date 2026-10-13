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
  csrfCookieName: 'users_csrf',
};

function setup() {
  const auth = {
    resolveSession: vi.fn<AuthApi['resolveSession']>().mockResolvedValue({ identity: {
      id, email: 'person@example.com', emailVerifiedAt: null, blockedAt: null, blockingProtectedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    } }),
    revokeSessionByToken: vi.fn<AuthApi['revokeSessionByToken']>(),
    getFirstIdentity: vi.fn<AuthApi['getFirstIdentity']>(),
    getIdentitiesByIds: vi.fn<AuthApi['getIdentitiesByIds']>(),
    searchIdentities: vi.fn<AuthApi['searchIdentities']>(),
    getIdentityByEmail: vi.fn<AuthApi['getIdentityByEmail']>(),
    setIdentityBlocked: vi.fn<AuthApi['setIdentityBlocked']>().mockResolvedValue({ ok: true }),
    setBlockingProtection: vi.fn<AuthApi['setBlockingProtection']>(),
  };
  return { auth, module: createModule({ env, modules: { auth } }) };
}

function request(path: string, input: unknown, method = 'GET', csrf?: string) {
  const url = new URL(path, 'https://example.test');
  if (method === 'GET') url.searchParams.set('input', JSON.stringify(input));
  return new Request(url, {
    method, body: method === 'POST' ? JSON.stringify(input) : undefined,
    headers: {
      'content-type': 'application/json', cookie: `session=active${csrf ? `; users_csrf=${csrf}` : ''}`,
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
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

describe('blocking an account from the profile list', () => {
  const other = '00000000-0000-4000-8000-000000000009';
  const token = 'tokentokentokentokentokentokenAA';

  it('is the owner\'s alone, with this module\'s CSRF token, and passes the verified actor to Auth', async () => {
    const { module, auth } = setup();
    const path = '/admin/embed/module/users/rpc/setBlocked';
    const withoutToken = await module.adminFetch(request(path, { identityId: other, blocked: true }, 'POST'), administrator);
    expect(withoutToken.status).toBe(403);
    const asAdmin = await module.adminFetch(request(path, { identityId: other, blocked: true }, 'POST', token), { ...administrator, role: 'admin' });
    expect(asAdmin.status).toBe(403);
    expect(auth.setIdentityBlocked).not.toHaveBeenCalled();

    const allowed = await module.adminFetch(request(path, { identityId: other, blocked: true }, 'POST', token), administrator);
    expect(allowed.status).toBe(200);
    expect(auth.setIdentityBlocked).toHaveBeenCalledWith({
      userId: other, blocked: true, actor: { userId: administrator.userId, role: 'owner' },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses the owner\'s own account before asking Auth, and passes Auth\'s refusal on', async () => {
    const { module, auth } = setup();
    const path = '/admin/embed/module/users/rpc/setBlocked';
    const self = await module.adminFetch(request(path, { identityId: administrator.userId, blocked: true }, 'POST', token), administrator);
    expect(self.status).toBe(409);
    expect(auth.setIdentityBlocked).not.toHaveBeenCalled();

    const { TRPCError } = await import('@trpc/server');
    auth.setIdentityBlocked.mockRejectedValueOnce(new TRPCError({ code: 'CONFLICT', message: 'Владельца нельзя заблокировать' }));
    const refused = await module.adminFetch(request(path, { identityId: other, blocked: true }, 'POST', token), administrator);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { message: 'Владельца нельзя заблокировать' } });
  });

  it('shows Auth\'s blocking state beside the address, and the viewer\'s role', async () => {
    const { module, auth } = setup();
    query.mockResolvedValue({ rows: [{
      id, identity_id: other, display_name: 'Ada', created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
    }], rowCount: 1 });
    auth.getIdentitiesByIds.mockResolvedValue({ identities: [{
      id: other, email: 'ada@example.com', emailVerifiedAt: null, blockedAt: '2026-03-01T00:00:00.000Z', blockingProtectedAt: null, createdAt: '2026-01-01T00:00:00.000Z',
    }] });
    const listed = await module.adminFetch(request('/admin/embed/module/users/rpc/listProfiles', {}), administrator);
    expect(await listed.json()).toMatchObject({ result: { data: { items: [{
      email: 'ada@example.com', blockedAt: '2026-03-01T00:00:00.000Z', blockingProtectedAt: null,
    }] } } });
    const viewer = await module.adminFetch(request('/admin/embed/module/users/rpc/viewer', {}), { ...administrator, role: 'admin' });
    expect(await viewer.json()).toMatchObject({ result: { data: { userId: administrator.userId, role: 'admin' } } });
  });
});

describe('Users error responses carry no stack', () => {
  it('omits the stack from an anonymous refusal, a rejected input and an internal failure', async () => {
    const { module } = setup();
    const refused = await module.publicFetch(new Request('https://example.test/module/users/rpc/getOwnProfile?input={}'));
    expect(refused.status).toBe(401);
    expect((await refused.json()).error.data).not.toHaveProperty('stack');

    const malformed = await module.adminFetch(request('/admin/embed/module/users/rpc/listProfiles', { limit: 'many' }), administrator);
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.data).not.toHaveProperty('stack');

    query.mockRejectedValue(new Error('private database detail'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const failed = await module.adminFetch(request('/admin/embed/module/users/rpc/listProfiles', {}), administrator);
      expect(failed.status).toBe(500);
      const body = await failed.json();
      expect(body.error.message).toBe('Internal server error');
      expect(body.error.data).not.toHaveProperty('stack');
    } finally {
      log.mockRestore();
    }
  });
});
