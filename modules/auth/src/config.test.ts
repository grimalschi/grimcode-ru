import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hashPassword } from './crypto.js';
import type { AuthEnv } from './env.js';
import { createModule } from './index.js';
import type { Notifier } from './notifier.js';
import type { AuthRepository, IdentityRow } from './repository.js';
import { adminRouter, type AdminRpcContext } from './admin/router.js';
import { publicRouter, type PublicContext } from './public/router.js';
import { createRateLimiter } from './rate-limit.js';

const env = {
  databaseUrl: 'postgres://unused/configured_auth',
  sessionTtlSeconds: 90,
  publicOrigin: 'https://configured.example',
  sessionCookieName: 'configured_session',
  csrfCookieName: 'configured_csrf_auth',
} satisfies AuthEnv;

const identity: IdentityRow = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'person@example.com',
  password_hash: '',
  email_verified_at: null,
  blocked_at: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  last_login_at: null,
};

function dependencies() {
  const repo = {
    findIdentityByEmail: vi.fn(async () => identity),
    findIdentityById: vi.fn(async () => identity),
    createSession: vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => 'session-id'),
    touchLogin: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined),
    revokeSessionByToken: vi.fn(async () => undefined),
    issueToken: vi.fn(async () => true),
  };
  const notifier = { emit: vi.fn(async () => undefined) };
  return { repo, notifier };
}

function publicContext(deps: ReturnType<typeof dependencies>, cookie?: string): PublicContext {
  return {
    repo: deps.repo as unknown as AuthRepository,
    notifier: deps.notifier as unknown as Notifier,
    request: new Request('http://auth/module/auth/rpc', {
      headers: cookie ? { cookie } : {},
    }),
    resHeaders: new Headers(),
    env,
    loginAttempts: createRateLimiter({ limit: 10, windowMs: 60_000 }),
  };
}

function adminContext(deps: ReturnType<typeof dependencies>, cookie: string): AdminRpcContext {
  return {
    repo: deps.repo as unknown as AuthRepository,
    notifier: deps.notifier as unknown as Notifier,
    request: new Request('http://auth/admin/embed/module/auth/rpc', {
      headers: { cookie, 'x-csrf-token': 'csrf-value' },
    }),
    resHeaders: new Headers(),
    env,
    admin: {
      userId: '00000000-0000-4000-8000-000000000002',
      email: 'owner@example.com',
      role: 'owner',
    },
  };
}

describe('configuration passed to Auth', () => {
  it('keeps a throttled recovery request from emitting a replacement link', async () => {
    const deps = dependencies();
    deps.repo.issueToken.mockResolvedValue(false);
    await expect(publicRouter.createCaller(publicContext(deps)).requestPasswordReset({ email: identity.email }))
      .resolves.toEqual({ ok: true });
    expect(deps.notifier.emit).not.toHaveBeenCalled();
  });

  it('does not set a session cookie if credentials changed during login', async () => {
    const deps = dependencies();
    deps.repo.findIdentityByEmail.mockResolvedValue({ ...identity, password_hash: await hashPassword('correct horse battery') });
    deps.repo.createSession.mockResolvedValue(null);
    const ctx = publicContext(deps);
    await expect(publicRouter.createCaller(ctx).login({ email: identity.email, password: 'correct horse battery' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(ctx.resHeaders.has('set-cookie')).toBe(false);
    expect(deps.repo.touchLogin).not.toHaveBeenCalled();
  });

  it('keeps a CSRF token valid when another tab requests one', async () => {
    const module = createModule({ env, modules: { notifications: { emit: vi.fn() } } });
    const first = await module.adminFetch(new Request('http://auth/admin/embed/module/auth/csrf'));
    const body = await first.json() as { token: string };
    const second = await module.adminFetch(new Request('http://auth/admin/embed/module/auth/csrf', {
      headers: { cookie: `${env.csrfCookieName}=${body.token}` },
    }));
    expect(await second.json()).toEqual(body);
    const invalid = await module.adminFetch(new Request('http://auth/admin/embed/module/auth/csrf', {
      headers: { cookie: `${env.csrfCookieName}=invalid` },
    }));
    expect((await invalid.json() as { token: string }).token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  beforeEach(() => {
    // Conflicting installations expose any accidental use of process-wide settings.
    vi.stubEnv('PROJECT_SLUG', 'unrelated');
    vi.stubEnv('PUBLIC_SITE_URL', 'http://unrelated.example');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('opens and clears the configured session cookie', async () => {
    const deps = dependencies();
    deps.repo.findIdentityByEmail.mockResolvedValue({
      ...identity,
      password_hash: await hashPassword('correct horse battery'),
    });
    const login = publicContext(deps);
    await publicRouter.createCaller(login).login({
      email: identity.email,
      password: 'correct horse battery',
    });

    const cookie = login.resHeaders.get('set-cookie')!;
    expect(cookie).toMatch(/^configured_session=[^;]+; Path=\/; Max-Age=90; HttpOnly; Secure; SameSite=Lax$/);
    const token = cookie.slice('configured_session='.length).split(';')[0];
    expect(deps.repo.createSession).toHaveBeenCalledWith(expect.objectContaining({ id: identity.id, password_hash: expect.stringMatching(/^scrypt\$/) }), token, 90, null);

    const logout = publicContext(deps, `unrelated_session=wrong-token; ${cookie.split(';')[0]}`);
    await publicRouter.createCaller(logout).logout({});
    expect(deps.repo.revokeSessionByToken).toHaveBeenCalledWith(token);
    expect(logout.resHeaders.get('set-cookie')).toBe(
      'configured_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('builds public recovery links from the configured origin', async () => {
    const deps = dependencies();
    await publicRouter.createCaller(publicContext(deps)).requestPasswordReset({
      email: identity.email,
    });
    expect(deps.notifier.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          resetUrl: expect.stringMatching(/^https:\/\/configured\.example\/app\/reset-password\/confirm\?token=/),
        },
      }),
      expect.any(String),
    );
  });

  it('requires its configured CSRF cookie and uses its origin for administrator recovery', async () => {
    const deps = dependencies();
    const otherSurface = adminContext(deps, 'configured_csrf_panel=csrf-value');
    await expect(adminRouter.createCaller(otherSurface).sendRecovery({ id: identity.id }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(deps.repo.issueToken).not.toHaveBeenCalled();

    const ctx = adminContext(deps, 'configured_csrf_auth=csrf-value');
    await adminRouter.createCaller(ctx).sendRecovery({ id: identity.id });
    expect(deps.notifier.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          resetUrl: expect.stringMatching(/^https:\/\/configured\.example\/app\/reset-password\/confirm\?token=/),
        },
      }),
      expect.any(String),
    );
  });

  it('issues the CSRF cookie from settings captured when the module is created', async () => {
    const module = createModule({ env, modules: { notifications: { emit: vi.fn() } } });
    const response = await module.adminFetch(new Request('http://auth/admin/embed/module/auth/csrf'));
    expect(response.status).toBe(200);
    const { token } = await response.json() as { token: string };
    expect(response.headers.get('set-cookie')).toContain(`configured_csrf_auth=${token};`);
  });
});
