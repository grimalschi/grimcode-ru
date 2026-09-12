import type { AdminContext } from '@template/contracts/module-instance';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

import type { HttpDependencies } from '../dependencies.js';
import type { AuthEnv } from '../env.js';
import { mountCsrfEndpoint, mountSpa } from '../http/spa.js';
import { mountTrpc } from '../trpc/mount.js';
import { adminRouter } from './router.js';

/** Administrative HTTP surface, including its own UI, CSRF endpoint and verified context. */
export function createAdminFetch({ env, repository, notifier }: HttpDependencies) {
  const app = new Hono<{ Bindings: Required<AuthEnv> & { adminContext: AdminContext } }>();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'auth' }));
  mountTrpc(app, '/admin/embed/module/auth/rpc', adminRouter, async ({ request, resHeaders, env }) => ({
    repo: await repository(),
    notifier,
    request,
    resHeaders,
    env,
    adminContext: env.adminContext,
  }));
  mountCsrfEndpoint(app, '/admin/embed/module/auth/csrf');
  mountSpa(app, {
    basePath: '/admin/embed/module/auth',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  });
  return (request: Request, adminContext: AdminContext) => app.fetch(request, { ...env, adminContext });
}
