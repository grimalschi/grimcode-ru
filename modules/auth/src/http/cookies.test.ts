import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearCookie, expiredSessionCookie, parseCookies, serializeCookie, sessionCookie } from './cookies.js';

afterEach(() => vi.unstubAllEnvs());

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

/** Auth owns issuance; expiry follows the same browser cookie convention as Admin logout. */
describe('session cookie', () => {
  const settings = { sessionCookieName: 'template_session', publicOrigin: 'http://127.0.0.1:63000' };

  it('is HttpOnly and SameSite=Lax so no script can read it', () => {
    const cookie = sessionCookie('token-value', 60, settings);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=60');
  });

  /** The flag follows the supplied public origin; local development uses http. */
  it('is marked Secure for an https origin and not for a local http one', () => {
    expect(sessionCookie('t', 60, settings)).not.toContain('Secure');
    expect(sessionCookie('t', 60, { ...settings, publicOrigin: 'https://example.com' })).toContain('Secure');
  });

  it('clears with the same attributes, so the browser really drops it', () => {
    const cleared = expiredSessionCookie({ ...settings, publicOrigin: 'https://example.com' });
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
  });

  it('uses the supplied settings even when the process belongs to another installation', () => {
    vi.stubEnv('PROJECT_SLUG', 'another');
    vi.stubEnv('PUBLIC_SITE_URL', 'https://another.example');
    expect(sessionCookie('t', 60, settings)).toBe(
      'template_session=t; Path=/; Max-Age=60; HttpOnly; SameSite=Lax',
    );
    expect(expiredSessionCookie(settings)).toBe(
      'template_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    );
  });
});
