import { verifyPassword } from '@template/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { DUMMY_PASSWORD_HASH } from './routers/public.js';
import { expiredSessionCookie, sessionCookie, SESSION_TTL_SECONDS } from './sessions.js';

const originalPublicUrl = process.env.PUBLIC_SITE_URL;

afterEach(() => {
  if (originalPublicUrl === undefined) delete process.env.PUBLIC_SITE_URL;
  else process.env.PUBLIC_SITE_URL = originalPublicUrl;
  delete process.env.AUTH_SESSION_TTL_SECONDS;
  process.env.PROJECT_SLUG = 'template';
});

describe('session cookie', () => {
  it('is HttpOnly and SameSite=Lax so no script can read it', () => {
    const cookie = sessionCookie('token-value', 60);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=60');
  });

  /**
   * The flag follows the public origin, not NODE_ENV: the local stack runs the very same
   * production images over plain http, where a Secure cookie would never be sent back.
   */
  it('is marked Secure for an https origin and not for a local http one', () => {
    process.env.PUBLIC_SITE_URL = 'http://127.0.0.1:8080';
    expect(sessionCookie('t', 60)).not.toContain('Secure');
    process.env.PUBLIC_SITE_URL = 'https://example.com';
    expect(sessionCookie('t', 60)).toContain('Secure');
  });

  it('clears with the same attributes, so the browser really drops it', () => {
    process.env.PUBLIC_SITE_URL = 'https://example.com';
    const cleared = expiredSessionCookie();
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
  });

  it('defaults to a 30 day lifetime and honours an override', () => {
    expect(SESSION_TTL_SECONDS()).toBe(60 * 60 * 24 * 30);
    process.env.AUTH_SESSION_TTL_SECONDS = '3600';
    expect(SESSION_TTL_SECONDS()).toBe(3600);
  });
});

describe('login timing defence', () => {
  /**
   * When no identity matches, login still verifies this fixed hash so that a wrong address and a
   * wrong password take comparable time. If it ever stopped being a parseable hash, the work would
   * be skipped and login would become an existence oracle again.
   */
  it('is a parseable hash that never matches and never throws', async () => {
    await expect(verifyPassword('anything at all', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
    await expect(verifyPassword('', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });

  it('costs real work rather than returning early on a malformed value', async () => {
    const [scheme, salt, key] = DUMMY_PASSWORD_HASH.split('$');
    expect(scheme).toBe('scrypt');
    expect(salt).toHaveLength(32);
    expect(key).toHaveLength(128);
  });
});
