import { afterEach, describe, expect, it, vi } from 'vitest';

import { CSRF_HEADER, isCsrfValid } from './csrf.js';
import { Hono } from 'hono';
import { mountCsrfEndpoint } from './spa.js';

afterEach(() => vi.unstubAllEnvs());

describe('csrf', () => {
  it('accepts a matching cookie and header pair', () => {
    const headers = new Headers({
      cookie: 'template_csrf_panel=token-value',
      [CSRF_HEADER]: 'token-value',
    });
    expect(isCsrfValid(headers, 'template_csrf_panel')).toBe(true);
  });

  it('rejects a request that only carries the cookie', () => {
    expect(isCsrfValid(new Headers({ cookie: 'template_csrf_panel=t' }), 'template_csrf_panel')).toBe(false);
  });

  it('rejects a mismatching header', () => {
    const headers = new Headers({
      cookie: 'template_csrf_panel=token-value',
      [CSRF_HEADER]: 'other-value',
    });
    expect(isCsrfValid(headers, 'template_csrf_panel')).toBe(false);
  });

  /** The surfaces share an origin, so one name for all of them means the last to ask wins. */
  it('does not accept another surface’s token', () => {
    const headers = new Headers({
      cookie: 'template_csrf_email=token-value',
      [CSRF_HEADER]: 'token-value',
    });
    expect(isCsrfValid(headers, 'template_csrf_email')).toBe(true);
    expect(isCsrfValid(headers, 'template_csrf_panel')).toBe(false);
  });

  it('issues and validates the cookie from each request’s bindings', async () => {
    vi.stubEnv('PROJECT_SLUG', 'unrelated');
    const app = new Hono<{ Bindings: { csrfCookieName: string } }>();
    mountCsrfEndpoint(app, '/admin/csrf');

    const first = await app.fetch(new Request('https://example.test/admin/csrf'), { csrfCookieName: 'first_panel_csrf' });
    const second = await app.fetch(new Request('https://example.test/admin/csrf'), { csrfCookieName: 'second_panel_csrf' });
    const { token } = await first.json() as { token: string };
    const cookie = first.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^first_panel_csrf=/);
    expect(second.headers.get('set-cookie')).toMatch(/^second_panel_csrf=/);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const headers = new Headers({ cookie, [CSRF_HEADER]: token });
    expect(isCsrfValid(headers, 'first_panel_csrf')).toBe(true);
    expect(isCsrfValid(headers, 'second_panel_csrf')).toBe(false);
  });
});
