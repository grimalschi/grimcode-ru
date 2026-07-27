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
import { EmailRepository } from './repository.js';
import { renderMessage } from './render.js';
import { adminRouter, internalRouter } from './routers.js';
import { createTransport } from './transport.js';

const logger = createLogger('email');
const pool = createPool('email');
const repo = new EmailRepository(pool);
const transport = createTransport(logger);

await waitForDatabase(pool);
await runMigrations(pool, migrations, logger);

// Seed templates are created directly in the editor's own format, already published, so the auth
// flows work on a fresh installation. Existing templates are never overwritten.
const seeded = await repo.ensureSeedTemplates((document, subject) =>
  renderMessage(document, subject).then(({ html, text }) => ({ html, text })),
);
if (seeded > 0) logger.info('seed templates created', { created: seeded, transport: transport.name });

const app = createServiceApp('email', logger);

mountRpc(app, '/internal/rpc', internalRouter, ({ hono }) => ({
  repo,
  transport,
  logger: hono.get('logger'),
}));

mountRpc(app, '/admin/embed/services/email/rpc', adminRouter, ({ request, hono }) => ({
  repo,
  transport,
  logger: hono.get('logger'),
  request,
  admin: readAdminContext(request.headers),
}));

mountCsrfEndpoint(app, '/admin/embed/services/email/csrf', 'email');

// The editor lives in this service's own build and loads only on the editor route; it is never
// part of the central Admin bundle or of runtime delivery.
mountSpa(app, {
  basePath: '/admin/embed/services/email',
  rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
});

serveService(app, 'email', logger);
