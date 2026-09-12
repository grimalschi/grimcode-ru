import { describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

const adminContext = { userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', role: 'owner' as const };
const env = {
  databaseUrl: 'postgres://unused/test_notifications',

};

describe('Notifications module connection', () => {
  it('has no public handler and defers dependencies until a procedure is called', async () => {
    const send = vi.fn();
    const module = createModule({ env, modules: { email: { send } } });
    expect(module).not.toHaveProperty('publicFetch');
    expect(module.internalCaller.emit).toBeTypeOf('function');
    expect(send).not.toHaveBeenCalled();
    const response = await module.adminFetch(new Request('https://example.test/healthz'), adminContext);
    expect(response.status).toBe(200);
    expect((await module.adminFetch(new Request('https://example.test/module/notifications/rpc/emit'), adminContext)).status).toBe(404);
    expect((await module.adminFetch(new Request('https://example.test/internal/rpc/emit'), adminContext)).status).toBe(404);
  });
});
