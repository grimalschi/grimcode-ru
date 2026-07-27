import { beforeEach, describe, expect, it } from 'vitest';

import { hashPassword, safeEqual, verifyPassword } from './crypto.js';
import { serviceDatabaseName, serviceDatabaseUrl } from './env.js';
import {
  ADMIN_CONTEXT_HEADERS,
  applyAdminContext,
  readAdminContext,
  stripAdminContextHeaders,
} from './http/admin-context.js';
import { clearCookie, parseCookies, serializeCookie } from './http/cookies.js';
import { CSRF_HEADER, isCsrfValid, requiresCsrfCheck } from './http/csrf.js';
import { applyTheme, normalizeServicePath } from './theme.js';

describe('cookies', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; b=hello%20world')).toEqual({ a: '1', b: 'hello world' });
  });

  it('ignores malformed pairs', () => {
    expect(parseCookies('=1; broken; c=3')).toEqual({ c: '3' });
  });

  it('serializes a HttpOnly Lax cookie by default', () => {
    expect(serializeCookie('s', 'v')).toBe('s=v; Path=/; HttpOnly; SameSite=Lax');
  });

  it('clears a cookie with Max-Age=0', () => {
    expect(clearCookie('s')).toContain('Max-Age=0');
  });
});

describe('admin context headers', () => {
  const context = {
    userId: '00000000-0000-4000-8000-000000000000',
    email: 'owner@example.com',
    role: 'owner' as const,
    requestId: 'req-42',
  };

  it('removes every client-supplied control header', () => {
    const headers = new Headers();
    for (const name of ADMIN_CONTEXT_HEADERS) headers.set(name, 'forged');
    stripAdminContextHeaders(headers);
    for (const name of ADMIN_CONTEXT_HEADERS) expect(headers.get(name)).toBeNull();
  });

  it('round-trips a verified context', () => {
    const headers = new Headers();
    applyAdminContext(headers, context);
    expect(readAdminContext(headers)).toEqual(context);
  });

  it('refuses a forged context that a strip would have removed', () => {
    const headers = new Headers();
    headers.set('x-template-admin-user-id', 'not-a-uuid');
    headers.set('x-template-admin-email', 'attacker@example.com');
    headers.set('x-template-admin-role', 'owner');
    headers.set('x-template-request-id', 'req-1');
    expect(readAdminContext(headers)).toBeNull();
  });

  it('treats a missing context as no context at all', () => {
    expect(readAdminContext(new Headers())).toBeNull();
  });
});

describe('csrf', () => {
  // The cookie name is scoped by project slug so parallel worktrees never share a token.
  beforeEach(() => {
    process.env.PROJECT_SLUG = 'template';
  });

  it('skips safe methods and guards the rest', () => {
    expect(requiresCsrfCheck('GET')).toBe(false);
    expect(requiresCsrfCheck('head')).toBe(false);
    expect(requiresCsrfCheck('POST')).toBe(true);
  });

  it('accepts a matching cookie and header pair', () => {
    const headers = new Headers({
      cookie: 'template_csrf_panel=token-value',
      [CSRF_HEADER]: 'token-value',
    });
    expect(isCsrfValid(headers, 'panel')).toBe(true);
  });

  it('rejects a request that only carries the cookie', () => {
    expect(isCsrfValid(new Headers({ cookie: 'template_csrf_panel=t' }), 'panel')).toBe(false);
  });

  it('rejects a mismatching header', () => {
    const headers = new Headers({
      cookie: 'template_csrf_panel=token-value',
      [CSRF_HEADER]: 'other-value',
    });
    expect(isCsrfValid(headers, 'panel')).toBe(false);
  });

  /**
   * The panel and each embedded service admin share an origin. One cookie name for all of them
   * meant whichever asked last overwrote the others, and the surface that asked first was refused
   * on its next change with nothing to explain it.
   */
  it('does not accept another surface’s token', () => {
    const headers = new Headers({
      cookie: 'template_csrf_email=token-value',
      [CSRF_HEADER]: 'token-value',
    });
    expect(isCsrfValid(headers, 'email')).toBe(true);
    expect(isCsrfValid(headers, 'panel')).toBe(false);
  });
});

describe('passwords', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
  });

  it('produces a different hash for the same password', async () => {
    expect(await hashPassword('same password 123')).not.toBe(await hashPassword('same password 123'));
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  it('compares strings without leaking length-independent timing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('service databases', () => {
  it('derives one database per service from the base url', () => {
    process.env.PROJECT_SLUG = 'demo';
    process.env.DATABASE_URL = 'postgres://u:p@postgres:5432/postgres';
    expect(serviceDatabaseName('auth')).toBe('demo_auth');
    expect(serviceDatabaseUrl('auth')).toBe('postgres://u:p@postgres:5432/demo_auth');
  });

  it('prefers an explicit per-service override', () => {
    process.env.DATABASE_URL_EMAIL = 'postgres://other@db:5432/custom';
    expect(serviceDatabaseUrl('email')).toBe('postgres://other@db:5432/custom');
    delete process.env.DATABASE_URL_EMAIL;
  });
});

describe('theme', () => {
  it('drops the attribute for system so prefers-color-scheme applies', () => {
    const attributes = new Map<string, string>();
    const target = {
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
    };

    applyTheme(target, 'dark');
    expect(attributes.get('data-theme')).toBe('dark');
    applyTheme(target, 'system');
    expect(attributes.has('data-theme')).toBe(false);
  });

  it('normalizes service-relative paths', () => {
    expect(normalizeServicePath('')).toBe('/');
    expect(normalizeServicePath('templates/1')).toBe('/templates/1');
    expect(normalizeServicePath('//templates//1')).toBe('/templates/1');
  });
});
