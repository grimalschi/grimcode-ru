import type { AdminContext } from '@template/contracts/module-instance';
import { describe, expect, it, vi } from 'vitest';

import type { Notifier } from '../notifier.js';
import type { AuthRepository, IdentityRow } from '../repository.js';
import { createAdminFetch } from './index.js';

const administrator: AdminContext = {
  userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.test', role: 'owner',
};
const otherAdministrator: AdminContext = {
  userId: '00000000-0000-4000-8000-000000000002', email: 'admin@example.test', role: 'admin',
};
const firstTarget = '00000000-0000-4000-8000-000000000003';
const secondTarget = '00000000-0000-4000-8000-000000000004';

function request(id = firstTarget) {
  return new Request('https://example.test/admin/embed/module/auth/rpc/revokeSessions', {
    method: 'POST', body: JSON.stringify({ id }),
    headers: {
      'content-type': 'application/json', cookie: 'auth_csrf=csrf-value', 'x-csrf-token': 'csrf-value',
      'x-template-admin-user-id': '00000000-0000-4000-8000-000000000099',
      'x-template-admin-email': 'forged@example.test', 'x-template-admin-role': 'owner',
    },
  });
}

function setup() {
  const repo = {
    findIdentityById: vi.fn(async (id: string): Promise<IdentityRow> => ({
      id, email: 'person@example.test', password_hash: '', email_verified_at: null, blocked_at: null,
      created_at: new Date('2026-01-01T00:00:00Z'), last_login_at: null,
    })),
    revokeAllSessions: vi.fn(async (_id: string) => 1),
    audit: vi.fn(async (_entry: Parameters<AuthRepository['audit']>[0]) => undefined),
  };
  const adminFetch = createAdminFetch({
    env: {
      databaseUrl: 'postgres://unused/auth', sessionTtlSeconds: 90, publicOrigin: 'https://example.test',
      sessionCookieName: 'session', csrfCookieName: 'auth_csrf',
    },
    repository: async () => repo as unknown as AuthRepository,
    notifier: { emit: vi.fn() } as unknown as Notifier,
  });
  return { repo, adminFetch };
}

describe('administrative handler context', () => {
  it('refuses forged headers without an argument, including after an authorized request', async () => {
    const { repo, adminFetch } = setup();
    const denied: Response = await Reflect.apply(adminFetch, undefined, [request()]);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { data: { code: 'FORBIDDEN' } } });
    expect(repo.findIdentityById).not.toHaveBeenCalled();

    const response = await adminFetch(request(), otherAdministrator);
    expect(response.status).toBe(200);
    expect(repo.audit).toHaveBeenCalledExactlyOnceWith({
      identityId: firstTarget, action: 'admin.sessions.revoked',
      actorUserId: otherAdministrator.userId, actorRole: 'admin', details: { revoked: 1 },
    });

    const later: Response = await Reflect.apply(adminFetch, undefined, [request()]);
    expect(later.status).toBe(403);
    expect(repo.revokeAllSessions).toHaveBeenCalledTimes(1);
    expect(repo.audit).toHaveBeenCalledTimes(1);
  });

  it('preserves each actor when concurrent mutations finish in reverse order', async () => {
    const { repo, adminFetch } = setup();
    const releases = new Map<string, () => void>();
    repo.revokeAllSessions.mockImplementation((id) => new Promise<number>((resolve) => {
      releases.set(id, () => resolve(1));
    }));

    const first = adminFetch(request(firstTarget), administrator);
    const second = adminFetch(request(secondTarget), otherAdministrator);
    await vi.waitFor(() => expect(releases.size).toBe(2));
    releases.get(secondTarget)!();
    expect((await second).status).toBe(200);
    releases.get(firstTarget)!();
    expect((await first).status).toBe(200);
    expect(repo.audit.mock.calls.map(([entry]) => ({
      identityId: entry.identityId, actorUserId: entry.actorUserId, actorRole: entry.actorRole,
    }))).toEqual([
      { identityId: secondTarget, actorUserId: otherAdministrator.userId, actorRole: 'admin' },
      { identityId: firstTarget, actorUserId: administrator.userId, actorRole: 'owner' },
    ]);
  });
});
