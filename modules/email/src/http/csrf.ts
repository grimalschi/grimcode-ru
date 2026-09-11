import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCookies, serializeCookie, type CookieOptions } from './cookies.js';

export const CSRF_HEADER = 'x-csrf-token';

/**
 * Double-submit CSRF token.
 *
 * The value lives in a readable cookie and must be repeated in a request header. A cross-site page
 * can make the browser send the cookie but cannot read it, so it cannot produce the header.
 */
export function issueCsrfToken(
  cookieName: string,
  options: CookieOptions = {},
): { token: string; cookie: string } {
  const token = randomBytes(24).toString('base64url');
  return {
    token,
    cookie: serializeCookie(cookieName, token, {
      ...options,
      httpOnly: false,
      sameSite: 'Lax',
    }),
  };
}

export function readCsrfCookie(
  cookieHeader: string | null | undefined,
  cookieName: string,
): string | null {
  return parseCookies(cookieHeader)[cookieName] ?? null;
}

/** True when the request carries a header token matching this surface's own CSRF cookie. */
export function isCsrfValid(headers: Headers, cookieName: string): boolean {
  const cookieToken = readCsrfCookie(headers.get('cookie'), cookieName);
  const headerToken = headers.get(CSRF_HEADER);
  if (!cookieToken || !headerToken) return false;
  return safeEqual(cookieToken, headerToken);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
