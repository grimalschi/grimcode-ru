import { newToken, safeEqual } from '../crypto.js';
import { csrfCookieName } from '../env.js';
import { parseCookies, serializeCookie, type CookieOptions } from './cookies.js';

export const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit CSRF token.
 *
 * The value lives in a readable cookie and must be repeated in a request header. A cross-site page
 * can make the browser send the cookie but cannot read it, so it cannot produce the header.
 */
export function issueCsrfToken(options: CookieOptions = {}): { token: string; cookie: string } {
  const token = newToken(24);
  return {
    token,
    cookie: serializeCookie(csrfCookieName(), token, {
      ...options,
      httpOnly: false,
      sameSite: 'Lax',
    }),
  };
}

export function readCsrfCookie(cookieHeader: string | null | undefined): string | null {
  return parseCookies(cookieHeader)[csrfCookieName()] ?? null;
}

/** True when the request carries a header token matching its own CSRF cookie. */
export function isCsrfValid(headers: Headers): boolean {
  const cookieToken = readCsrfCookie(headers.get('cookie'));
  const headerToken = headers.get(CSRF_HEADER);
  if (!cookieToken || !headerToken) return false;
  return safeEqual(cookieToken, headerToken);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requiresCsrfCheck(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}
