/**
 * Node entry for the server-rendered site.
 *
 * The framework's build produces two things: a fetch handler for the pages, and a directory of
 * client files — the stylesheet, the hydration bundles and everything copied from `public/`.
 * Neither is served on its own, so this file is the hosting the template needs: static files
 * first, then the handler for anything that is a page.
 *
 * `robots.txt` and `sitemap.xml` are built here rather than shipped as files, because both have to
 * name the site's real address, and that is only known once the deployment sets PUBLIC_SITE_URL.
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import entry from '../dist/server/server.js';

const CLIENT_ROOT = './dist/client';
const port = Number(process.env.PORT ?? 3000);
const origin = (process.env.PUBLIC_SITE_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');

/**
 * The public pages, in the order a person would meet them.
 *
 * Only what is genuinely public belongs here. The application and the admin panel are behind
 * sign-in and have nothing to offer a crawler, and the legal pages are placeholders until a project
 * writes them, so they stay out until they say something.
 */
const SITEMAP = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/about', changefreq: 'monthly', priority: '0.7' },
  { path: '/contact', changefreq: 'monthly', priority: '0.5' },
];

const app = new Hono();

app.get('/robots.txt', (context) =>
  context.text(
    [
      '# The application and the admin panel are behind sign-in and have nothing to index.',
      'User-agent: *',
      'Disallow: /app/',
      'Disallow: /admin/',
      'Disallow: /service/',
      'Allow: /',
      '',
      `Sitemap: ${origin}/sitemap.xml`,
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
      `    <loc>${origin}${path}</loc>\n` +
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

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(JSON.stringify({ service: 'site', message: 'service listening', port }));
});
