/**
 * Node entry for the server-rendered site.
 *
 * The framework's build produces two things: a fetch handler for the pages, and a directory of
 * client files — the stylesheet, the hydration bundles and everything copied from `public/`.
 * Neither is served on its own, so this file is the hosting the template needs: static files
 * first, then the handler for anything that is a page.
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import entry from '../dist/server/server.js';

const CLIENT_ROOT = './dist/client';
const port = Number(process.env.PORT ?? 3000);

const app = new Hono();

// Build output carries a content hash in its name, so a stale copy can never be served under a new
// name and the file may be cached for a long time.
app.use(
  '/assets/*',
  serveStatic({
    root: CLIENT_ROOT,
    onFound: (_path, context) => {
      context.header('cache-control', 'public, max-age=31536000, immutable');
    },
  }),
);

// Everything from `public/`: the favicon, robots.txt and whatever a project adds. These keep their
// names between deploys, so they are only cached briefly.
app.use(
  '/*',
  serveStatic({
    root: CLIENT_ROOT,
    onFound: (_path, context) => {
      context.header('cache-control', 'public, max-age=300');
    },
  }),
);

// Anything that is not a file is a page, and pages are rendered.
app.all('/*', (context) => entry.fetch(context.req.raw));

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(JSON.stringify({ service: 'site', message: 'service listening', port }));
});
