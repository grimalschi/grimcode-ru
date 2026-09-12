import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { createPublicFetch } from './public.mjs';

// Like production composition, exercise the real built handler and its generated asset paths.
const fetch = createPublicFetch({ origin: 'https://example.test' });
const request = (path) => fetch(new Request(`https://example.test${path}`));

describe('Web assets and page navigation', () => {
  it('renders the built public pages and app shell with production React', async () => {
    const adapter = new URL('./public.mjs', import.meta.url).href;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createPublicFetch } from ${JSON.stringify(adapter)};
      const fetch = createPublicFetch({ origin: 'https://example.test' });
      for (const path of ['/', '/about', '/app/']) {
        const response = await fetch(new Request('https://example.test' + path));
        const body = await response.text();
        assert.equal(response.status, 200, path + ': ' + body);
        assert.match(body, /<!DOCTYPE html>/i);
      }
    `], { env: { ...process.env, NODE_ENV: 'production' } });
  });

  it.each(['/assets/nonexistent.js', '/assets/missing', '/assets/', '/assets', '/assets/favicon.svg', '/assets/missing.js.map'])(
    'returns a non-HTML 404 for the missing static path %s',
    async (path) => {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).not.toContain('text/html');
    },
  );

  it('serves a built JavaScript asset with its immutable cache policy', async () => {
    const root = new URL('../dist/client/assets/', import.meta.url);
    const asset = (await readdir(root)).find((file) => file.endsWith('.js'));
    expect(asset).toBeDefined();
    const response = await request(`/assets/${asset}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe(await readFile(new URL(asset, root), 'utf8'));
  });

  it.each(['/app/', '/app/settings', '/app/login?next=%2Fapp%2Fsettings'])(
    'returns the client application shell for %s',
    async (path) => {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-robots-tag')).toBe('noindex');
      const html = await response.text();
      expect(html).toContain('/assets/');
      expect(html).not.toContain('Ваш аккаунт');
    },
  );

  it.each(['/no-such-page', '/profiles/jane.doe', '/about/no-such-page', '/contact/no-such-page', '/legal/privacy/no-such-page'])(
    'renders the shared not-found page for %s',
    async (path) => {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('text/html');
      const html = await response.text();
      expect(html).toContain('Такой страницы нет');
      expect(html).toContain('href="/"');
    },
  );

  it('returns 404 for unknown product pages while their UI remains client-rendered', async () => {
    const response = await request('/app/no-such-page');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('Загрузка приложения');
  });
});
