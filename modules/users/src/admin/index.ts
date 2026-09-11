import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

import type { HttpDependencies } from '../dependencies.js';
import { readAdminContext } from '../http/admin-context.js';
import { mountSpa } from '../http/spa.js';
import { mountTrpc } from '../trpc/mount.js';
import { adminRouter } from './router.js';

/** Administrative profile list, assets and context checks have their own HTTP application. */
export function createAdminFetch({ repository, auth }: HttpDependencies) {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'users' }));
  mountTrpc(app, '/admin/embed/module/users/rpc', adminRouter, async ({ request, resHeaders }) => ({
    repo: await repository(),
    request,
    resHeaders,
    auth,
    admin: readAdminContext(request.headers),
  }));
  mountSpa(app, {
    basePath: '/admin/embed/module/users',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  });
  return (request: Request) => app.fetch(request);
}
