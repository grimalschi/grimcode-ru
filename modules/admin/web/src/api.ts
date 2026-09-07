import { createTRPCClient, httpLink } from '@trpc/client';

import type { AdminPanelRouter } from '@template/admin/contract';

/**
 * Client for the shell's own API. The session cookie is HttpOnly, so the browser attaches it and
 * this code never sees it; changing calls carry a CSRF token as well.
 *
 * Which calls carry it is decided by the operation's type. The list of names it replaced held
 * `logout` while the handler never checked the token — sent and ignored looks like protection and
 * is not, and no test could see it, because the call succeeded either way.
 */
const link = httpLink({
  url: `${window.location.origin}/admin/rpc`,
  // Queries travel as POST too: bodies stay out of URLs, and out of the caches a GET invites.
  methodOverride: 'POST',
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  headers: async (options) =>
    options.op.type === 'mutation' ? { 'x-csrf-token': await csrfToken() } : {},
});

let cached: Promise<string> | null = null;

async function csrfToken(): Promise<string> {
  cached ??= fetch('/admin/csrf', { credentials: 'same-origin' })
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

export const api = createTRPCClient<AdminPanelRouter>({ links: [link] });
