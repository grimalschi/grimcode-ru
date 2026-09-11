import { Hono } from 'hono';

import { resolveIdentity } from '../auth-client.js';
import type { HttpDependencies } from '../dependencies.js';
import { mountTrpc } from '../trpc/mount.js';
import { publicRouter } from './router.js';

/** Profile HTTP API; its session check and router are independent of the administrative surface. */
export function createPublicFetch({ env, repository, auth }: HttpDependencies) {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'users' }));
  mountTrpc(app, '/module/users/rpc', publicRouter, async ({ request, resHeaders }) => ({
    repo: await repository(),
    request,
    resHeaders,
    identity: await resolveIdentity(
      request,
      auth,
      env.sessionCookieName,
    ),
  }));
  return (request: Request) => app.fetch(request);
}
