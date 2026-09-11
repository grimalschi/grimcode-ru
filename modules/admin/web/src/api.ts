import { createTRPCClient, httpLink, type TRPCClient } from '@trpc/client';

import type { AdminPanelRouter } from '../../src/admin/router.js';

/**
 * Client for the shell's own API. The session cookie is HttpOnly, so the browser attaches it and
 * this code never sees it; changing calls carry a CSRF token as well.
 */
const link = httpLink({
  url: `${window.location.origin}/admin/rpc`,
  // Queries travel as POST too: bodies stay out of URLs, and out of the caches a GET invites.
  methodOverride: 'POST',
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  headers: async (options) =>
    options.op.type === 'mutation' ? { 'x-csrf-token': await csrfToken() } : {},
});

async function csrfToken(): Promise<string> {
  const response = await fetch('/admin/csrf', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Не удалось получить CSRF-токен');
  const { token } = await response.json() as { token: string };
  return token;
}

export const api: TRPCClient<AdminPanelRouter> = createTRPCClient<AdminPanelRouter>({ links: [link] });
