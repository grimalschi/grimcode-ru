import type { AuthApi } from '@template/contracts/modules/auth';
import { describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

const env = {
  databaseUrl: 'postgres://unused/test_users',
  sessionCookieName: 'users_session',

};
const request = (path: string) => new Request(`https://example.test${path}`);

describe('Users module surfaces', () => {
  it('never dispatches administrative paths through publicFetch or public paths through adminFetch', async () => {
    const resolveSession = vi.fn();
    const auth = { resolveSession } as unknown as AuthApi;
    const module = createModule({ env, modules: { auth } });
    for (const path of ['/admin/embed/module/users/rpc/listProfiles', '/admin/embed/module/users/']) {
      expect((await module.publicFetch(request(path))).status).toBe(404);
    }
    expect((await module.adminFetch(request('/module/users/rpc/getOwnProfile'))).status).toBe(404);
    expect(resolveSession).not.toHaveBeenCalled();
  });

});
