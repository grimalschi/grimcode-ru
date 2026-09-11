import { createDatabaseBrowser } from './admin/database/index.js';
import type { AuthApi, Identity } from '@template/contracts/modules/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authorize, visibleModules } from './authorization.js';
import { createInternalCaller } from './internal/index.js';
import { authorizationResultSchema } from './schemas.js';
import type { AdministratorRow, AdminRepository } from './repository.js';


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

/**
 * Auth, answering from memory.
 *
 * A procedure per key, because that is the shape a caller has.
 *
 * The double cast means this object is not checked against Auth's router at all — a procedure that
 * does not exist there compiles here, checked 20 August. What catches a drifting router is
 * `authorize` itself: it calls through `ModuleContext`, so a renamed or reshaped procedure stops
 * compiling there.
 */
function fakeAuth(options: { session?: Identity | null; first?: Identity | null }): AuthApi {
  return {
    resolveSession: async () => ({ identity: options.session ?? null }),
    getFirstIdentity: async () => ({ identity: options.first ?? null }),
    getIdentityByEmail: async () => ({ identity: null }),
  } as unknown as AuthApi;
}

const catalogue = ['auth', 'users', 'notifications', 'email'].map((id) => ({ id, admin: { icon: 'app-window', title: id } }));

let repo: FakeRepo;

beforeEach(() => {
  repo = new FakeRepo();
});

function deps(auth: AuthApi) {
  return { repo: repo as unknown as AdminRepository, auth, catalogue, databaseBrowser: createDatabaseBrowser(async () => { throw new Error('Unexpected database access'); }) };
}

describe('one internal caller', () => {
  it('keeps overlapping owner and administrator sessions separate with lazy per-call context', async () => {
    repo.rows.set(FIRST.id, administrator({ user_id: FIRST.id, email: FIRST.email, role: 'owner' }));
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, email: SECOND.email, role: 'admin' }));
    let releaseOwner!: () => void;
    let ownerStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseOwner = resolve; });
    const started = new Promise<void>((resolve) => { ownerStarted = resolve; });
    const auth: AuthApi = {
      ...fakeAuth({}),
      resolveSession: async ({ sessionToken }) => {
        if (sessionToken === 'owner-session') {
          ownerStarted();
          await waiting;
          return { identity: FIRST };
        }
        return { identity: SECOND };
      },
    };
    const context = vi.fn(async () => deps(auth));
    const caller = createInternalCaller(context);
    expect(context).not.toHaveBeenCalled();

    const owner = caller.authorize({ sessionToken: 'owner-session', target: { area: 'module', module: 'auth' } });
    await started;
    try {
      await expect(caller.authorize({ sessionToken: 'admin-session', target: { area: 'module', module: 'auth' } }))
        .resolves.toEqual({ state: 'denied', reason: 'no-grant' });
    } finally { releaseOwner(); }
    await expect(owner).resolves.toEqual({
      state: 'allowed', userId: FIRST.id, email: FIRST.email, role: 'owner',
    });
    expect(context).toHaveBeenCalledTimes(2);
  });
});

describe('session requirement', () => {
  /** Somebody has registered in Auth, so the panel has an owner to point at: an ordinary refusal. */
  it('denies a request without a session cookie', async () => {
    const result = await authorize(
      { sessionToken: null, target: { area: 'panel' } },
      deps(fakeAuth({ first: FIRST })),
    );
    expect(result).toEqual({ state: 'denied', reason: 'no-session' });
  });

  it('denies a session Auth no longer recognises', async () => {
    const result = await authorize(
      { sessionToken: 'stale', target: { area: 'panel' } },
      deps(fakeAuth({ session: null })),
    );
    expect(result).toEqual({ state: 'denied', reason: 'no-session' });
  });
});

describe('first owner bootstrap', () => {
  /**
   * A fresh installation answers the visitor who has nothing to sign in with, which is the only way
   * this state is ever reached: a session would mean an identity, and an identity means Auth has a
   * first one to promote.
   */
  it('reports that nobody has registered yet instead of refusing outright', async () => {
    const result = await authorize(
      { sessionToken: null, target: { area: 'panel' } },
      deps(fakeAuth({ first: null })),
    );
    expect(result).toEqual({ state: 'awaiting-first-user' });
    expect(repo.rows.size).toBe(0);
  });

  /** And it says so about the panel only while the registry is empty — one owner ends it. */
  it('stops saying so once an administrator exists', async () => {
    repo.rows.set(FIRST.id, {
      user_id: FIRST.id,
      email: FIRST.email,
      role: 'owner',
      enabled: true,
      grants: null,
      bootstrap: true,
    } as never);

    const result = await authorize(
      { sessionToken: null, target: { area: 'panel' } },
      deps(fakeAuth({ first: null })),
    );
    expect(result).toEqual({ state: 'denied', reason: 'no-session' });
  });

  it('makes the first registered Auth user the owner', async () => {
    const result = await authorize(
      { sessionToken: 't', target: { area: 'panel' } },
      deps(fakeAuth({ session: FIRST, first: FIRST })),
    );
    expect(result).toMatchObject({ state: 'allowed', role: 'owner', userId: FIRST.id });
  });

  it('gives ownership to the first Auth user even when someone else opens the panel', async () => {
    // The second user opens /admin first, but ownership follows registration order.
    const result = await authorize(
      { sessionToken: 't', target: { area: 'panel' } },
      deps(fakeAuth({ session: SECOND, first: FIRST })),
    );

    expect(result).toEqual({ state: 'denied', reason: 'not-an-administrator' });
    expect(repo.rows.get(FIRST.id)?.role).toBe('owner');
    expect(repo.rows.has(SECOND.id)).toBe(false);
  });

  it('is idempotent and audits only the call that really created the owner', async () => {
    const auth = fakeAuth({ session: FIRST, first: FIRST });
    const [a, b] = await Promise.all([
      authorize({ sessionToken: 't', target: { area: 'panel' } }, deps(auth)),
      authorize({ sessionToken: 't', target: { area: 'panel' } }, deps(auth)),
    ]);

    expect(a).toMatchObject({ state: 'allowed', userId: FIRST.id });
    expect(b).toMatchObject({ state: 'allowed', userId: FIRST.id });
    expect(repo.rows.size).toBe(1);
    expect(repo.auditEntries).toEqual(['owner.bootstrapped']);
  });

  it('stops attempting the bootstrap once any administrator exists', async () => {
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, role: 'admin' }));
    await authorize(
      { sessionToken: 't', target: { area: 'panel' } },
      deps(fakeAuth({ session: SECOND, first: FIRST })),
    );
    expect(repo.bootstrapCalls).toHaveLength(0);
  });
});

describe('roles and grants', () => {
  beforeEach(() => {
    repo.rows.set(FIRST.id, administrator({ user_id: FIRST.id, role: 'owner', bootstrap: true }));
  });

  it('lets an owner open every admin module', async () => {
    for (const module of ['auth', 'users', 'notifications', 'email'] as const) {
      const result = await authorize(
        { sessionToken: 't', target: { area: 'module', module } },
        deps(fakeAuth({ session: FIRST })),
      );
      expect(result).toMatchObject({ state: 'allowed', role: 'owner' });
    }
  });

  it('denies a granted module to an administrator who does not have it', async () => {
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, grants: ['email'] }));

    await expect(
      authorize({ sessionToken: 't', target: { area: 'module', module: 'email' } }, deps(fakeAuth({ session: SECOND }))),
    ).resolves.toMatchObject({ state: 'allowed', role: 'admin' });

    await expect(
      authorize({ sessionToken: 't', target: { area: 'module', module: 'auth' } }, deps(fakeAuth({ session: SECOND }))),
    ).resolves.toEqual({ state: 'denied', reason: 'no-grant' });
  });

  it('lets any enabled administrator open central Admin', async () => {
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, grants: [] }));
    const result = await authorize(
      { sessionToken: 't', target: { area: 'panel' } },
      deps(fakeAuth({ session: SECOND })),
    );
    expect(result).toMatchObject({ state: 'allowed', role: 'admin' });
  });

  it('denies a disabled administrator without deleting their history', async () => {
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, enabled: false }));
    const result = await authorize(
      { sessionToken: 't', target: { area: 'panel' } },
      deps(fakeAuth({ session: SECOND })),
    );
    expect(result).toEqual({ state: 'denied', reason: 'disabled' });
  });

  it('refuses a module id that is not an admin module', async () => {
    const result = await authorize(
      { sessionToken: 't', target: { area: 'module', module: 'billing' as never } },
      deps(fakeAuth({ session: FIRST })),
    );
    expect(result).toEqual({ state: 'denied', reason: 'unknown-module' });
  });

  it('uses installed metadata and refuses owner-only modules even with a stale grant', async () => {
    repo.rows.set(SECOND.id, administrator({ user_id: SECOND.id, grants: ['billing', 'operations'] }));
    const installed = [
      { id: 'billing', admin: { icon: 'app-window', title: 'Billing' } },
      { id: 'operations', admin: { icon: 'app-window', title: 'Operations', assignable: false } },
    ];
    const context = { ...deps(fakeAuth({ session: SECOND })), catalogue: installed };
    await expect(authorize({ sessionToken: 't', target: { area: 'module', module: 'billing' } }, context))
      .resolves.toMatchObject({ state: 'allowed' });
    await expect(authorize({ sessionToken: 't', target: { area: 'module', module: 'operations' } }, context))
      .resolves.toEqual({ state: 'denied', reason: 'owner-only' });
    expect(visibleModules('admin', ['billing', 'operations'], installed)).toEqual(['billing']);
    expect(visibleModules('owner', [], installed)).toEqual(['billing', 'operations']);
  });
});

describe('sidebar contents', () => {
  it('shows every admin module to an owner', () => {
    expect(visibleModules('owner', [], catalogue)).toEqual(['auth', 'users', 'notifications', 'email']);
  });

  it('shows a regular administrator only what they were granted', () => {
    expect(visibleModules('admin', ['email'], catalogue)).toEqual(['email']);
    expect(visibleModules('admin', [], catalogue)).toEqual([]);
  });
});

describe('authorization result', () => {
  it('models denial reasons explicitly so Router never interprets an error', () => {
    expect(
      authorizationResultSchema.safeParse({ state: 'denied', reason: 'owner-only' }).success,
    ).toBe(true);
    expect(authorizationResultSchema.safeParse({ state: 'denied' }).success).toBe(false);
    expect(authorizationResultSchema.safeParse({ state: 'awaiting-first-user' }).success).toBe(true);
  });
});
