import type * as Migrator from './db/migrator.js';
import type { AuthApi } from '@template/contracts/modules/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

const owner = { userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', role: 'owner' as const };

const state = vi.hoisted(() => ({ constructors: vi.fn(), migrated: vi.fn(), closed: vi.fn() }));
vi.mock('pg', () => ({
  default: {
    Pool: class {
      constructor(options: { application_name: string; connectionString: string }) { state.constructors(options); }
      on() {}
      async end() { state.closed(); }
      async query() { return { rows: [], rowCount: 0 }; }
    },
  },
}));
vi.mock('./db/migrator.js', async (original) => ({
  ...await original<typeof Migrator>(),
  runMigrations: state.migrated,
}));

const env = {
  databaseUrl: 'postgres://module:configured@storage.invalid:5544/test_installation?sslmode=require&application_name=module-test',
  csrfCookieName: 'admin_csrf',
  sessionCookieName: 'test_session',
  publicOrigin: 'https://example.test',
  sessionTtlSeconds: 90,
  mail: { provider: 'log', apiKey: '', apiUrl: '', fromAddress: '', fromName: '' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admin startup migration', () => {
  it('prepares storage once and reuses it for administrative requests', async () => {
    const auth = {} as AuthApi;
    const module = createModule({ env, modules: { auth }, catalogue: [] });
    expect(state.constructors).not.toHaveBeenCalled();
    expect(module).not.toHaveProperty('migrations');
    await Promise.all([module.migrate(), module.migrate()]);
    expect(state.migrated).toHaveBeenCalledOnce();
    expect(state.constructors.mock.calls.map(([options]) => ({
      application: options.application_name, connectionString: options.connectionString,
    }))).toEqual([
      { application: 'admin-module', connectionString: env.databaseUrl },
    ]);

    // Context preparation reaches storage even when the subsequent admin guard refuses this call.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await module.adminFetch(new Request('https://example.test/admin/rpc/session?input={}'), undefined as never);
      expect(response.status).toBe(403);
    } finally { errorLog.mockRestore(); }
    expect(state.constructors).toHaveBeenCalledOnce();
    expect(state.migrated).toHaveBeenCalledOnce();
  });

  it('creates one internal API without opening storage until a procedure runs', async () => {
    const auth = {} as AuthApi;
    const module = createModule({ env, modules: { auth }, catalogue: [] });
    const caller = module.internalCaller;
    expect(state.constructors).not.toHaveBeenCalled();
    for (const moduleId of ['uninstalled-one', 'uninstalled-two']) {
      const result = await caller.authorize({
        sessionToken: null,
        target: { area: 'module', module: moduleId },
      });
      expect(result).toEqual({ state: 'denied', reason: 'unknown-module' });
      expect(module.internalCaller).toBe(caller);
    }
    expect(state.migrated).toHaveBeenCalledOnce();
  });

  it('returns logout cookies through the HTTP adapter after revoking the session', async () => {
    const revokeSessionByToken = vi.fn(async () => ({ ok: true as const }));
    const auth = { revokeSessionByToken } as unknown as AuthApi;
    const module = createModule({ env, modules: { auth }, catalogue: [] });
    const response = await module.adminFetch(new Request('https://example.test/admin/rpc/logout', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'test_session=active; admin_csrf=csrf-value',
        'x-csrf-token': 'csrf-value',
      },
      body: '{}',
    }), owner);

    expect(response.status).toBe(200);
    expect(revokeSessionByToken).toHaveBeenCalledWith({ sessionToken: 'active' });
    expect(response.headers.getSetCookie()).toEqual([
      'test_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    ]);
  });

  it('retries a failed preparation and then reuses the prepared pool', async () => {
    state.migrated.mockRejectedValueOnce(new Error('migration failed'));
    const module = createModule({ env, modules: { auth: {} as AuthApi }, catalogue: [] });

    await expect(module.migrate()).rejects.toThrow('migration failed');
    await Promise.all([module.migrate(), module.migrate()]);
    await module.migrate();

    expect(state.migrated).toHaveBeenCalledTimes(2);
    expect(state.constructors).toHaveBeenCalledTimes(2);
    expect(state.closed).toHaveBeenCalledOnce();
  });

  it('has no database-panel HTTP endpoints, including through the SPA fallback', async () => {
    const module = createModule({ env, modules: { auth: {} as AuthApi }, catalogue: [] });
    for (const [path, method] of [['schema', 'GET'], ['columns', 'POST'], ['columns/rename', 'POST'], ['columns/drop', 'POST']] as const) {
      const response = await module.adminFetch(new Request(`https://example.test/admin/embed/database/api/schemas/admin/${path}`, { method }), owner);
      expect(response.status).toBe(404);
    }
    expect(state.constructors).not.toHaveBeenCalled();
  });
});
