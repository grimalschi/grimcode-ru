import { createTRPCClient, httpLink } from '@trpc/client';

import type { AuthPublicRouter } from '@template/contracts/modules/auth';
import type { UsersPublicRouter } from '@template/contracts/modules/users';

/**
 * Browser clients for Auth and Users. Relative URLs also keep module evaluation safe on the server.
 *
 * The session cookie is HttpOnly: the browser attaches it and this code never sees its contents.
 *
 * Neither surface carries a CSRF token, and that is not an omission — the public surfaces are
 * protected by the session cookie's `SameSite=Lax`, and the tokens in this template belong to the
 * admin surfaces, where each module issues its own.
 */
function publicLink(prefix: string) {
  return httpLink({
    url: prefix,
    methodOverride: 'POST',
    fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  });
}

export const auth = createTRPCClient<AuthPublicRouter>({
  links: [publicLink('/module/auth/rpc')],
});

export const users = createTRPCClient<UsersPublicRouter>({
  links: [publicLink('/module/users/rpc')],
});

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
