import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import type { Identity } from '@template/contracts/modules/auth';
import type { AdminRpcContext } from './admin/rpc.js';
import { adminRouter } from './admin/router.js';
import type { AdministratorRow } from './repository.js';

const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
/** A person who can sign in but is no administrator: the one an owner may block. */
const third = '00000000-0000-4000-8000-000000000003';

function fixture() {
  const rows: AdministratorRow[] = [first, second].map((id) => ({
    id, user_id: id, email: `${id}@old.test`, role: 'owner', enabled: true, bootstrap: id === first,
    created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01'), grants: [],
  }));
  // The two owners carry Auth's protection from blocking, as the registry would have set it with their role.
  const identities: Identity[] = [...rows.map((row) => row.user_id), third].map((id) => ({ id, email: `${id}@current.test`,
    emailVerifiedAt: null, blockedAt: null, blockingProtectedAt: id === third ? null : '2026-01-01T00:00:00.000Z',
    createdAt: new Date('2026-01-01').toISOString(),
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
    // As the real Auth does: a protected identity is never blocked, whoever asks.
    setIdentityBlocked: async ({ userId, blocked, actor }: { userId: string; blocked: boolean; actor: { userId: string; role: 'owner' | 'admin' } }) => {
      const identity = identities.find((entry) => entry.id === userId)!;
      if (blocked && identity.blockingProtectedAt !== null) throw new TRPCError({ code: 'CONFLICT', message: 'Владельца нельзя заблокировать' });
      identity.blockedAt = blocked ? new Date().toISOString() : null;
      blockedBy.push({ userId, blocked, actor });
      return { ok: true as const };
    },
    setBlockingProtection: async ({ userId, protected: isProtected, actor }: { userId: string; protected: boolean; actor: { userId: string; role: 'owner' | 'admin' } }) => {
      identities.find((entry) => entry.id === userId)!.blockingProtectedAt = isProtected ? new Date().toISOString() : null;
      protection.push({ userId, protected: isProtected, actor });
      return { ok: true as const };
    },
  };
  /** What Auth was told about each blocking (only the fixture itself asks now; Admin no longer does). */
  const blockedBy: { userId: string; blocked: boolean; actor: { userId: string; role: string } }[] = [];
  /** Every change of the protection the registry asked Auth for, in order. */
  const protection: { userId: string; protected: boolean; actor: { userId: string; role: string } }[] = [];
  function caller(id: string) {
    return adminRouter.createCaller({
      repo, auth, catalogue: [{ id: 'auth', admin: { title: 'Auth', icon: 'key-round' } }], env: { sessionCookieName: 'session', csrfCookieName: 'csrf', publicOrigin: 'https://test' },
      request: new Request('https://test/admin/rpc', { headers: { cookie: `session=${id}; csrf=value`, 'x-csrf-token': 'value' } }),
      resHeaders: new Headers(), adminContext: { userId: id, email: `${id}@current.test`, role: 'owner' },
    } as unknown as AdminRpcContext);
  }
  return { rows, identities, caller, repo, auth, audit, auditEntries, commit, blockedBy, protection };
}

describe('serialized access changes', () => {
  it('keeps the protection with the role: an owner stays protected while disabled, loses it with the role', async () => {
    const f = fixture();
    // Disabling keeps the role, so the protection stays.
    await f.caller(first).updateAdministrator({ userId: second, enabled: false });
    expect(f.protection).toEqual([]);
    expect(f.identities.find((identity) => identity.id === second)!.blockingProtectedAt).not.toBeNull();
    // Taking the role away clears it, with the verified actor.
    await f.caller(first).updateAdministrator({ userId: second, role: 'admin' });
    expect(f.protection).toEqual([{ userId: second, protected: false, actor: { userId: first, role: 'owner' } }]);
    expect(f.identities.find((identity) => identity.id === second)!.blockingProtectedAt).toBeNull();
    // Admin has nothing of its own to write for blocking: the Users screen asks Auth directly.
    expect(f.auditEntries.filter((entry) => /identity\./.test(String((entry as { action: string }).action)))).toEqual([]);
  });

  it('protects a new owner and rolls the registry back when Auth refuses to', async () => {
    const f = fixture();
    await f.caller(first).updateAdministrator({ userId: second, role: 'admin' });
    f.protection.length = 0;
    await f.caller(first).updateAdministrator({ userId: second, role: 'owner' });
    expect(f.protection).toEqual([{ userId: second, protected: true, actor: { userId: first, role: 'owner' } }]);
    expect(f.identities.find((identity) => identity.id === second)!.blockingProtectedAt).not.toBeNull();
    // Auth down while the role is given back: nothing of the change survives.
    await f.caller(first).updateAdministrator({ userId: second, role: 'admin' });
    f.auth.setBlockingProtection = async () => { throw new Error('auth unavailable'); };
    await expect(f.caller(first).updateAdministrator({ userId: second, role: 'owner' })).rejects.toThrow('auth unavailable');
    expect(f.rows.find((row) => row.user_id === second)?.role).toBe('admin');
    expect(f.auditEntries.filter((entry) => (entry as { action: string }).action === 'administrator.updated')).toHaveLength(3);
  });

  it('checks current Auth state when disabling another owner after a blocking elsewhere', async () => {
    // A blocked person (blocked from the Users screen, through Auth) can still be made an owner; such an owner does not count as able to enter.
    const f = fixture();
    await f.caller(first).updateAdministrator({ userId: second, role: 'admin' });
    await f.auth.setIdentityBlocked({ userId: second, blocked: true, actor: { userId: first, role: 'owner' } });
    await f.caller(first).updateAdministrator({ userId: second, role: 'owner' });
    await expect(f.caller(first).updateAdministrator({ userId: first, enabled: false }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.rows.find((row) => row.user_id === first)?.enabled).toBe(true);
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
