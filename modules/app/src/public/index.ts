import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

import { mountSpa } from '../http/spa.js';

/** Serves only this module's public application, including its sign-in screens. */
export function createPublicFetch() {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, module: 'app' }));
  mountSpa(app, {
    basePath: '/app',
    rootDir: join(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  });
  return (request: Request) => app.fetch(request);
}
