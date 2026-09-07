import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createServiceApp,
  mountCsrfEndpoint,
  mountSpa,
  mountTrpc,
  readAdminContext,
  type ServiceApp,
} from '@template/shared';

import type { AuthInternalCaller } from '@template/auth/contract';

import { resolveIdentity } from './auth-client.js';
import type { UsersEnv } from './env.js';
import { createDatabase } from './db/database.js';
import { UsersRepository } from './repository.js';
import { adminRouter, publicRouter } from './routers.js';

export type { UsersEnv } from './env.js';

export interface UsersDeps {
  /** Reaches Auth's internal surface; a caller per request, so the id travels with it. */
  callAuth: (call: { requestId: string }) => AuthInternalCaller;
}

export function createApp(deps: UsersDeps): ServiceApp<UsersEnv> {
  const app = createServiceApp<UsersEnv>('users');

  // The pool on the first request that needs it: `c.env` exists inside a request and nowhere else.
  const database = createDatabase();
  const repository = async (env: UsersEnv) => new UsersRepository(await database(env));

  mountTrpc(app, '/service/users/rpc', publicRouter, async ({ request, resHeaders, hono }) => ({
    repo: await repository(hono.env),
    request,
    resHeaders,
    identity: await resolveIdentity(request, deps.callAuth({ requestId: hono.get('requestId') })),
  }));

  mountTrpc(
    app,
    '/admin/embed/service/users/rpc',
    adminRouter,
    async ({ request, resHeaders, hono }) => ({
      repo: await repository(hono.env),
      request,
      resHeaders,
      auth: deps.callAuth({ requestId: hono.get('requestId') }),
      admin: readAdminContext(request.headers),
    }),
  );

  mountCsrfEndpoint(app, '/admin/embed/service/users/csrf', 'users');

  mountSpa(app, {
    basePath: '/admin/embed/service/users',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
  });

  return app;
}
