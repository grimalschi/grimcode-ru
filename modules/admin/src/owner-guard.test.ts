import type { AuthApi, Identity } from '@template/contracts/modules/auth';
import { describe, expect, it } from 'vitest';

import { lastOwnerGuard, ownersAbleToSignIn } from './admin/router.js';

function identity(id: string, blockedAt: string | null): Identity {
  return {
    id,
    email: `${id}@example.com`,
    emailVerifiedAt: null,
    blockedAt,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Auth answering from memory, and counting what it was asked: the question must not be asked when
 * there is nobody to ask about.
 */
function fakeAuth(identities: Identity[]): { auth: AuthApi; asked: string[][] } {
  const asked: string[][] = [];

  const auth = {
    getIdentitiesByIds: async ({ ids }: { ids: readonly string[] }) => {
      asked.push([...ids]);
      return { identities: identities.filter((one) => ids.includes(one.id)) };
    },
  } as unknown as AuthApi;

  return { auth, asked };
}

const ACTIVE = identity('owner-active', null);
const BLOCKED = identity('owner-blocked', '2026-08-19T00:00:00.000Z');

describe('who is left able to enter the panel', () => {
  /**
   * The hole this closes: the registry's own flag says an owner is enabled, while Auth has taken
   * every session away, so the owner it counts cannot actually sign in.
   */
  it('does not count an owner who is blocked in Auth', async () => {
    const { auth } = fakeAuth([ACTIVE, BLOCKED]);

    await expect(ownersAbleToSignIn([BLOCKED.id], auth)).resolves.toEqual([]);
    await expect(ownersAbleToSignIn([ACTIVE.id, BLOCKED.id], auth)).resolves.toEqual([ACTIVE.id]);
  });

  it('counts an accessible owner after the first two hundred candidates', async () => {
    const identities = Array.from({ length: 201 }, (_, index) => identity(`owner-${index}`, index === 200 ? null : BLOCKED.blockedAt));
    const { auth, asked } = fakeAuth(identities);
    await expect(ownersAbleToSignIn(identities.map((one) => one.id), auth)).resolves.toEqual(['owner-200']);
    expect(asked.map((ids) => ids.length)).toEqual([200, 1]);
  });

  it('asks Auth nothing when the registry lists no other owner', async () => {
    const { auth, asked } = fakeAuth([ACTIVE]);

    await expect(ownersAbleToSignIn([], auth)).resolves.toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('the last owner rule', () => {
  const guard = lastOwnerGuard('subject');

  it('refuses to take the rights off the only owner who can enter', () => {
    expect(() => guard({ role: 'admin', enabled: true }, 0)).toThrow(/может войти/);
    expect(() => guard({ role: 'owner', enabled: false }, 0)).toThrow(/может войти/);
  });

  it('allows the change when another owner can take over', () => {
    expect(() => guard({ role: 'admin', enabled: true }, 1)).not.toThrow();
  });

  /** Grants and other edits keep working on an owner who stays one. */
  it('allows a change that leaves the subject an active owner', () => {
    expect(() => guard({ role: 'owner', enabled: true }, 0)).not.toThrow();
  });
});
