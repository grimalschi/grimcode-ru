import type { AdminContext, AdminTarget, AuthorizationResult } from '@template/contracts/modules/admin';

import { parseCookies } from './http/cookies.js';
import { proxyRequest } from './proxy.js';
import { hasModule, type RouterOptions } from './registry.js';
import {
  awaitingFirstUser,
  badGateway,
  forbidden,
  notFound,
  moduleUnavailable,
} from './responses.js';

/**
 * The whole external routing policy of the template.
 *
 * | Incoming path                    | Target                        | Router check                        |
 * | -------------------------------- | ----------------------------- | ------------------------------------ |
 * | `/admin/embed/module/:name/**`  | admin panel of that module    | session, role and grant on `:name`   |
 * | `/admin/**`                      | admin                         | session and an admin role            |
 * | `/module/:name/**`              | module from the public list   | none — the module secures itself     |
 * | `/app/**`                        | app                           | none — App checks the user session   |
 * | everything else                  | site                          | none — public                        |
 *
 * The path is preserved, and `:name` is looked up only in the configured handler maps.
 */
export async function routeRequest(
  request: Request,
  options: RouterOptions,
): Promise<Response> {
  const { pathname } = new URL(request.url);

  try {
    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      return await routeAdmin(request, pathname, options);
    }

    if (pathname === '/module' || pathname.startsWith('/module/')) {
      return await routePublicModule(request, pathname, options.publicFetches);
    }

    if (pathname === '/app' || pathname.startsWith('/app/')) {
      return await proxyRequest(request, { target: options.publicFetches.app });
    }

    return await proxyRequest(request, { target: options.publicFetches.site });
  } catch {
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
  { env, modules, adminFetches }: RouterOptions,
): Promise<Response> {
  const target = adminTargetOf(pathname, adminFetches);

  // An unknown module name never becomes a target and Admin is never asked about it.
  if (target === null) return notFound(request);

  // Only administrative requests ask Admin for a decision; the API object holds no session state.
  const sessionToken = parseCookies(request.headers.get('cookie'))[env.sessionCookieName] ?? null;
  let result: AuthorizationResult;
  try {
    result = await modules.admin.authorize({ sessionToken, target });
  } catch {
    // A failed authorization check is unavailable, not a denial or a target failure.
    return moduleUnavailable(request);
  }

  if (result.state === 'awaiting-first-user') return awaitingFirstUser(request);
  if (result.state === 'denied') return forbidden(request, env.publicOrigin);

  const adminContext: AdminContext = {
    userId: result.userId,
    email: result.email,
    role: result.role,
  };

  const destination = target.area === 'panel' ? adminFetches.admin : adminFetches[target.module]!;

  return proxyRequest(request, { target: destination, adminContext });
}

async function routePublicModule(
  request: Request,
  pathname: string,
  publicFetches: RouterOptions['publicFetches'],
): Promise<Response> {
  const segments = pathname.split('/').filter(Boolean);
  const name = segments[1];

  if (name === undefined || !hasModule(publicFetches, name)) return notFound(request);

  return proxyRequest(request, { target: publicFetches[name]! });
}

/**
 * Which part of the admin panel a path is asking for, or `null` when it names nothing real.
 *
 * Everything the panel embeds lives under `/admin/embed/`, and everything else under `/admin` is the
 * panel itself — so its own pages are ordinary paths that can never collide with an embedded one.
 */
function adminTargetOf(pathname: string, adminFetches: RouterOptions['adminFetches']): AdminTarget | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[1] !== 'embed') return { area: 'panel' };

  if (segments[2] === 'module') {
    const name = segments[3] ?? '';
    return hasModule(adminFetches, name) ? { area: 'module', module: name } : null;
  }

  return null;
}
