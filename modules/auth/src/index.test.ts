import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthEnv } from './env.js';
import { hashPassword } from './crypto.js';
import { createModule } from './index.js';
import { createDatabase } from './db/database.js';
import type { IdentityRow } from './repository.js';

const administrator = {
  userId: '00000000-0000-4000-8000-000000000002',
  email: 'owner@example.com', role: 'owner' as const,
};

const { database, query } = vi.hoisted(() => {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: IdentityRow[] }>>(async () => ({ rows: [] }));
  return { database: vi.fn(async () => ({ query, connect: async () => ({ query, release() {} }) })), query };
});
vi.mock('./db/database.js', () => ({ createDatabase: vi.fn(() => database) }));

const env: AuthEnv = {
  databaseUrl: 'postgres://unused/test_auth',
  sessionTtlSeconds: 90,
  publicOrigin: 'https://example.test',
  sessionCookieName: 'auth_session',
  csrfCookieName: 'auth_csrf',
};
const modules = { notifications: { emit: vi.fn() } };
const request = (path: string) => new Request(`https://example.test${path}`);

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
});

describe('Auth module connection', () => {
  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'refuses invalid session lifetime %s before opening storage',
    (sessionTtlSeconds) => {
      expect(() => createModule({ env: { ...env, sessionTtlSeconds }, modules }))
        .toThrow('Auth sessionTtlSeconds must be a positive safe integer');
      expect(createDatabase).not.toHaveBeenCalled();
      expect(database).not.toHaveBeenCalled();
      expect(modules.notifications.emit).not.toHaveBeenCalled();
    },
  );

  it.each([[undefined, 30 * 24 * 60 * 60], [90, 90]])(
    'uses session lifetime %s for storage and the session cookie',
    async (sessionTtlSeconds, expected) => {
      const identity: IdentityRow = {
        id: '00000000-0000-4000-8000-000000000001', email: 'person@example.com',
        password_hash: await hashPassword('correct horse battery'),
        email_verified_at: null, blocked_at: null, last_login_at: null,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
      };
      query.mockImplementation(async (sql) => ({ rows: sql.includes('SELECT') && sql.includes('FROM identities') ? [identity] : [] }));
      const module = createModule({ env: { ...env, sessionTtlSeconds }, modules });
      expect(database).not.toHaveBeenCalled();
      const response = await module.publicFetch(new Request('https://example.test/module/auth/rpc/login', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: identity.email, password: 'correct horse battery' }),
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain(`Max-Age=${expected};`);
      expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sessions'), [
        expect.any(String), identity.id, expect.any(String), null, expected,
      ]);
    },
  );

  it('keeps administrative routes out of the public application and public routes out of admin', async () => {
    const module = createModule({ env, modules });
    for (const path of ['/admin/embed/module/auth/csrf', '/admin/embed/module/auth/rpc/listIdentities', '/admin/embed/module/auth/']) {
      expect((await module.publicFetch(request(path))).status).toBe(404);
    }
    expect((await module.adminFetch(request('/module/auth/rpc/currentSession'), administrator)).status).toBe(404);
    expect((await module.publicFetch(request('/internal/rpc'))).status).toBe(404);
    expect((await module.adminFetch(request('/internal/rpc'), administrator)).status).toBe(404);
    expect(database).not.toHaveBeenCalled();
  });

  it('captures independent configuration for separate module instances', async () => {
    const first = createModule({ env, modules });
    const second = createModule({ env: { ...env, csrfCookieName: 'other_csrf' }, modules });
    const firstResponse = await first.adminFetch(request('/admin/embed/module/auth/csrf'), administrator);
    const secondResponse = await second.adminFetch(request('/admin/embed/module/auth/csrf'), administrator);
    expect(firstResponse.headers.get('set-cookie')).toMatch(/^auth_csrf=/);
    expect(secondResponse.headers.get('set-cookie')).toMatch(/^other_csrf=/);
    expect(database).not.toHaveBeenCalled();
    expect(modules.notifications.emit).not.toHaveBeenCalled();
  });

  it('opens its captured database lazily and shares it between internal and public calls', async () => {
    const module = createModule({ env, modules });
    const caller = module.internalCaller;
    expect(database).not.toHaveBeenCalled();
    await expect(caller.getFirstIdentity({})).resolves.toEqual({ identity: null });
    expect(createDatabase).toHaveBeenCalledExactlyOnceWith(env);
    expect(database).toHaveBeenCalledWith();
    const response = await module.publicFetch(request('/module/auth/rpc/currentSession?input={}'));
    expect(response.status).toBe(200);
    expect(database).toHaveBeenLastCalledWith();
  });

  it('keeps concurrent procedure inputs and results separate on the same ready caller', async () => {
    const pending = new Map<string, (result: { rows: IdentityRow[] }) => void>();
    query.mockImplementation((_sql, values) => new Promise((resolve) => pending.set(String(values?.[0]), resolve)));
    const module = createModule({ env, modules });
    const caller = module.internalCaller;
    expect(database).not.toHaveBeenCalled();

    const first = caller.getIdentityByEmail({ email: 'first@example.com' });
    const second = caller.getIdentityByEmail({ email: 'second@example.com' });
    await vi.waitFor(() => expect(pending.size).toBe(2));
    expect(database).toHaveBeenCalledTimes(2);
    const identityRow = (id: string, email: string): IdentityRow => ({
      id, email, password_hash: '', email_verified_at: null, blocked_at: null,
      created_at: new Date('2026-01-01T00:00:00.000Z'), last_login_at: null,
    });

    pending.get('second@example.com')!({ rows: [identityRow('00000000-0000-4000-8000-000000000002', 'second@example.com')] });
    await expect(second).resolves.toMatchObject({ identity: { email: 'second@example.com' } });
    pending.get('first@example.com')!({ rows: [identityRow('00000000-0000-4000-8000-000000000001', 'first@example.com')] });
    await expect(first).resolves.toMatchObject({ identity: { email: 'first@example.com' } });
    expect(module.internalCaller).toBe(caller);
  });
});
