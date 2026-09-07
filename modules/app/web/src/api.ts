import { createTRPCClient, httpLink, type TRPCClient } from '@trpc/client';

import type { AuthPublicRouter } from '@template/auth/contract';
import type { UsersPublicRouter } from '@template/users/contract';

/**
 * Clients for the two modules the application talks to.
 *
 * The session cookie is HttpOnly: the browser attaches it and this code never sees its contents.
 *
 * Neither surface carries a CSRF token, and that is not an omission — the public surfaces are
 * protected by the session cookie's `SameSite=Lax`, and the tokens in this template belong to the
 * admin surfaces, where each module issues its own.
 */
function publicLink(prefix: string) {
  return httpLink({
    url: `${window.location.origin}${prefix}`,
    methodOverride: 'POST',
    fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' }),
  });
}

export const auth: TRPCClient<AuthPublicRouter> = createTRPCClient<AuthPublicRouter>({
  links: [publicLink('/service/auth/rpc')],
});

export const users: TRPCClient<UsersPublicRouter> = createTRPCClient<UsersPublicRouter>({
  links: [publicLink('/service/users/rpc')],
});

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
