import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCookies } from './cookies.js';

/** The readable cookie must be repeated in a header that another origin cannot supply. */
export function issueCsrfToken(cookieName: string, headers?: Headers) {
  const existing = parseCookies(headers?.get('cookie') ?? null)[cookieName];
  const token = existing && /^[A-Za-z0-9_-]{32}$/.test(existing) ? existing : randomBytes(24).toString('base64url');
  return { token, cookie: `${cookieName}=${token}; Path=/; SameSite=Lax` };
}

/** Compare the header with this surface's own cookie, using a constant-time byte comparison. */
export function isCsrfValid(headers: Headers, cookieName: string): boolean {
  const cookieToken = parseCookies(headers.get('cookie'))[cookieName];
  const headerToken = headers.get('x-csrf-token');
  if (!cookieToken || !headerToken) return false;
  const left = Buffer.from(cookieToken, 'utf8');
  const right = Buffer.from(headerToken, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}
