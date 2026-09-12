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

const adminContext = { userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', role: 'owner' as const };
const env = {
  databaseUrl: 'postgres://module:configured@storage.invalid:5544/test_installation?sslmode=require&application_name=module-test',

};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notifications startup migration', () => {
  it('prepares storage once and reuses it for administrative requests', async () => {
    const module = createModule({ env, modules: { email: { send: vi.fn() } } });
    expect(state.constructors).not.toHaveBeenCalled();
    expect(module).not.toHaveProperty('migrations');
    await Promise.all([module.migrate(), module.migrate()]);
    expect(state.migrated).toHaveBeenCalledOnce();
    expect(state.constructors.mock.calls.map(([options]) => ({
      application: options.application_name, connectionString: options.connectionString,
    }))).toEqual([
      { application: 'notifications-module', connectionString: env.databaseUrl },
    ]);

    const response = await module.adminFetch(new Request('https://example.test/admin/embed/module/notifications/rpc/listEvents?input={}'), adminContext);
    expect(response.status).toBe(200);
    expect(state.constructors).toHaveBeenCalledOnce();
    expect(state.migrated).toHaveBeenCalledOnce();
  });

  it('retries a failed preparation and then reuses the prepared pool', async () => {
    state.migrated.mockRejectedValueOnce(new Error('migration failed'));
    const module = createModule({ env, modules: { email: { send: vi.fn() } } });

    await expect(module.migrate()).rejects.toThrow('migration failed');
    await Promise.all([module.migrate(), module.migrate()]);
    await module.migrate();

    expect(state.migrated).toHaveBeenCalledTimes(2);
    expect(state.constructors).toHaveBeenCalledTimes(2);
    expect(state.closed).toHaveBeenCalledOnce();
  });

  it('has no database-panel HTTP endpoints, including through the SPA fallback', async () => {
    const module = createModule({ env, modules: { email: { send: vi.fn() } } });
    for (const [path, method] of [['schema', 'GET'], ['columns', 'POST'], ['columns/rename', 'POST'], ['columns/drop', 'POST']] as const) {
      const response = await module.adminFetch(new Request(`https://example.test/admin/embed/database/api/schemas/notifications/${path}`, { method }), adminContext);
      expect(response.status).toBe(404);
    }
    expect(state.constructors).not.toHaveBeenCalled();
  });
});
