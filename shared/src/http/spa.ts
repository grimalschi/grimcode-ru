import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import { issueCsrfToken } from './csrf.js';
import type { ServiceApp } from './service-app.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface SpaOptions {
  /** Public path the SPA is mounted on, for example `/admin/embed/service/email`. */
  basePath: string;
  /** Directory holding the built SPA. */
  rootDir: string;
}

/**
 * Serves a built single-page application on a path prefix.
 *
 * Deep links inside the SPA fall back to `index.html`, so a protected URL such as
 * `/admin/embed/service/email/templates/123` renders the app instead of a 404. Admin authorization has
 * already happened at Gateway — these assets are behind the very same check as the HTML.
 */
export function mountSpa(app: ServiceApp, options: SpaOptions): void {
  const root = resolve(options.rootDir);
  const base = options.basePath.replace(/\/+$/, '');

  app.get(`${base}`, (c) => c.redirect(`${base}/`));

  app.get(`${base}/*`, async (c) => {
    const url = new URL(c.req.url);
    const relative = decodeURIComponent(url.pathname.slice(base.length)).replace(/^\/+/, '');

    const asset = relative === '' ? null : await resolveAsset(root, relative);
    if (asset) return fileResponse(asset.path, asset.immutable);

    const index = join(root, 'index.html');
    try {
      await stat(index);
    } catch {
      return c.json(
        { error: 'not-built', message: 'The admin interface has not been built yet.' },
        503,
      );
    }
    return fileResponse(index, false);
  });
}

/**
 * Issues the double-submit CSRF cookie and hands its value to the admin interface.
 *
 * The token is not a secret by itself — its point is that a cross-site page can make the browser
 * send the cookie but cannot read it to produce the matching header.
 */
export function mountCsrfEndpoint(app: ServiceApp, path: string, scope: string): void {
  app.get(path, (c) => {
    const { token, cookie } = issueCsrfToken(scope, { path: '/' });
    c.header('set-cookie', cookie);
    c.header('cache-control', 'no-store');
    return c.json({ token });
  });
}

async function resolveAsset(
  root: string,
  relative: string,
): Promise<{ path: string; immutable: boolean } | null> {
  // Never let a request escape the build directory.
  const candidate = resolve(root, normalize(relative));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;

  try {
    const info = await stat(candidate);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }

  // Vite emits content-hashed file names under `assets/`, so those may be cached indefinitely.
  const immutable = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(candidate.replace(/\\/g, '/'));
  return { path: candidate, immutable };
}

function fileResponse(path: string, immutable: boolean): Response {
  const type = MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      // Admin surfaces are composed as same-origin iframes inside the central Admin shell.
      'x-content-type-options': 'nosniff',
    },
  });
}
