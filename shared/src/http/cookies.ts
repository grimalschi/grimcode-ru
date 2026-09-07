import { publicSiteUrl, sessionCookieName } from '../env.js';

export interface CookieOptions {
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name === '') continue;
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  return parts.join('; ');
}

/** Expired cookie used by server-side logout after the session row is already invalidated. */
export function clearCookie(name: string, options: CookieOptions = {}): string {
  return serializeCookie(name, '', { ...options, maxAge: 0 });
}

/**
 * Whether the session cookie may only travel over HTTPS. Follows the public origin rather than
 * NODE_ENV: the same build runs locally over plain http, and a `Secure` cookie would then never come
 * back. Nothing in this project reads NODE_ENV at all.
 */
function secureCookies(): boolean {
  return publicSiteUrl().startsWith('https://');
}

/**
 * The session cookie is HttpOnly. The pair lives here rather than in Auth because the admin panel
 * signs out through a procedure of its own, and a cookie cleared with a different `Secure`, `Path`
 * or `SameSite` is a cookie the browser keeps.
 */
export function sessionCookie(token: string, ttlSeconds: number): string {
  return serializeCookie(sessionCookieName(), token, {
    maxAge: ttlSeconds,
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'Lax',
    path: '/',
  });
}

/**
 * Cookie that removes the session from the browser. Only ever sent *after* the session row has been
 * invalidated server-side: deleting the cookie alone would leave a usable session behind.
 */
export function expiredSessionCookie(): string {
  return clearCookie(sessionCookieName(), {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'Lax',
    path: '/',
  });
}
