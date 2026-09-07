import { createTRPCClient, httpLink } from '@trpc/client';

import type { AuthAdminRouter } from '@template/auth/contract';

/**
 * Client for this module's own admin API. Gateway has already checked the session, the role and the
 * grant; changing calls carry a CSRF token of this module's own scope, so one minted for the shell
 * is refused here. Which calls carry it is decided by the operation's type, not by a list of names.
 */
const BASE = '/admin/embed/service/auth';

const link = httpLink({
  url: `${window.location.origin}${BASE}/rpc`,
  // Queries travel as POST too: bodies stay out of URLs, and out of the caches a GET invites.
  methodOverride: 'POST',
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
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

export const api = createTRPCClient<AuthAdminRouter>({ links: [link] });

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
