import type {
  adminInternalContract,
  AuthorizationResult,
  ContractRouterClient,
} from '@template/contracts';
import {
  createRpcClient,
  internalServiceUrl,
  parseCookies,
  REQUEST_ID_HEADER,
  ServiceUnavailableError,
  sessionCookieName,
} from '@template/shared';

import type { AdminServiceName } from './registry.js';

type AdminInternalClient = ContractRouterClient<typeof adminInternalContract>;

/**
 * The whole admin check is one internal Admin method.
 *
 * Gateway computes nothing itself, keeps no copy of the rights and caches no result, which is why
 * a changed grant takes effect on the very next request.
 */
export async function authorizeAdminRequest(
  request: Request,
  service: AdminServiceName | null,
  requestId: string,
): Promise<AuthorizationResult> {
  const sessionToken = parseCookies(request.headers.get('cookie'))[sessionCookieName()] ?? null;

  const client: AdminInternalClient = createRpcClient({
    url: `${internalServiceUrl('admin')}/internal/rpc`,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });

  try {
    return await client.authorize({ sessionToken, service });
  } catch (error) {
    // Admin being unreachable — or Auth being unreachable behind it — is an infrastructure
    // failure. Reporting it as "no rights" would hide an outage, so it fails closed instead.
    throw new ServiceUnavailableError('admin', error);
  }
}
