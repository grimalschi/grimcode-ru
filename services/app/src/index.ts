import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger, createServiceApp, mountSpa, serveService } from '@template/shared';

/**
 * The user-facing application.
 *
 * It has no database of its own: identity and sessions come from Auth, the product profile from
 * Users. Its server does one thing — serve the built SPA under `/app/` — because every protected
 * call the application makes is checked by the service that owns the data, not here.
 */
const logger = createLogger('app');

const app = createServiceApp('app', logger);

mountSpa(app, {
  basePath: '/app',
  rootDir: join(dirname(fileURLToPath(import.meta.url)), '../web/dist'),
});

serveService(app, 'app', logger);
