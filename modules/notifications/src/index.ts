import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EmailInternalCaller } from '@template/email/contract';
import {
  createServiceApp,
  mountCsrfEndpoint,
  mountSpa,
  mountTrpc,
  readAdminContext,
  RPC_TIMEOUT_MS,
  withDeadlineOn,
} from '@template/shared';

import type { NotificationsEnv } from './env.js';
import { createDatabase } from './db/database.js';
import { NotificationsRepository } from './repository.js';
import { adminRouter, createInternalCallerFactory } from './routers.js';

export type { NotificationsEnv } from './env.js';

export interface NotificationsDeps {
  /** Reaches Email's internal surface; a caller per request, so the id travels with it. */
  callEmail: (call: { requestId: string }) => EmailInternalCaller;
}

/**
 * Both shapes a composer needs — an application for the admin surface, a caller for the neighbour
 * that emits events — from one factory, so the pool is opened once between them. The caller takes
 * the environment as well as the request: a direct call has no `c.env` to read.
 */
export function createModule(deps: NotificationsDeps) {

  // The pool on the first request that needs it: `c.env` exists inside a request and nowhere else.
  const database = createDatabase();
  const repository = async (env: NotificationsEnv) =>
    new NotificationsRepository(await database(env));

  const internalCaller = (env: NotificationsEnv, call: { requestId: string }): NotificationsInternalCaller =>
    withDeadlineOn(
      createInternalCallerFactory(async () => ({
        repo: await repository(env),
        email: deps.callEmail(call),
      })),
      'notifications',
      RPC_TIMEOUT_MS,
    );

  const app = createServiceApp<NotificationsEnv>('notifications');

  mountTrpc(
    app,
    '/admin/embed/service/notifications/rpc',
    adminRouter,
    async ({ request, resHeaders, hono }) => ({
      repo: await repository(hono.env),
      request,
      resHeaders,
      admin: readAdminContext(request.headers),
    }),
  );

  mountCsrfEndpoint(app, '/admin/embed/service/notifications/csrf', 'notifications');

  mountSpa(app, {
    basePath: '/admin/embed/service/notifications',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return { app, internalCaller };
}

/** What a neighbour holds: the caller, named here so the type does not have to be inferred. */
export type NotificationsInternalCaller = ReturnType<typeof createInternalCallerFactory>;
