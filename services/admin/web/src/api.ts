import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { adminContract } from '@template/contracts';

/**
 * Client for the shell's own API.
 *
 * The session cookie is HttpOnly, so the browser attaches it and this code never sees it. Mutating
 * calls additionally carry a CSRF token the server issued.
 */
const link = new RPCLink({
  url: `${window.location.origin}/admin/rpc`,
  fetch: (request, init) => fetch(request, { ...init, credentials: 'same-origin' }),
  headers: async (_options, path) => {
    // Reads need no token; only the operations that change something do.
    if (!MUTATIONS.has(path.join('.'))) return {};
    return { 'x-csrf-token': await csrfToken() };
  },
});

const MUTATIONS = new Set(['addAdministrator', 'updateAdministrator', 'logout']);

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

export const api: ContractRouterClient<(typeof adminContract)['admin']> = createORPCClient(link);
