import type { AnyRouter } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import type { Context as HonoContext } from 'hono';

import type { ServiceApp } from '../http/service-app.js';

export interface RpcRequestContext {
  request: Request;
  /**
   * Headers a procedure may add to the response, for example `set-cookie` when Auth opens or
   * closes a session. The mount merges them into the produced response.
   */
  resHeaders: Headers;
  hono: HonoContext;
}

/**
 * Mounts an oRPC router on an exact path prefix of a service app.
 *
 * Each service keeps three separate mounts so the trust boundary stays visible in the routing
 * table itself:
 *
 * - `/service/<name>/rpc` — public, secured by the service itself;
 * - `/admin/embed/service/<name>/rpc` — reachable only after Gateway verified the admin grant;
 * - `/internal/rpc` — never proxied by Gateway, so it stays inside the Docker network.
 */
export function mountRpc<TContext extends Record<string, unknown>>(
  app: ServiceApp,
  prefix: `/${string}`,
  router: AnyRouter,
  createContext: (ctx: RpcRequestContext) => TContext | Promise<TContext>,
): void {
  const handler: RPCHandler<TContext> = new RPCHandler(router);

  app.use(`${prefix}/*`, async (c, next) => {
    const resHeaders = new Headers();
    const context = await createContext({ request: c.req.raw, resHeaders, hono: c });

    const { matched, response } = await handler.handle(c.req.raw, { prefix, context });
    if (!matched) return next();

    const headers = new Headers(response.headers);
    resHeaders.forEach((value, key) => headers.append(key, value));
    return new Response(response.body, { status: response.status, headers });
  });
}
