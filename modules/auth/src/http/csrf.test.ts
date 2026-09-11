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

  it('issues and validates the cookie captured for each application', async () => {
    vi.stubEnv('PROJECT_SLUG', 'unrelated');
    const firstApp = new Hono();
    const secondApp = new Hono();
    mountCsrfEndpoint(firstApp, '/admin/csrf', 'first_panel_csrf');
    mountCsrfEndpoint(secondApp, '/admin/csrf', 'second_panel_csrf');

    const first = await firstApp.fetch(new Request('https://example.test/admin/csrf'));
    const second = await secondApp.fetch(new Request('https://example.test/admin/csrf'));
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
