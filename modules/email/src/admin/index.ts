import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { EmailEnv } from '../env.js';
import type { ModuleContext } from '../context.js';
import { readAdminContext } from '../http/admin-context.js';
import { mountCsrfEndpoint, mountSpa } from '../http/spa.js';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { adminRouter } from './router.js';

/** The editor, delivery log and their HTTP guards are assembled together here. */
export function createAdminFetch(options: {
  env: EmailEnv;
  context: () => Promise<ModuleContext>;
}) {
  const { env, context } = options;
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'email' }));
  app.use('/admin/embed/module/email/rpc/*', (c) =>
    fetchRequestHandler({
      endpoint: '/admin/embed/module/email/rpc',
      req: c.req.raw,
      router: adminRouter,
      // Browser queries use POST so their input stays out of URLs.
      allowMethodOverride: true,
      createContext: async ({ req }) => ({
        ...(await context()),
        env,
        request: req,
        admin: readAdminContext(req.headers),
      }),
      onError: ({ error, path, type }) => {
        console.error(
          `procedure failed: ${path ?? 'unknown'} (${type}, ${error.code})`,
          error.cause ?? error,
        );
      },
    }),
  );
  mountCsrfEndpoint(app, '/admin/embed/module/email/csrf', env.csrfCookieName);
  mountSpa(app, {
    basePath: '/admin/embed/module/email',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  });
  return (request: Request) => app.fetch(request);
}
