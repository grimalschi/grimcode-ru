import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { newId } from '../crypto.js';
import type { Logger } from '../logger.js';
import { ownPort, type InternalServiceName } from '../service-urls.js';
import { REQUEST_ID_HEADER } from './admin-context.js';

export interface ServiceAppVariables {
  requestId: string;
  logger: Logger;
}

export type ServiceApp = Hono<{ Variables: ServiceAppVariables }>;

/**
 * Hono application shared by every Node service: request id propagation, access logging and a
 * health endpoint. It contains no product logic and no routing policy — Gateway owns routing.
 */
export function createServiceApp(service: InternalServiceName, logger: Logger): ServiceApp {
  const app = new Hono<{ Variables: ServiceAppVariables }>();

  app.use('*', async (c, next) => {
    const requestId = c.req.header(REQUEST_ID_HEADER) ?? newId();
    const requestLogger = logger.child({ requestId });
    c.set('requestId', requestId);
    c.set('logger', requestLogger);
    c.header(REQUEST_ID_HEADER, requestId);

    const startedAt = Date.now();
    await next();
    requestLogger.info('request', {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
    });
  });

  app.get('/healthz', (c) => c.json({ ok: true, service }));

  return app;
}

/** Starts the service on its fixed internal container port. */
export function serveService(app: ServiceApp, service: InternalServiceName, logger: Logger): void {
  const port = ownPort(service);
  serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
    logger.info('service listening', { service, port: info.port });
  });
}

/** Fail-closed 503 used when a dependency needed for an authorization decision is unreachable. */
export function serviceUnavailableResponse(message: string): Response {
  return new Response(JSON.stringify({ error: 'service-unavailable', message }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
