/**
 * The server-rendered site, as an application the composer mounts.
 *
 * The framework's build produces a fetch handler for the pages and a directory of client files, and
 * neither is served on its own: static files first, then the handler for anything that is a page.
 *
 * The site's address arrives as an argument, because this module is the one place in the repository
 * that is handwritten JavaScript the compiler never sees, and reading the environment from here
 * would be the hardest kind of environment access to notice. It is also the one module without
 * `createServiceApp`: what it wraps is the framework's own handler, not a service of ours.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import entry from '../dist/server/server.js';

/**
 * Absolute, on purpose. `serveStatic` resolves a relative root against the working directory, and
 * the composer starts the process from wherever it likes. Measured on `@hono/node-server` 2.0.11:
 * from another working directory a relative root answers 404 with a warning, an absolute one 200.
 */
const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../dist/client');

/**
 * The public pages, in the order a person would meet them. The application and the admin panel are
 * behind sign-in and have nothing to offer a crawler; the legal pages stay out until a project
 * writes them and they say something.
 */
const SITEMAP = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/about', changefreq: 'monthly', priority: '0.7' },
  { path: '/contact', changefreq: 'monthly', priority: '0.5' },
];

/**
 * Builds the site application. It listens to nothing; the composer owns the port.
 *
 * @param {{ origin: string }} options — the site's public address, without a trailing slash.
 */
export function createApp({ origin }) {
  const base = origin.replace(/\/+$/, '');
  const app = new Hono();

  app.get('/robots.txt', (context) =>
    context.text(
      [
        '# Приложение и админка находятся за входом, индексировать там нечего.',
        'User-agent: *',
        'Disallow: /app/',
        'Disallow: /admin/',
        'Disallow: /service/',
        'Allow: /',
        '',
        `Sitemap: ${base}/sitemap.xml`,
        '',
      ].join('\n'),
      200,
      { 'cache-control': 'public, max-age=3600' },
    ),
  );

  app.get('/sitemap.xml', (context) => {
    const entries = SITEMAP.map(
      ({ path, changefreq, priority }) =>
        `  <url>\n` +
        `    <loc>${base}${path}</loc>\n` +
        `    <changefreq>${changefreq}</changefreq>\n` +
        `    <priority>${priority}</priority>\n` +
        `  </url>`,
    ).join('\n');

    return context.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`,
      200,
      { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    );
  });

  // Build output carries a content hash in its name, so a stale copy can never be served under a
  // new name and the file may be cached for a long time.
  app.use(
    '/assets/*',
    serveStatic({
      root: CLIENT_ROOT,
      onFound: (_path, context) => {
        context.header('cache-control', 'public, max-age=31536000, immutable');
      },
    }),
  );

  // Everything from `public/`: the favicon and whatever a project adds. These keep their names
  // between deploys, so they are only cached briefly.
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

  return app;
}
