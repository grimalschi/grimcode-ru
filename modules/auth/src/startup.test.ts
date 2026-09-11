import type * as Migrator from './db/migrator.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

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
  csrfCookieName: 'auth_csrf',
  sessionCookieName: 'test_session',
  publicOrigin: 'https://example.test',
  sessionTtlSeconds: 90,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('auth startup migration', () => {
  it('prepares storage once and reuses it for administrative requests', async () => {
    const module = createModule({ env, modules: { notifications: { emit: vi.fn() } } });
    expect(state.constructors).not.toHaveBeenCalled();
    await Promise.all([module.migrate(), module.migrate()]);
    expect(state.migrated).toHaveBeenCalledOnce();
    expect(state.constructors.mock.calls.map(([options]) => ({
      application: options.application_name, connectionString: options.connectionString,
    }))).toEqual([
      { application: 'auth-module', connectionString: env.databaseUrl },
    ]);

    // Context preparation reaches storage even when the subsequent admin guard refuses this call.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await module.adminFetch(new Request('https://example.test/admin/embed/module/auth/rpc/listIdentities?input={}'));
    } finally { errorLog.mockRestore(); }
    expect(state.constructors).toHaveBeenCalledOnce();
    expect(state.migrated).toHaveBeenCalledOnce();
  });

  it('retries a failed preparation and then reuses the prepared pool', async () => {
    state.migrated.mockRejectedValueOnce(new Error('migration failed'));
    const module = createModule({ env, modules: { notifications: { emit: vi.fn() } } });

    await expect(module.migrate()).rejects.toThrow('migration failed');
    await Promise.all([module.migrate(), module.migrate()]);
    await module.migrate();

    expect(state.migrated).toHaveBeenCalledTimes(2);
    expect(state.constructors).toHaveBeenCalledTimes(2);
    expect(state.closed).toHaveBeenCalledOnce();
  });

  it('has no database-panel HTTP endpoints, including through the SPA fallback', async () => {
    const module = createModule({ env, modules: { notifications: { emit: vi.fn() } } });
    for (const [path, method] of [['schema', 'GET'], ['columns', 'POST'], ['columns/rename', 'POST'], ['columns/drop', 'POST']] as const) {
      const response = await module.adminFetch(new Request(`https://example.test/admin/embed/database/api/schemas/auth/${path}`, { method }));
      expect(response.status).toBe(404);
    }
    expect(state.constructors).not.toHaveBeenCalled();
  });
});
