import { createTRPCClient, httpLink, type TRPCClient } from '@trpc/client';

import type { UsersAdminRouter } from '../../src/admin/router.js';

/** Read-only profile administration API; Router verifies the administrator and grant. */
const BASE = '/admin/embed/module/users';

const link = httpLink({
  url: `${window.location.origin}${BASE}/rpc`,
  // Queries travel as POST too: bodies stay out of URLs, and out of the caches a GET invites.
  methodOverride: 'POST',
  fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
});

export const api: TRPCClient<UsersAdminRouter> = createTRPCClient<UsersAdminRouter>({ links: [link] });
