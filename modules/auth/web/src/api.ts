import { createTRPCClient, httpLink, type TRPCClient } from '@trpc/client';

import type { AuthAdminRouter } from '../../src/admin/router.js';

/**
 * Client for this module's own admin API. Router has already checked the session, the role and the
 * grant; changing calls carry a CSRF token of this module's own scope, so one minted for the shell
 * is refused here. Which calls carry it is decided by the operation's type, not by a list of names.
 */
const BASE = '/admin/embed/module/auth';

const link = httpLink({
  url: `${window.location.origin}${BASE}/rpc`,
  // Queries travel as POST too: bodies stay out of URLs, and out of the caches a GET invites.
  methodOverride: 'POST',
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  headers: async (options) =>
    options.op.type === 'mutation' ? { 'x-csrf-token': await csrfToken() } : {},
});

async function csrfToken(): Promise<string> {
  const response = await fetch(`${BASE}/csrf`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('The CSRF token could not be obtained');
  return (await response.json() as { token: string }).token;
}

export const api: TRPCClient<AuthAdminRouter> = createTRPCClient<AuthAdminRouter>({ links: [link] });

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
