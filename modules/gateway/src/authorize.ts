import type { AdminInternalCaller } from '@template/admin/contract';
import type { AuthorizationResult } from '@template/admin/contract';
import type { AdminTarget } from '@template/shared/vocabulary';
import { parseCookies, ServiceUnavailableError, sessionCookieName } from '@template/shared';


/**
 * The whole admin check is one internal Admin method.
 *
 * Gateway computes nothing itself and caches no result, which is why a changed grant takes effect on
 * the very next request. It is also the call that most needs the deadline Admin puts on its own
 * caller: nothing else bounds the wait, and the fail-closed branch below would never be reached.
 */
export async function authorizeAdminRequest(
  request: Request,
  target: AdminTarget,
  admin: AdminInternalCaller,
): Promise<AuthorizationResult> {
  const sessionToken = parseCookies(request.headers.get('cookie'))[sessionCookieName()] ?? null;

  try {
    return await admin.authorize({ sessionToken, target });
  } catch (error) {
    // Admin being unreachable — or Auth being unreachable behind it — is an infrastructure
    // failure. Reporting it as "no rights" would hide an outage, so it fails closed instead.
    throw new ServiceUnavailableError('admin', error);
  }
}
