import { createTRPCClient, httpLink } from '@trpc/client';

import type { UsersAdminRouter } from '@template/users/contract';

/**
 * Client for this module's own admin API. Gateway has already checked the session, the role and the
 * grant; changing calls carry a CSRF token this module issued, under its own scope.
 */
const BASE = '/admin/embed/service/users';

const link = httpLink({
  url: `${window.location.origin}${BASE}/rpc`,
  // Queries travel as POST too: bodies stay out of URLs, and out of the caches a GET invites.
  methodOverride: 'POST',
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  // The token is attached to exactly what changes something, decided by the operation's own type:
  // a list of names kept by hand is a list that disagrees with the server sooner or later.
  headers: async (options) =>
    options.op.type === 'mutation' ? { 'x-csrf-token': await csrfToken() } : {},
});

let cached: Promise<string> | null = null;

async function csrfToken(): Promise<string> {
  cached ??= fetch(`${BASE}/csrf`, { credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) throw new Error('The CSRF token could not be obtained');
      return response.json() as Promise<{ token: string }>;
    })
    .then((body) => body.token)
    .catch((error: unknown) => {
      // A failed fetch must not poison every later mutation.
      cached = null;
      throw error;
    });

  return cached;
}

export const api = createTRPCClient<UsersAdminRouter>({ links: [link] });

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
