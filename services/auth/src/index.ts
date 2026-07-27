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
import { Notifier } from './notifier.js';
import { AuthRepository } from './repository.js';
import { adminRouter } from './routers/admin.js';
import { internalRouter } from './routers/internal.js';
import { publicRouter } from './routers/public.js';

const logger = createLogger('auth');
const pool = createPool('auth');
const repo = new AuthRepository(pool);

await waitForDatabase(pool);
await runMigrations(pool, migrations, logger);

const app = createServiceApp('auth', logger);

/**
 * Three mounts, one per trust boundary.
 *
 * Gateway proxies `/service/auth/**` and `/admin/embed/service/auth/**` and never proxies
 * `/internal/**`, so the internal surface stays reachable only from the Docker network.
 */

mountRpc(app, '/service/auth/rpc', publicRouter, ({ request, resHeaders, hono }) => ({
  repo,
  notifier: new Notifier(hono.get('logger'), () => hono.get('requestId')),
  logger: hono.get('logger'),
  request,
  resHeaders,
}));

mountRpc(app, '/internal/rpc', internalRouter, () => ({ repo }));

mountRpc(app, '/admin/embed/service/auth/rpc', adminRouter, ({ request, hono }) => ({
  repo,
  notifier: new Notifier(hono.get('logger'), () => hono.get('requestId')),
  logger: hono.get('logger'),
  request,
  // Written by Gateway only after Admin allowed the request; a client can never forge it.
  admin: readAdminContext(request.headers),
}));

mountCsrfEndpoint(app, '/admin/embed/service/auth/csrf', 'auth');

mountSpa(app, {
  basePath: '/admin/embed/service/auth',
  rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
});

serveService(app, 'auth', logger);
