import { describe, expect, it, vi } from 'vitest';
import type { Identity } from '@template/contracts/modules/auth';
import type { AdminRpcContext } from './admin/rpc.js';
import { adminRouter } from './admin/router.js';
import type { AdministratorRow } from './repository.js';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';

function fixture() {
  const rows: AdministratorRow[] = [first, second].map((id) => ({
    id, user_id: id, email: `${id}@old.test`, role: 'owner', enabled: true, bootstrap: id === first,
    created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01'), grants: [],
  }));
  const identities: Identity[] = rows.map((row) => ({ id: row.user_id, email: `${row.user_id}@current.test`,
    emailVerifiedAt: null, blockedAt: null, createdAt: row.created_at.toISOString(),
  }));
  const auditEntries: unknown[] = [];
  const audit = vi.fn(async (entry: unknown) => { auditEntries.push(entry); });
  const commit = vi.fn();
  let pending = Promise.resolve();
  const repo = {
    list: async () => rows,
    findByUserId: async (id: string) => rows.find((row) => row.user_id === id) ?? null,
    otherActiveOwnerIds: async (id: string) => rows.filter((row) => row.user_id !== id && row.role === 'owner' && row.enabled).map((row) => row.user_id),
    audit: vi.fn(async () => { throw new Error('Audit must use the transaction repository'); }),
    add: vi.fn(async () => { throw new Error('Must not add through stale owner access'); }),
    withRegistryLock: <T>(operation: (repository: unknown) => Promise<T>) => {
      const result = pending.then(async () => {
        const before = structuredClone(rows);
        const auditLength = auditEntries.length;
        try {
          const result = await operation({ ...repo, audit });
          commit();
          return result;
        } catch (error) {
          rows.splice(0, rows.length, ...before);
          auditEntries.splice(auditLength);
          throw error;
        }
      });
      pending = result.then(() => undefined, () => undefined);
      return result;
    },
    update: async (id: string, patch: Partial<AdministratorRow>, guard: (row: AdministratorRow, count: number) => void, eligible: string[]) => {
      const row = rows.find((entry) => entry.user_id === id)!;
      const next = { ...row, ...patch };
      guard(next, eligible.length);
      Object.assign(row, patch);
      return row;
    },
  };
  const auth = {
    getIdentityByEmail: vi.fn(async () => ({ identity: { ...identities[0], id: '00000000-0000-4000-8000-000000000003', email: 'new@example.test' } })),
    resolveSession: async ({ sessionToken }: { sessionToken: string }) => ({ identity: identities.find((identity) => identity.id === sessionToken && !identity.blockedAt) ?? null }),
    getIdentitiesByIds: vi.fn(async ({ ids }: { ids: string[] }) => ({ identities: identities.filter((identity) => ids.includes(identity.id)) })),
    setIdentityBlocked: async ({ userId, blocked }: { userId: string; blocked: boolean }) => {
      identities.find((identity) => identity.id === userId)!.blockedAt = blocked ? new Date().toISOString() : null;
      return { ok: true as const };
    },
  };
  function caller(id: string) {
    return adminRouter.createCaller({
      repo, auth, catalogue: [{ id: 'auth', admin: { title: 'Auth', icon: 'key-round' } }], env: { sessionCookieName: 'session', csrfCookieName: 'csrf', publicOrigin: 'https://test' },
      request: new Request('https://test/admin/rpc', { headers: { cookie: `session=${id}; csrf=value`, 'x-csrf-token': 'value' } }),
      resHeaders: new Headers(), adminContext: { userId: id, email: `${id}@current.test`, role: 'owner' },
    } as unknown as AdminRpcContext);
  }
  return { rows, identities, caller, repo, auth, audit, auditEntries, commit };
}

describe('serialized access changes', () => {
  it('refuses a queued blocking request from an owner whose session was just revoked', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.caller(first).setIdentityBlocked({ userId: second, blocked: true }),
      f.caller(second).setIdentityBlocked({ userId: first, blocked: true }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { code: 'FORBIDDEN' } });
    expect(f.identities.filter((identity) => !identity.blockedAt)).toHaveLength(1);
  });

  it('checks current Auth state when disabling another owner after a blocking operation', async () => {
    const f = fixture();
    await f.caller(first).setIdentityBlocked({ userId: second, blocked: true });
    await expect(f.caller(first).updateAdministrator({ userId: first, enabled: false }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.rows.find((row) => row.user_id === first)?.enabled).toBe(true);
  });

  it('serializes blocking against demotion and preserves a usable owner', async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.caller(first).updateAdministrator({ userId: second, role: 'admin' }),
      f.caller(second).setIdentityBlocked({ userId: first, blocked: true }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(f.rows.filter((row) => row.enabled && row.role === 'owner' && !f.identities.find((identity) => identity.id === row.user_id)!.blockedAt)).toHaveLength(1);
  });

  it('rechecks owner access before adding an administrator', async () => {
    const f = fixture();
    const staleCaller = f.caller(second);
    await f.caller(first).updateAdministrator({ userId: second, role: 'admin' });
    await expect(staleCaller.addAdministrator({ email: 'new@example.test', role: 'owner', grants: [] }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.repo.add).not.toHaveBeenCalled();
  });

  it('does not commit changed access when the target identity lookup fails', async () => {
    const f = fixture();
    const before = structuredClone(f.rows);
    f.auth.getIdentitiesByIds.mockImplementation(async ({ ids }) => {
      if (ids.includes(second)) throw new Error('Auth unavailable');
      return { identities: f.identities.filter((identity) => ids.includes(identity.id)) };
    });
    await expect(f.caller(first).updateAdministrator({ userId: second, role: 'admin', grants: ['auth'] }))
      .rejects.toThrow('Auth unavailable');
    expect(f.rows).toEqual(before);
    expect(f.auditEntries).toEqual([]);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('rolls back the role, enabled state and grants if the audit cannot be written', async () => {
    const f = fixture();
    const before = structuredClone(f.rows);
    f.audit.mockRejectedValueOnce(new Error('Audit unavailable'));
    await expect(f.caller(first).updateAdministrator({ userId: second, role: 'admin', enabled: false, grants: ['auth'] }))
      .rejects.toThrow('Audit unavailable');
    expect(f.rows).toEqual(before);
    expect(f.auditEntries).toEqual([]);
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.repo.audit).not.toHaveBeenCalled();
  });

  it('commits changed access and exactly one audit entry with the current display email', async () => {
    const f = fixture();
    const result = await f.caller(first).updateAdministrator({ userId: second, role: 'admin', enabled: false, grants: ['auth'] });
    expect(result).toMatchObject({ ok: true, administrator: {
      userId: second, email: `${second}@current.test`, role: 'admin', enabled: false, grants: ['auth'],
    } });
    expect(f.rows.find((row) => row.user_id === second)).toMatchObject({ role: 'admin', enabled: false, grants: ['auth'] });
    expect(f.auditEntries).toEqual([{
      action: 'administrator.updated', actorUserId: first, subjectUserId: second,
      details: { role: 'admin', enabled: false, grants: ['auth'] },
    }]);
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.repo.audit).not.toHaveBeenCalled();
  });

  it('rolls back if the response cannot represent the updated administrator', async () => {
    const f = fixture();
    const before = structuredClone(f.rows);
    f.identities.find((identity) => identity.id === second)!.email = 'invalid-email';
    await expect(f.caller(first).updateAdministrator({ userId: second, role: 'admin' })).rejects.toThrow();
    expect(f.rows).toEqual(before);
    expect(f.auditEntries).toEqual([]);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it('uses current identity email for both administrator display and search', async () => {
    const f = fixture();
    const result = await f.caller(first).listAdministrators({ query: '@current.test', limit: 1, offset: 1 });
    expect(result.total).toBe(2);
    expect(result.items[0]?.email).toBe(`${second}@current.test`);
    expect((await f.caller(first).listAdministrators({ query: '@old.test', limit: 25, offset: 0 })).items).toEqual([]);
  });
});
