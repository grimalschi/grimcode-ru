import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import type { AdminEnv } from '../env.js';
import type { ModuleContext } from '../context.js';
import type { AdminContext } from '@template/contracts/module-instance';
import { mountSpa } from '../http/spa.js';
import { issueCsrfToken } from '../http/csrf.js';
import { adminRouter } from './router.js';

/** Builds only the central panel's HTTP surface. It never imports the internal router. */
export function createAdminFetch({ env, context }: {
  env: AdminEnv;
  context: () => Promise<ModuleContext>;
}) {
  const app = new Hono<{ Bindings: AdminEnv & { adminContext: AdminContext } }>();
  // Router dispatches embedded modules to their own HTTP handlers.
  app.all('/admin/embed/*', (c) => c.notFound());
  app.get('/healthz', (c) => c.json({ ok: true, module: 'admin' }));
  app.use('/admin/rpc/*', (c) => fetchRequestHandler({
    endpoint: '/admin/rpc',
    req: c.req.raw,
    router: adminRouter,
    allowMethodOverride: true,
    createContext: async ({ req, resHeaders }) => ({
      ...await context(),
      env: c.env,
      request: req,
      resHeaders,
      adminContext: c.env.adminContext,
    }),
    // Report failures without logging procedure input, which may contain credentials.
    onError: ({ error, path, type }) => {
      console.error(`procedure failed: ${path ?? 'unknown'} (${type}, ${error.code})`, error.cause ?? error);
    },
  }));
  app.get('/admin/csrf', (c) => {
    const { token, cookie } = issueCsrfToken(c.env.csrfCookieName, c.req.raw.headers);
    c.header('set-cookie', cookie);
    c.header('cache-control', 'no-store');
    return c.json({ token });
  });
  mountSpa(app, {
    basePath: '/admin',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  });
  return (request: Request, adminContext: AdminContext) => app.fetch(request, { ...env, adminContext });
}
