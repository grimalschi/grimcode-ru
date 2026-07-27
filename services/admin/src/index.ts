import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createLogger,
  createPool,
  createServiceApp,
  mountCsrfEndpoint,
  mountRpc,
  mountSpa,
  readAdminContext,
  runMigrations,
  serveService,
  waitForDatabase,
} from '@template/shared';

import { migrations } from './db/migrations.js';
import { AdminRepository } from './repository.js';
import { adminRouter, createAuthClient, internalRouter } from './routers.js';

const logger = createLogger('admin');
const pool = createPool('admin');
const repo = new AdminRepository(pool);

await waitForDatabase(pool);
await runMigrations(pool, migrations, logger);

const app = createServiceApp('admin', logger);

/**
 * The single authorization method Gateway calls on every `/admin/**` request. It is mounted on the
 * internal path only, so no browser can reach it.
 */
mountRpc(app, '/internal/rpc', internalRouter, ({ hono }) => ({
  repo,
  auth: createAuthClient(hono.get('requestId')),
  logger: hono.get('logger'),
}));

mountRpc(app, '/admin/rpc', adminRouter, ({ request, resHeaders, hono }) => ({
  repo,
  auth: createAuthClient(hono.get('requestId')),
  request,
  resHeaders,
  requestId: hono.get('requestId'),
  admin: readAdminContext(request.headers),
}));

mountCsrfEndpoint(app, '/admin/csrf', 'panel');

// The central Admin shell. Gateway has already verified the session and the admin role for every
// request that reaches these assets.
mountSpa(app, {
  basePath: '/admin',
  rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
});

serveService(app, 'admin', logger);
