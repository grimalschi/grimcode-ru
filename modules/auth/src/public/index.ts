import { Hono } from 'hono';

import type { HttpDependencies } from '../dependencies.js';
import type { AuthEnv } from '../env.js';
import { createRateLimiter } from '../rate-limit.js';
import { mountTrpc } from '../trpc/mount.js';
import { publicRouter } from './router.js';

const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/** Public authentication HTTP surface; no administrative routes or middleware are loaded here. */
export function createPublicFetch({ env, repository, notifier }: HttpDependencies) {
  const app = new Hono<{ Bindings: Required<AuthEnv> }>();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'auth' }));

  const loginAttempts = createRateLimiter({ limit: LOGIN_ATTEMPT_LIMIT, windowMs: LOGIN_ATTEMPT_WINDOW_MS });
  mountTrpc(app, '/module/auth/rpc', publicRouter, async ({ request, resHeaders, env }) => ({
    repo: await repository(),
    notifier,
    request,
    resHeaders,
    env,
    loginAttempts,
  }));

  return (request: Request) => app.fetch(request, env);
}
