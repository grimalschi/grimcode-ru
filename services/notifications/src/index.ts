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
import { NotificationsRepository } from './repository.js';
import { adminRouter, internalRouter } from './routers.js';

const logger = createLogger('notifications');
const pool = createPool('notifications');
const repo = new NotificationsRepository(pool);

await waitForDatabase(pool);
await runMigrations(pool, migrations, logger);

const app = createServiceApp('notifications', logger);

// Notifications has no public surface: only other services emit events, over the internal network.
mountRpc(app, '/internal/rpc', internalRouter, ({ hono }) => ({
  repo,
  logger: hono.get('logger'),
  requestId: hono.get('requestId'),
}));

mountRpc(app, '/admin/embed/services/notifications/rpc', adminRouter, ({ request }) => ({
  repo,
  admin: readAdminContext(request.headers),
}));

mountCsrfEndpoint(app, '/admin/embed/services/notifications/csrf', 'notifications');

mountSpa(app, {
  basePath: '/admin/embed/services/notifications',
  rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
});

serveService(app, 'notifications', logger);
