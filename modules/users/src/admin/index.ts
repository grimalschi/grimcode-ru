import type { AdminContext } from '@template/contracts/module-instance';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

import type { HttpDependencies } from '../dependencies.js';
import type { UsersEnv } from '../env.js';
import { mountCsrfEndpoint, mountSpa } from '../http/spa.js';
import { mountTrpc } from '../trpc/mount.js';
import { adminRouter } from './router.js';

/** Administrative profile list, assets, CSRF endpoint and context checks have their own HTTP application. */
export function createAdminFetch({ env, repository, auth }: HttpDependencies) {
  const app = new Hono<{ Bindings: UsersEnv & { adminContext: AdminContext } }>();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'users' }));
  mountTrpc(app, '/admin/embed/module/users/rpc', adminRouter, async ({ request, resHeaders, env }) => ({
    repo: await repository(),
    request,
    resHeaders,
    env,
    auth,
    adminContext: env.adminContext,
  }));
  mountCsrfEndpoint(app, '/admin/embed/module/users/csrf');
  mountSpa(app, {
    basePath: '/admin/embed/module/users',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  });
  return (request: Request, adminContext: AdminContext) => app.fetch(request, { ...env, adminContext });
}
