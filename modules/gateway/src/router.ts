import type { AdminInternalCaller } from '@template/admin/contract';
import type { AdminContext, AdminTarget } from '@template/shared/vocabulary';
import { ServiceUnavailableError } from '@template/shared';

import { authorizeAdminRequest } from './authorize.js';
import { proxyRequest } from './proxy.js';
import { isAdminService, isPublicService, type GatewayTargets } from './registry.js';
import {
  awaitingFirstUser,
  badGateway,
  forbidden,
  notFound,
  serviceUnavailable,
} from './responses.js';

/**
 * The whole external routing policy of the template.
 *
 * | Incoming path                    | Target                        | Gateway check                        |
 * | -------------------------------- | ----------------------------- | ------------------------------------ |
 * | `/admin/embed/service/:name/**`  | admin panel of that module    | session, role and grant on `:name`   |
 * | `/admin/embed/database/**`       | the panel's database interface | session and the `owner` role         |
 * | `/admin/**`                      | admin                         | session and an admin role            |
 * | `/service/:name/**`              | module from the public list   | none — the module secures itself     |
 * | `/app/**`                        | app                           | none — App checks the user session   |
 * | everything else                  | site                          | none — public                        |
 *
 * Nothing rewrites the path, and `:name` is only ever looked up in an explicit allowlist. The
 * modules sharing one process changed who answers, not who decides: Gateway is still the only thing
 * mounted on the public listener, and this table still says where a request goes next.
 */
export async function routeRequest(
  request: Request,
  requestId: string,
  targets: GatewayTargets,
  callAdmin: (call: { requestId: string }) => AdminInternalCaller,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  try {
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      return await routeAdmin(request, pathname, requestId, targets, callAdmin);
    }

    if (pathname === '/service' || pathname.startsWith('/service/')) {
      return await routePublicService(request, pathname, requestId, targets);
    }

    if (pathname === '/app' || pathname.startsWith('/app/')) {
      return await proxyRequest(request, { target: targets.app, requestId });
    }

    return await proxyRequest(request, { target: targets.site, requestId });
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      return serviceUnavailable(request);
    }
    return badGateway(request);
  }
}

/**
 * Every `/admin/**` request — HTML, API and assets alike — passes the same check. There is no
 * separate public policy for admin assets.
 */
async function routeAdmin(
  request: Request,
  pathname: string,
  requestId: string,
  targets: GatewayTargets,
  callAdmin: (call: { requestId: string }) => AdminInternalCaller,
): Promise<Response> {
  const target = adminTargetOf(pathname);

  // An unknown module name never becomes a target and Admin is never asked about it.
  if (target === null) return notFound(request);

  // Built here, not at the entrance: Gateway sees every request, and a page of the site needs no
  // caller into Admin.
  const result = await authorizeAdminRequest(request, target, callAdmin({ requestId }));

  if (result.state === 'awaiting-first-user') return awaitingFirstUser(request);
  if (result.state === 'denied') return forbidden(request);

  const adminContext: AdminContext = {
    userId: result.userId,
    email: result.email,
    role: result.role,
    requestId,
  };

  const destination =
    target.area === 'panel'
      ? targets.admin
      : target.area === 'database'
        ? targets.database
        : targets[target.service];

  return proxyRequest(request, { target: destination, requestId, adminContext });
}

async function routePublicService(
  request: Request,
  pathname: string,
  requestId: string,
  targets: GatewayTargets,
): Promise<Response> {
  const segments = pathname.split('/').filter(Boolean);
  const name = segments[1];

  if (name === undefined || !isPublicService(name)) return notFound(request);

  return proxyRequest(request, { target: targets[name], requestId });
}

/**
 * Which part of the admin panel a path is asking for, or `null` when it names nothing real.
 *
 * Everything the panel embeds lives under `/admin/embed/`, and everything else under `/admin` is the
 * panel itself — so its own pages are ordinary paths that can never collide with an embedded one.
 */
function adminTargetOf(pathname: string): AdminTarget | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[1] !== 'embed') return { area: 'panel' };

  if (segments[2] === 'database') return { area: 'database' };

  if (segments[2] === 'service') {
    const name = segments[3] ?? '';
    return isAdminService(name) ? { area: 'service', service: name } : null;
  }

  return null;
}
