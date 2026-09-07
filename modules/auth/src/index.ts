import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRateLimiter,
  createServiceApp,
  mountCsrfEndpoint,
  mountSpa,
  mountTrpc,
  readAdminContext,
  RPC_TIMEOUT_MS,
  withDeadlineOn,
} from '@template/shared';

import type { NotificationsInternalCaller } from '@template/notifications/contract';

import type { AuthEnv } from './env.js';
import { createDatabase } from './db/database.js';
import { Notifier } from './notifier.js';
import { AuthRepository } from './repository.js';
import { adminRouter } from './routers/admin.js';
import { createInternalCallerFactory } from './routers/internal.js';
import { publicRouter } from './routers/public.js';

export type { AuthEnv } from './env.js';

export interface AuthDeps {
  /** Reaches Notifications' internal surface; a caller per request, so the id travels with it. */
  callNotifications: (call: { requestId: string }) => NotificationsInternalCaller;
}

// Constants rather than settings: a defence that can be configured can be weakened silently.
const LOGIN_ATTEMPT_LIMIT = 10;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Both shapes a composer needs — an application for what Gateway routes here, a caller for the
 * neighbours — from one factory. Two mounts, one per trust boundary: Gateway routes
 * `/service/auth/**` and `/admin/embed/service/auth/**` here, and the internal procedures answer no
 * path at all — a neighbour reaches them through the caller.
 */
export function createModule(deps: AuthDeps) {
  const app = createServiceApp<AuthEnv>('auth');

  // Lazy because `c.env` exists inside a request and nowhere else; the repository over it is a field
  // assignment, so building one per request costs nothing.
  const database = createDatabase();
  const repository = async (env: AuthEnv) => new AuthRepository(await database(env));

  // One per application: the windows live in memory, and a second limiter would count in its own.
  const loginAttempts = createRateLimiter({
    limit: LOGIN_ATTEMPT_LIMIT,
    windowMs: LOGIN_ATTEMPT_WINDOW_MS,
  });

  /*
   * The request the call belongs to is taken and not used: nothing on this surface reports anything
   * of its own, so the id has nowhere to travel. The environment is used — a direct call has no
   * `c.env`, so the composer hands it over.
   */
  const internalCaller = (env: AuthEnv, _call: { requestId: string }): AuthInternalCaller =>
    withDeadlineOn(
      createInternalCallerFactory(async () => ({ repo: await repository(env) })),
      'auth',
      RPC_TIMEOUT_MS,
    );

  const notifier = (requestIdOf: () => string) => new Notifier(requestIdOf, deps.callNotifications);

  mountTrpc(app, '/service/auth/rpc', publicRouter, async ({ request, resHeaders, hono }) => ({
    repo: await repository(hono.env),
    notifier: notifier(() => hono.get('requestId')),
    request,
    resHeaders,
    env: hono.env,
    loginAttempts,
  }));

  mountTrpc(
    app,
    '/admin/embed/service/auth/rpc',
    adminRouter,
    async ({ request, resHeaders, hono }) => ({
      repo: await repository(hono.env),
      notifier: notifier(() => hono.get('requestId')),
      request,
      resHeaders,
      // Written by Gateway only after Admin allowed the request; a client can never forge it.
      admin: readAdminContext(request.headers),
    }),
  );

  mountCsrfEndpoint(app, '/admin/embed/service/auth/csrf', 'auth');

  mountSpa(app, {
    basePath: '/admin/embed/service/auth',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return { app, internalCaller };
}

/** What a neighbour holds: the caller, named here so the type does not have to be inferred. */
export type AuthInternalCaller = ReturnType<typeof createInternalCallerFactory>;
