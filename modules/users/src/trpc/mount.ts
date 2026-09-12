import type { AnyTRPCRouter } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import type { Env, Hono } from 'hono';

import type { RpcContext } from './context.js';

/**
 * Mounts this surface's HTTP router. Procedures append cookies to the fetch adapter's response headers.
 * The browser clients send queries as POST to keep input out of URLs.
 */
export function mountTrpc<E extends Env, TContext extends RpcContext>(
  app: Hono<E>,
  prefix: `/${string}`,
  router: AnyTRPCRouter,
  createContext: (ctx: RpcContext & { env: E['Bindings'] }) => TContext | Promise<TContext>,
): void {
  app.use(`${prefix}/*`, (c) =>
    fetchRequestHandler({
      endpoint: prefix,
      req: c.req.raw,
      router,
      allowMethodOverride: true,
      createContext: ({ resHeaders }) =>
        createContext({
          request: c.req.raw,
          env: c.env,
          resHeaders,
        }),
      // Keep server failures visible without logging procedure input, which may contain passwords.
      onError: ({ error, path, type }) => {
        console.error(
          `procedure failed: ${path ?? 'unknown'} (${type}, ${error.code})`,
          error.cause ?? error,
        );
      },
    }),
  );
}
