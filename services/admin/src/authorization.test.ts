import type { Identity } from '@template/contracts';
import { createLogger } from '@template/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { authorize, visibleServices, type AuthClient } from './authorization.js';
import type { AdministratorRow, AdminRepository } from './repository.js';

const logger = createLogger('admin-test');

function identity(id: string, email: string): Identity {
  return {
    id,
    email,
    emailVerifiedAt: null,
    blockedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const FIRST = identity('00000000-0000-4000-8000-000000000001', 'first@example.com');
const SECOND = identity('00000000-0000-4000-8000-000000000002', 'second@example.com');

function administrator(partial: Partial<AdministratorRow> & { user_id: string }): AdministratorRow {
  return {
    id: 'row-1',
    email: 'admin@example.com',
    role: 'admin',
    enabled: true,
    bootstrap: false,
    created_at: new Date(),
    updated_at: new Date(),
    grants: [],
    ...partial,
  };
}

/** In-memory stand-ins so the rules can be exercised without a database or a running Auth. */
class FakeRepo {
  rows = new Map<string, AdministratorRow>();
  bootstrapCalls: string[] = [];
  auditEntries: string[] = [];

  isRegistryEmpty = async () => this.rows.size === 0;
  findByUserId = async (userId: string) => this.rows.get(userId) ?? null;

  bootstrapOwner = async (userId: string, email: string) => {
    this.bootstrapCalls.push(userId);
    const existing = this.rows.get(userId);
    if (existing) return { row: existing, created: false };

    // Mirrors the partial unique index: only one bootstrap owner can ever exist.
    const alreadyBootstrapped = [...this.rows.values()].some((row) => row.bootstrap);
    const row = administrator({ user_id: userId, email, role: 'owner', bootstrap: true });
    if (alreadyBootstrapped) return { row, created: false };

    this.rows.set(userId, row);
    this.auditEntries.push('owner.bootstrapped');
    return { row, created: true };
  };

  firstBootstrapOwner = async () =>
    [...this.rows.values()].find((row) => row.bootstrap) ?? null;
}

function fakeAuth(options: { session?: Identity | null; first?: Identity | null }): AuthClient {
  return {
    resolveSession: async () => ({ identity: options.session ?? null }),
    getFirstIdentity: async () => ({ identity: options.first ?? null }),
    getIdentityById: async () => ({ identity: null }),
    getIdentityByEmail: async () => ({ identity: null }),
  } as unknown as AuthClient;
}

let repo: FakeRepo;

beforeEach(() => {
  repo = new FakeRepo();
});

function deps(auth: AuthClient) {
  return { repo: repo as unknown as AdminRepository, auth, logger };
}

describe('session requirement', () => {
  it('denies a request without a session cookie', async () => {
    const result = await authorize(
      { sessionToken: null, service: null },
      deps(fakeAuth({ session: FIRST })),
    );
    expect(result).toEqual({ state: 'denied', reason: 'no-session' });
  });

  it('denies a session Auth no longer recognises', async () => {
    const result = await authorize(
      { sessionToken: 'stale', service: null },
      deps(fakeAuth({ session: null })),
    );
    expect(result).toEqual({ state: 'denied', reason: 'no-session' });
  });
});

describe('first owner bootstrap', () => {
  it('reports that nobody has registered yet instead of creating an owner', async () => {
    const result = await authorize(
      { sessionToken: 't', service: null },
      deps(fakeAuth({ session: FIRST, first: null })),
    );
    expect(result).toEqual({ state: 'awaiting-first-user' });
    expect(repo.rows.size).toBe(0);
  });

  it('makes the first registered Auth user the owner', async () => {
    const result = await authorize(
      { sessionToken: 't', service: null },
      deps(fakeAuth({ session: FIRST, first: FIRST })),
    );
    expect(result).toMatchObject({ state: 'allowed', role: 'owner', userId: FIRST.id });
  });

  it('gives ownership to the first Auth user even when someone else opens the panel', async () => {
    // The second user opens /admin first, but ownership follows registration order.
    const result = await authorize(
      { sessionToken: 't', service: null },
      deps(fakeAuth({ session: SECOND, first: FIRST })),
    );

    expect(result).toEqual({ state: 'denied', reason: 'not-an-administrator' });
    expect(repo.rows.get(FIRST.id)?.role).toBe('owner');
    expect(repo.rows.has(SECOND.id)).toBe(false);
  });

  it('is idempotent and audits only the call that really created the owner', async () => {
    const auth = fakeAuth({ session: FIRST, first: FIRST });
    const [a, b] = await Promise.all([
      authorize({ sessionToken: 't', service: null }, deps(auth)),
      authorize({ sessionToken: 't', service: null }, deps(auth)),
    ]);

    expect(a).toMatchObject({ state: 'allowed', userId: FIRST.id });
    expect(b).toMatchObject({ state: 'allowed', userId: FIRST.id });
    expect(repo.rows.size).toBe(1);
    expect(repo.auditEntries).toEqual(['owner.bootstrapped']);
  });

  it('stops attempting the bootstrap once any administrator exists', async () => {
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, role: 'admin' }));
    await authorize(
      { sessionToken: 't', service: null },
      deps(fakeAuth({ session: SECOND, first: FIRST })),
    );
    expect(repo.bootstrapCalls).toHaveLength(0);
  });
});

describe('roles and grants', () => {
  beforeEach(() => {
    repo.rows.set(FIRST.id, administrator({ user_id: FIRST.id, role: 'owner', bootstrap: true }));
  });

  it('lets an owner open every admin service', async () => {
    for (const service of ['auth', 'users', 'notifications', 'email', 'adminer'] as const) {
      const result = await authorize(
        { sessionToken: 't', service },
        deps(fakeAuth({ session: FIRST })),
      );
      expect(result).toMatchObject({ state: 'allowed', role: 'owner' });
    }
  });

  it('denies a granted service to an administrator who does not have it', async () => {
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, grants: ['email'] }));

    await expect(
      authorize({ sessionToken: 't', service: 'email' }, deps(fakeAuth({ session: SECOND }))),
    ).resolves.toMatchObject({ state: 'allowed', role: 'admin' });

    await expect(
      authorize({ sessionToken: 't', service: 'auth' }, deps(fakeAuth({ session: SECOND }))),
    ).resolves.toEqual({ state: 'denied', reason: 'no-grant' });
  });

  it('never lets a regular administrator reach Adminer, even with a grant row', async () => {
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, grants: ['adminer', 'email'] }));

    const result = await authorize(
      { sessionToken: 't', service: 'adminer' },
      deps(fakeAuth({ session: SECOND })),
    );
    expect(result).toEqual({ state: 'denied', reason: 'owner-only' });
  });

  it('lets any enabled administrator open central Admin', async () => {
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, grants: [] }));
    const result = await authorize(
      { sessionToken: 't', service: null },
      deps(fakeAuth({ session: SECOND })),
    );
    expect(result).toMatchObject({ state: 'allowed', role: 'admin' });
  });

  it('denies a disabled administrator without deleting their history', async () => {
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, enabled: false }));
    const result = await authorize(
      { sessionToken: 't', service: null },
      deps(fakeAuth({ session: SECOND })),
    );
    expect(result).toEqual({ state: 'denied', reason: 'disabled' });
  });

  it('refuses a service id that is not an admin service', async () => {
    const result = await authorize(
      { sessionToken: 't', service: 'billing' as never },
      deps(fakeAuth({ session: FIRST })),
    );
    expect(result).toEqual({ state: 'denied', reason: 'unknown-service' });
  });
});

describe('sidebar contents', () => {
  it('shows every admin service to an owner, Adminer included', () => {
    expect(visibleServices('owner', [])).toContain('adminer');
  });

  it('shows a regular administrator only their granted services and never Adminer', () => {
    expect(visibleServices('admin', ['email', 'adminer'])).toEqual(['email']);
    expect(visibleServices('admin', [])).toEqual([]);
  });
});
