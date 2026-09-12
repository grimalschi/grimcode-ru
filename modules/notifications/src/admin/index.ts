import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { NotificationsEnv } from '../env.js';
import type { NotificationsRepository } from '../repository.js';
import type { AdminContext } from '@template/contracts/module-instance';
import { mountSpa } from '../http/spa.js';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { adminRouter } from './router.js';

/** Read-only event screens have no dependency on the internal event router or Email caller. */
export function createAdminFetch(options: {
  env: NotificationsEnv;
  repository: () => Promise<NotificationsRepository>;
}) {
  const { env, repository } = options;
  const app = new Hono<{ Bindings: NotificationsEnv & { adminContext: AdminContext } }>();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'notifications' }));
  app.use('/admin/embed/module/notifications/rpc/*', (c) =>
    fetchRequestHandler({
      endpoint: '/admin/embed/module/notifications/rpc',
      req: c.req.raw,
      router: adminRouter,
      // Browser queries use POST so their input stays out of URLs.
      allowMethodOverride: true,
      createContext: async () => ({
        repo: await repository(),
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
  mountSpa(app, {
    basePath: '/admin/embed/module/notifications',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  });
  return (request: Request, adminContext: AdminContext) => app.fetch(request, { ...env, adminContext });
}
