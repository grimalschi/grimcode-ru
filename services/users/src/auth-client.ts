import type { authInternalContract, ContractRouterClient, Identity } from '@template/contracts';
import {
  createRpcClient,
  internalServiceUrl,
  parseCookies,
  REQUEST_ID_HEADER,
  sessionCookieName,
} from '@template/shared';

type AuthClient = ContractRouterClient<typeof authInternalContract>;

/**
 * Users owns no sessions and does not know the cookie's internal format. It asks Auth over the
 * internal contract on every protected call.
 *
 * A route guard in the SPA is for the user flow only — this server-side check is what actually
 * protects the data.
 */
export async function resolveIdentity(
  request: Request,
  requestId: string,
): Promise<Identity | null> {
  const token = parseCookies(request.headers.get('cookie'))[sessionCookieName()];
  if (!token) return null;

  const auth = createRpcClient<AuthClient>({
    url: `${internalServiceUrl('auth')}/internal/rpc`,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });

  const { identity } = await auth.resolveSession({ sessionToken: token });
  return identity;
}
