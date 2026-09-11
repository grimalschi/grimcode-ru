import { createDatabaseBrowser } from './admin/database/index.js';
import type { AuthApi } from '@template/contracts/modules/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminEnv } from './env.js';
import { createModule } from './index.js';
import type { AdminRepository } from './repository.js';
import { adminRouter } from './admin/router.js';
import type { AdminRpcContext } from './admin/rpc.js';

const env: AdminEnv = {
  databaseUrl: 'postgres://unused/configured_admin',
  sessionCookieName: 'configured_session',
  csrfCookieName: 'configured_csrf_panel',
  publicOrigin: 'https://configured.example',
};

function context(cookie: string) {
  const revoke = vi.fn(async (_input: { sessionToken: string }) => ({ ok: true as const }));
  const ctx: AdminRpcContext = {
    env,
    catalogue: [],
    databaseBrowser: createDatabaseBrowser(async () => { throw new Error('Unexpected database access'); }),
    // Logout needs Auth, and never reads the administrator repository.
    repo: {} as AdminRepository,
    auth: { revokeSessionByToken: revoke } as unknown as AuthApi,
    request: new Request('http://admin/admin/rpc', {
      headers: { cookie, 'x-csrf-token': 'csrf-value' },
    }),
    resHeaders: new Headers(),
    admin: {
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'owner@example.com',
      role: 'owner',
    },
  };
  return { ctx, revoke };
}

describe('configuration passed to Admin', () => {
  beforeEach(() => {
    vi.stubEnv('PROJECT_SLUG', 'unrelated');
    vi.stubEnv('PUBLIC_SITE_URL', 'http://unrelated.example');
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each(['https', 'http'])('revokes and clears only the configured session cookie over %s', async (scheme) => {
    const { ctx, revoke } = context(
      'unrelated_session=wrong; configured_session=active; configured_csrf_panel=csrf-value',
    );
    ctx.env = { ...ctx.env, publicOrigin: `${scheme}://configured.example` };

    await adminRouter.createCaller(ctx).logout({});

    expect(revoke).toHaveBeenCalledWith({ sessionToken: 'active' });
    expect(ctx.resHeaders.get('set-cookie')).toBe(
      `configured_session=; Path=/; Max-Age=0; HttpOnly${scheme === 'https' ? '; Secure' : ''}; SameSite=Lax`,
    );
  });

  it('refuses a mutation carrying the CSRF cookie of another surface', async () => {
    const { ctx, revoke } = context('configured_session=active; configured_csrf_auth=csrf-value');

    await expect(adminRouter.createCaller(ctx).logout({})).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(revoke).not.toHaveBeenCalled();
    expect(ctx.resHeaders.has('set-cookie')).toBe(false);
  });

  it('does not clear the cookie if Auth fails to revoke the session', async () => {
    const { ctx, revoke } = context('configured_session=active; configured_csrf_panel=csrf-value');
    revoke.mockRejectedValue(new Error('Auth unavailable'));

    await expect(adminRouter.createCaller(ctx).logout({})).rejects.toThrow('Auth unavailable');

    expect(ctx.resHeaders.has('set-cookie')).toBe(false);
  });

  it('issues the CSRF cookie from the settings supplied at creation', async () => {
    const { adminFetch } = createModule({ env, catalogue: [], modules: { auth: {} as AuthApi } });
    const response = await adminFetch(new Request('http://admin/admin/csrf'));

    expect(response.status).toBe(200);
    const { token } = await response.json() as { token: string };
    expect(response.headers.get('set-cookie')).toContain(`configured_csrf_panel=${token};`);
  });

  it('keeps the first tab token valid when a second tab asks for CSRF', async () => {
    const { adminFetch } = createModule({ env, catalogue: [], modules: { auth: {} as AuthApi } });
    const first = await adminFetch(new Request('http://admin/admin/csrf'));
    const { token } = await first.json() as { token: string };
    const second = await adminFetch(new Request('http://admin/admin/csrf', { headers: { cookie: `configured_csrf_panel=${token}` } }));
    expect(await second.json()).toEqual({ token });
    const { ctx, revoke } = context(`configured_session=active; configured_csrf_panel=${token}`);
    ctx.request.headers.set('x-csrf-token', token);
    await adminRouter.createCaller(ctx).logout({});
    expect(revoke).toHaveBeenCalledOnce();
  });

  it('rejects an unknown or owner-only grant before looking up users or writing data', async () => {
    const { ctx } = context('configured_csrf_panel=csrf-value');
    ctx.catalogue = [
      { id: 'billing', admin: { icon: 'app-window', title: 'Billing' } },
      { id: 'operations', admin: { icon: 'app-window', title: 'Operations', assignable: false } },
    ];
    const caller = adminRouter.createCaller(ctx);

    for (const grant of ['uninstalled', 'operations', 'database']) {
      await expect(caller.addAdministrator({ email: 'user@example.com', role: 'admin', grants: [grant] }))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(caller.updateAdministrator({ userId: ctx.admin!.userId, grants: [grant] }))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  });

  it('sends the browser only installed modules that this administrator can open', async () => {
    const { ctx } = context('');
    ctx.catalogue = [
      { id: 'billing', admin: { icon: 'app-window', title: 'Payments' } },
      { id: 'operations', admin: { icon: 'app-window', title: 'Operations', assignable: false } },
      { id: 'reports', admin: { icon: 'app-window', title: 'Reports' } },
    ];
    ctx.repo = {
      findByUserId: async () => ({
        user_id: ctx.admin!.userId,
        email: ctx.admin!.email,
        role: 'admin',
        grants: ['billing', 'operations', 'uninstalled'],
      }),
    } as unknown as AdminRepository;

    const session = await adminRouter.createCaller(ctx).session({});

    expect(session.modules).toEqual(['billing']);
    expect(session.catalogue).toEqual([{ id: 'billing', admin: { icon: 'app-window', title: 'Payments' } }]);
    expect(session.role).toBe('admin');
  });
});
