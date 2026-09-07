import { readFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The built screen, served by the package itself.
 *
 * Not `@hono/node-server/serve-static` or any other helper: this package depends on nothing, and
 * reading a file is not where a dependency earns its place. The screen is built into `web/dist` by
 * `vite build`, which is part of this package's `build`.
 */
const ROOT = fileURLToPath(new URL('../web/dist/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * The file a path asks for, or null when it asks for something outside the built screen.
 *
 * The guard is the reason this is its own function: a path is text from a request, and `..` in it
 * would otherwise read any file the process can. `normalize` collapses the traversal first, and what
 * comes out must still start inside the root.
 */
function resolve(path: string): string | null {
  const cleaned = path.replace(/^\/+/, '');
  if (cleaned === '') return join(ROOT, 'index.html');

  const full = normalize(join(ROOT, cleaned));
  return full.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) ? full : null;
}

/**
 * Answers with the screen.
 *
 * Anything that is not a file of the build gets `index.html`: the screen keeps its state in the URL
 * hash, and a link somebody sends should open rather than 404. `assets/` is content-hashed by vite, so
 * it can be cached hard; the page itself never is, because the next build replaces it.
 */
export async function serveScreen(path: string): Promise<Response> {
  const file = resolve(path);

  if (file !== null) {
    const body = await readFile(file).catch(() => null);
    if (body !== null) return file_(file, body);
  }

  const index = await readFile(join(ROOT, 'index.html')).catch(() => null);
  if (index === null) {
    return new Response(
      JSON.stringify({
        error: 'screen-not-built',
        message: 'The screen is not built. Run the package build; its API is unaffected.',
      }),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }

  return file_(join(ROOT, 'index.html'), index);
}

function file_(path: string, body: Buffer): Response {
  const extension = path.slice(path.lastIndexOf('.'));
  const asset = path.includes(`${sep}assets${sep}`);

  return new Response(new Uint8Array(body), {
    headers: {
      'content-type': TYPES[extension] ?? 'application/octet-stream',
      'cache-control': asset ? 'public, max-age=31536000, immutable' : 'no-store',
    },
  });
}
