import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { EmailEnv } from '../env.js';
import type { ModuleContext } from '../context.js';
import type { AdminContext } from '@template/contracts/module-instance';
import { mountCsrfEndpoint, mountSpa } from '../http/spa.js';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { adminRouter } from './router.js';

/** The editor, delivery log and their HTTP guards are assembled together here. */
export function createAdminFetch(options: {
  env: EmailEnv;
  context: () => Promise<ModuleContext>;
}) {
  const { env, context } = options;
  const app = new Hono<{ Bindings: EmailEnv & { adminContext: AdminContext } }>();
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
        env: c.env,
        request: req,
        adminContext: c.env.adminContext,
      }),
      onError: ({ error, path, type }) => {
        console.error(
          `procedure failed: ${path ?? 'unknown'} (${type}, ${error.code})`,
          error.cause ?? error,
        );
      },
    }),
  );
  mountCsrfEndpoint(app, '/admin/embed/module/email/csrf');
  mountSpa(app, {
    basePath: '/admin/embed/module/email',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  });
  return (request: Request, adminContext: AdminContext) => app.fetch(request, { ...env, adminContext });
}
