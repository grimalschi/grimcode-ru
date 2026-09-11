import { Hono } from 'hono';
import type { RouterOptions } from '../registry.js';
import { routeRequest } from '../router.js';

export function createPublicFetch(options: RouterOptions) {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'router' }));
  app.all('*', (c) => routeRequest(c.req.raw, options));
  return (request: Request) => app.fetch(request);
}
