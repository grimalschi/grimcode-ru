import type { AnyTRPCRouter } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import type { Context as HonoContext } from 'hono';

import type { ServiceApp, ServiceAppVariables, ServiceEnv } from '../http/service-app.js';
import type { RpcContext } from './builders.js';

export interface TrpcRequestContext<TEnv extends ServiceEnv = object> {
  request: Request;
  resHeaders: Headers;
  hono: HonoContext<{ Bindings: TEnv; Variables: ServiceAppVariables }>;
}

/**
 * Mounts a tRPC router on an exact path prefix.
 *
 * Each module keeps its surfaces on separate mounts, so the trust boundary is visible in the routing
 * table itself: `/service/<name>/rpc` is public, `/admin/embed/service/<name>/rpc` needs the admin
 * grant, and Gateway routes nothing at all to `/internal/rpc`.
 *
 * **`resHeaders` is merged by hand, and that is a choice rather than a necessity.** The fetch adapter
 * keeps a `Headers` of its own, hands it to `createContext` beside `req` and returns it as the
 * response headers — taking it from there instead would make the merge below unnecessary. This mount
 * carries its own object so that what a procedure receives is decided here and not by the adapter's
 * option shape. Either way the merge is load-bearing while it exists: removed, signing in stops
 * setting the session cookie, and the acceptance suite fails on its first call with a 403.
 *
 * **`allowMethodOverride` lets a query arrive as POST.** Without it a query sent by POST answers
 * 405, and staying on POST keeps request bodies out of URLs — off the length limit, and out of the
 * caches a GET invites, since tRPC sets no `Cache-Control` of its own.
 */
export function mountTrpc<TContext extends RpcContext, TEnv extends ServiceEnv = object>(
  app: ServiceApp<TEnv>,
  prefix: `/${string}`,
  router: AnyTRPCRouter,
  createContext: (ctx: TrpcRequestContext<TEnv>) => TContext | Promise<TContext>,
): void {
  app.use(`${prefix}/*`, async (c) => {
    const resHeaders = new Headers();

    const response = await fetchRequestHandler({
      endpoint: prefix,
      req: c.req.raw,
      router,
      allowMethodOverride: true,
      createContext: () =>
        createContext({
          request: c.req.raw,
          resHeaders,
          hono: c as HonoContext<{ Bindings: TEnv; Variables: ServiceAppVariables }>,
        }),
      /*
       * Without this a procedure that throws answers 500 and the reason stays inside the adapter —
       * in a deployment the response carries no stack either, so it would be lost entirely. The one
       * line left of the logging this project used to do, and deliberately: `input` never appears in
       * it, because `register` and `login` carry passwords through here.
       */
      onError: ({ error, path, type }) => {
        console.error(
          `procedure failed: ${path ?? 'unknown'} (${type}, ${error.code})`,
          error.cause ?? error,
        );
      },
    });

    if (resHeaders.entries().next().done === true) return response;

    const headers = new Headers(response.headers);
    resHeaders.forEach((value, key) => headers.append(key, value));
    return new Response(response.body, { status: response.status, headers });
  });
}
