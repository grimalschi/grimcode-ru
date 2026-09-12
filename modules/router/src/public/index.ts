import { Hono } from 'hono';
import type { RouterOptions } from '../registry.js';
import { routeRequest } from '../router.js';

export function createPublicFetch(options: RouterOptions) {
  const { env, ...routing } = options;
  const app = new Hono<{ Bindings: RouterOptions['env'] }>();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'router' }));
  app.all('*', (c) => routeRequest(c.req.raw, { ...routing, env: c.env }));
  return (request: Request) => app.fetch(request, env);
}
