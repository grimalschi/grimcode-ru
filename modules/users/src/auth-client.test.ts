import type { AuthApi, Identity } from '@template/contracts/modules/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveIdentity } from './auth-client.js';
import { createPublicFetch } from './public/index.js';
import type { UsersRepository } from './repository.js';

const identity: Identity = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'person@example.com',
  emailVerifiedAt: null,
  blockedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function authCaller() {
  const resolveSession = vi.fn(async (_input: { sessionToken: string }) => ({ identity }));
  return { resolveSession, auth: { resolveSession } as unknown as AuthApi };
}

describe('configured session cookie', () => {
  beforeEach(() => vi.stubEnv('PROJECT_SLUG', 'unrelated'));
  afterEach(() => vi.unstubAllEnvs());

  it('asks Auth about the cookie supplied by the composer', async () => {
    const { auth, resolveSession } = authCaller();
    const request = new Request('http://users/module/users/rpc', {
      headers: { cookie: 'unrelated_session=wrong; configured_session=active' },
    });

    await expect(resolveIdentity(request, auth, 'configured_session')).resolves.toEqual(identity);
    expect(resolveSession).toHaveBeenCalledWith({ sessionToken: 'active' });
  });

  it('does not authenticate a cookie belonging to another installation', async () => {
    const { auth, resolveSession } = authCaller();
    const request = new Request('http://users/module/users/rpc', {
      headers: { cookie: 'unrelated_session=wrong' },
    });

    await expect(resolveIdentity(request, auth, 'configured_session')).resolves.toBeNull();
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('shares the Auth API across concurrent requests without mixing identities', async () => {
    const { auth, resolveSession } = authCaller();
    resolveSession.mockImplementation(async ({ sessionToken }) => ({ identity: { ...identity, id: sessionToken } }));
    const repository = {
      ensure: async (identityId: string) => ({
        id: identityId,
        identity_id: identityId,
        display_name: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-01T00:00:00.000Z'),
      }),
    } as unknown as UsersRepository;
    const publicFetch = createPublicFetch({
      env: {
        databaseUrl: 'postgres://unused/users',
        sessionCookieName: 'configured_session',
      },
      repository: async () => repository,
      auth,
    });
    expect(resolveSession).not.toHaveBeenCalled();
    const health = await publicFetch(new Request('https://example.test/healthz'));
    expect(health.status).toBe(200);

    const identityIds = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    const responses = await Promise.all(identityIds.map((id) => publicFetch(new Request('https://example.test/module/users/rpc/getOwnProfile?input={}', {
      headers: { cookie: `configured_session=${id}` },
    }))));
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { data: { profile: { identityId: identityIds[index] } } } });
    }

    expect(resolveSession.mock.calls).toEqual(identityIds.map((id) => [{ sessionToken: id }]));
  });
});
