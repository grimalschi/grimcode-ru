import type { AdminContext } from '@template/contracts/module-instance';
import type { AdminApi, AuthorizationResult } from '@template/contracts/modules/admin';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModule } from './index.js';
import type { RouterEnv } from './env.js';
import type { RouterOptions } from './registry.js';

const DENIED = { state: 'denied', reason: 'not-an-administrator' } satisfies AuthorizationResult;

function setup(env: RouterEnv = { sessionCookieName: 'own_session', publicOrigin: 'https://own.example' }) {
  const authorize = vi.fn<AdminApi['authorize']>().mockResolvedValue(DENIED);
  const forward = vi.fn((_request: Request, _adminContext?: AdminContext) => new Response('upstream'));
  const admin = { authorize } as unknown as AdminApi;
  const options: RouterOptions = {
    env,
    modules: { admin },
    publicFetches: { web: forward, auth: forward, users: forward },
    adminFetches: { admin: forward, auth: forward, users: forward, notifications: forward, email: forward },
  };
  const app = createModule(options);
  return { app, authorize, forward };
}

afterEach(() => vi.unstubAllEnvs());

describe('construction environment', () => {
  it('uses each instance’s cookie name and sign-in origin independently of the process environment', async () => {
    vi.stubEnv('PROJECT_SLUG', 'ambient');
    vi.stubEnv('PUBLIC_SITE_URL', 'https://ambient.example');
    const environments: RouterEnv[] = [
      { sessionCookieName: 'first_session', publicOrigin: 'https://first.example' },
      { sessionCookieName: 'second_session', publicOrigin: 'https://second.example' },
    ];

    for (const env of environments) {
      const { app, authorize, forward } = setup(env);
      const response = await app.publicFetch(
        new Request('https://router.test/admin', {
          headers: {
            accept: 'text/html',
            cookie: 'ambient_session=wrong; first_session=first-token; second_session=second-token',
          },
        }),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const html = await response.text();
      expect(html).toContain(`href="${env.publicOrigin}/app/login"`);
      expect(html).not.toContain('ambient.example');
      expect(authorize).toHaveBeenCalledWith({ sessionToken: env.sessionCookieName === 'first_session' ? 'first-token' : 'second-token', target: { area: 'panel' } });
      expect(forward).not.toHaveBeenCalled();
    }
  });

  it('passes no session when only a different installation’s cookie is present', async () => {
    const { app, authorize } = setup();

    const response = await app.publicFetch(
      new Request('https://router.test/admin', { headers: { cookie: 'other_session=wrong' } }),
    );

    expect(response.status).toBe(403);
    expect(authorize).toHaveBeenCalledWith({ sessionToken: null, target: { area: 'panel' } });
  });

  it('still fails closed when the authorization call rejects', async () => {
    const { app, authorize, forward } = setup();
    authorize.mockRejectedValue(new Error('Admin unavailable'));

    const response = await app.publicFetch(new Request('https://router.test/admin'));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'module-unavailable' });
    expect(forward).not.toHaveBeenCalled();
  });

  it('isolates concurrent sessions while using the same Admin API object', async () => {
    const { app, authorize, forward } = setup();
    let releaseOwner!: () => void;
    let ownerStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const started = new Promise<void>((resolve) => { ownerStarted = resolve; });
    authorize.mockImplementation(async ({ sessionToken }) => {
      if (sessionToken !== 'owner-session') return { state: 'denied', reason: 'owner-only' };
      ownerStarted();
      await waiting;
      return {
        state: 'allowed', role: 'owner',
        userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com',
      };
    });
    const ownerResponse = app.publicFetch(new Request('https://router.test/admin/embed/module/email/', {
      headers: { cookie: 'own_session=owner-session' },
    }));
    await started;
    let denied: Response;
    try {
      denied = await app.publicFetch(new Request('https://router.test/admin/embed/module/email/', {
        headers: { cookie: 'own_session=admin-session' },
      }));
      expect(denied.status).toBe(403);
      expect(forward).not.toHaveBeenCalled();
    } finally { releaseOwner(); }
    const allowed = await ownerResponse;
    expect(allowed.status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
    const forwarded = forward.mock.calls[0]![0];
    expect(forwarded.headers.get('cookie')).toBe('own_session=owner-session');
    expect(forward.mock.calls[0]![1]).toEqual({
      userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', role: 'owner',
    });
    expect(authorize.mock.calls.map(([input]) => input.sessionToken)).toEqual(['owner-session', 'admin-session']);
  });
});
