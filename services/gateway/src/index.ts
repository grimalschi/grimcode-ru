import { createLogger, createServiceApp, serveService } from '@template/shared';

import { routeRequest } from './router.js';

const logger = createLogger('gateway');
const app = createServiceApp('gateway', logger);

/**
 * Gateway is the only container published outside. It owns entry, routing and external security,
 * has no database and contains no product logic.
 */
app.all('*', (c) => routeRequest(c.req.raw, c.get('requestId'), c.get('logger')));

serveService(app, 'gateway', logger);
