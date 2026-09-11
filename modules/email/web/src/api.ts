import { createTRPCClient, httpLink, type TRPCClient } from '@trpc/client';

import type { EmailAdminRouter } from '../../src/admin/router.js';

/**
 * Client for this module's own admin API. Router has already checked the session, the role and the
 * grant; changing calls carry a CSRF token this module issued, under its own scope.
 */
const BASE = '/admin/embed/module/email';

const link = httpLink({
  url: `${window.location.origin}${BASE}/rpc`,
  // Queries travel as POST too: bodies stay out of URLs, and out of the caches a GET invites.
  methodOverride: 'POST',
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  // The token is attached to exactly what changes something: the link knows the operation's type,
  // so `previewVersion` travels without one because it is a query — it renders and stores nothing.
  headers: async (options) =>
    options.op.type === 'mutation' ? { 'x-csrf-token': await csrfToken() } : {},
});

async function csrfToken(): Promise<string> {
  const response = await fetch(`${BASE}/csrf`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('The CSRF token could not be obtained');
  return ((await response.json()) as { token: string }).token;
}

export const api: TRPCClient<EmailAdminRouter> = createTRPCClient<EmailAdminRouter>({ links: [link] });

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
