import type { AdminContext, AdminTarget } from '@template/contracts';
import { internalServiceUrl, ServiceUnavailableError, type Logger } from '@template/shared';

import { authorizeAdminRequest } from './authorize.js';
import { proxyRequest } from './proxy.js';
import {
  adminServiceUrl,
  databaseBrowserUrl,
  isAdminService,
  isPublicService,
  publicServiceUrl,
} from './registry.js';
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
 * | Incoming path              | Target                        | Gateway check                        |
 * | -------------------------- | ----------------------------- | ------------------------------------ |
 * | `/admin/embed/services/:name/**`  | admin panel of that service   | session, role and grant on `:name`   |
 * | `/admin/**`                | admin                         | session and an admin role            |
 * | `/service/:name/**`        | service from the public list  | none — the service secures itself    |
 * | `/app/**`                  | app                           | none — App checks the user session   |
 * | everything else            | site                          | none — public                        |
 *
 * Nothing rewrites the path, and `:name` is only ever looked up in an explicit allowlist.
 */
export async function routeRequest(
  request: Request,
  requestId: string,
  logger: Logger,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  try {
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      return await routeAdmin(request, pathname, requestId);
    }

    if (pathname === '/service' || pathname.startsWith('/service/')) {
      return await routePublicService(request, pathname, requestId);
    }

    if (pathname === '/app' || pathname.startsWith('/app/')) {
      return await proxyRequest(request, {
        targetBaseUrl: internalServiceUrl('app'),
        requestId,
      });
    }

    return await proxyRequest(request, {
      targetBaseUrl: internalServiceUrl('site'),
      requestId,
    });
  } catch (error) {
    if (error instanceof ServiceUnavailableError) {
      logger.error('authorization dependency unavailable', {
        dependency: error.service,
        reason: error.reason,
      });
      return serviceUnavailable(request);
    }
    logger.error('upstream request failed', { path: pathname, error });
    return badGateway(request);
  }
}

/**
 * Every `/admin/**` request — HTML, API and assets alike — passes the same check. There is no
 * separate public policy for admin assets.
 */
async function routeAdmin(request: Request, pathname: string, requestId: string): Promise<Response> {
  const target = adminTargetOf(pathname);

  // An unknown service name never becomes a hostname and Admin is never asked about it.
  if (target === null) return notFound(request);

  const result = await authorizeAdminRequest(request, target, requestId);

  if (result.state === 'awaiting-first-user') return awaitingFirstUser(request);
  if (result.state === 'denied') return forbidden(request);

  const adminContext: AdminContext = {
    userId: result.userId,
    email: result.email,
    role: result.role,
    requestId,
  };

  const targetBaseUrl =
    target.area === 'panel'
      ? internalServiceUrl('admin')
      : target.area === 'database'
        ? databaseBrowserUrl()
        : adminServiceUrl(target.service);

  return proxyRequest(request, { targetBaseUrl, requestId, adminContext });
}

async function routePublicService(
  request: Request,
  pathname: string,
  requestId: string,
): Promise<Response> {
  const segments = pathname.split('/').filter(Boolean);
  const name = segments[1];

  if (name === undefined || !isPublicService(name)) return notFound(request);

  return proxyRequest(request, { targetBaseUrl: publicServiceUrl(name), requestId });
}

/**
 * Which part of the admin panel a path is asking for, or `null` when it names nothing real.
 *
 * Everything the panel embeds lives under `/admin/embed/`: `/admin/embed/services/:name/**` is one
 * service's admin, `/admin/embed/database/**` is the database browser. Everything else under
 * `/admin` is the panel itself, so its own pages are ordinary paths that can never collide with an
 * embedded application.
 */
function adminTargetOf(pathname: string): AdminTarget | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[1] !== 'embed') return { area: 'panel' };

  if (segments[2] === 'database') return { area: 'database' };

  if (segments[2] === 'services') {
    const name = segments[3] ?? '';
    return isAdminService(name) ? { area: 'service', service: name } : null;
  }

  return null;
}
