import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

import type { HttpDependencies } from '../dependencies.js';
import { readAdminContext } from '../http/admin-context.js';
import { mountCsrfEndpoint, mountSpa } from '../http/spa.js';
import { mountTrpc } from '../trpc/mount.js';
import { adminRouter } from './router.js';

/** Administrative HTTP surface, including its own UI, CSRF endpoint and verified context. */
export function createAdminFetch({ env, repository, notifier }: HttpDependencies) {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'auth' }));
  mountTrpc(app, '/admin/embed/module/auth/rpc', adminRouter, async ({ request, resHeaders }) => ({
    repo: await repository(),
    notifier,
    request,
    resHeaders,
    env,
    admin: readAdminContext(request.headers),
  }));
  mountCsrfEndpoint(app, '/admin/embed/module/auth/csrf', env.csrfCookieName);
  mountSpa(app, {
    basePath: '/admin/embed/module/auth',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  });
  return (request: Request) => app.fetch(request);
}
