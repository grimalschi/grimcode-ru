import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import type { NotificationsRepository } from '../repository.js';
import { readAdminContext } from '../http/admin-context.js';
import { mountSpa } from '../http/spa.js';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { adminRouter } from './router.js';

/** Read-only event screens have no dependency on the internal event router or Email caller. */
export function createAdminFetch(options: {
  repository: () => Promise<NotificationsRepository>;
}) {
  const { repository } = options;
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'notifications' }));
  app.use('/admin/embed/module/notifications/rpc/*', (c) =>
    fetchRequestHandler({
      endpoint: '/admin/embed/module/notifications/rpc',
      req: c.req.raw,
      router: adminRouter,
      // Browser queries use POST so their input stays out of URLs.
      allowMethodOverride: true,
      createContext: async ({ req }) => ({
        repo: await repository(),
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
  mountSpa(app, {
    basePath: '/admin/embed/module/notifications',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  });
  return (request: Request) => app.fetch(request);
}
