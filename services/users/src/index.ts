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

import { resolveIdentity } from './auth-client.js';
import { migrations } from './db/migrations.js';
import { UsersRepository } from './repository.js';
import { adminRouter, publicRouter } from './routers.js';

const logger = createLogger('users');
const pool = createPool('users');
const repo = new UsersRepository(pool);

await waitForDatabase(pool);
await runMigrations(pool, migrations, logger);

const app = createServiceApp('users', logger);

mountRpc(app, '/service/users/rpc', publicRouter, async ({ request, hono }) => ({
  repo,
  identity: await resolveIdentity(request, hono.get('requestId')),
}));


mountRpc(app, '/admin/embed/service/users/rpc', adminRouter, ({ request }) => ({
  repo,
  request,
  admin: readAdminContext(request.headers),
}));

mountCsrfEndpoint(app, '/admin/embed/service/users/csrf', 'users');

mountSpa(app, {
  basePath: '/admin/embed/service/users',
  rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
});

serveService(app, 'users', logger);
