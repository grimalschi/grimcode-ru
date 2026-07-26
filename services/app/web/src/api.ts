import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import type { authContract, usersContract } from '@template/contracts';

/**
 * Clients for the two services the application talks to.
 *
 * The session cookie is HttpOnly: the browser attaches it and this code never sees its contents.
 * The application does not know the cookie's internal format and never tries to read it.
 */
function link(prefix: string) {
  return new RPCLink({
    url: `${window.location.origin}${prefix}`,
    fetch: (request, init) => fetch(request, { ...init, credentials: 'same-origin' }),
  });
}

export const auth: ContractRouterClient<(typeof authContract)['public']> = createORPCClient(
  link('/service/auth/rpc'),
);

export const users: ContractRouterClient<(typeof usersContract)['public']> = createORPCClient(
  link('/service/users/rpc'),
);

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
