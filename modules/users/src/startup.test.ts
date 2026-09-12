import type { AuthApi } from '@template/contracts/modules/auth';
import type * as Migrator from './db/migrator.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

const administrator = {
  userId: '00000000-0000-4000-8000-000000000002',
  email: 'owner@example.com', role: 'owner' as const,
};

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

  sessionCookieName: 'test_session',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('users startup migration', () => {
  it('prepares storage once and reuses it for administrative requests', async () => {
    const module = createModule({ env, modules: { auth: {} as AuthApi } });
    expect(state.constructors).not.toHaveBeenCalled();
    await Promise.all([module.migrate(), module.migrate()]);
    expect(state.migrated).toHaveBeenCalledOnce();
    expect(state.constructors.mock.calls.map(([options]) => ({
      application: options.application_name, connectionString: options.connectionString,
    }))).toEqual([
      { application: 'users-module', connectionString: env.databaseUrl },
    ]);

    // The administrative handler reuses the storage prepared by startup.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await module.adminFetch(new Request('https://example.test/admin/embed/module/users/rpc/listProfiles?input={}'), administrator);
    } finally { errorLog.mockRestore(); }
    expect(state.constructors).toHaveBeenCalledOnce();
    expect(state.migrated).toHaveBeenCalledOnce();
  });

  it('retries a failed preparation and then reuses the prepared pool', async () => {
    state.migrated.mockRejectedValueOnce(new Error('migration failed'));
    const module = createModule({ env, modules: { auth: {} as AuthApi } });

    await expect(module.migrate()).rejects.toThrow('migration failed');
    await Promise.all([module.migrate(), module.migrate()]);
    await module.migrate();

    expect(state.migrated).toHaveBeenCalledTimes(2);
    expect(state.constructors).toHaveBeenCalledTimes(2);
    expect(state.closed).toHaveBeenCalledOnce();
  });

  it('has no database-panel HTTP endpoints, including through the SPA fallback', async () => {
    const module = createModule({ env, modules: { auth: {} as AuthApi } });
    for (const [path, method] of [['schema', 'GET'], ['columns', 'POST'], ['columns/rename', 'POST'], ['columns/drop', 'POST']] as const) {
      const response = await module.adminFetch(new Request(`https://example.test/admin/embed/database/api/schemas/users/${path}`, { method }), administrator);
      expect(response.status).toBe(404);
    }
    expect(state.constructors).not.toHaveBeenCalled();
  });
});
