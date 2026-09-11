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
 * Supplied by the caller. The origin's scheme controls Secure so the same build works over local
 * HTTP and production HTTPS without consulting process-wide configuration.
 */
interface SessionCookieSettings {
  sessionCookieName: string;
  publicOrigin: string;
}

/**
 * The HttpOnly session follows the cookie convention agreed with Auth and Admin.
 * Issuance and expiry must use the same name, Secure, Path and SameSite attributes.
 */
export function sessionCookie(
  token: string,
  ttlSeconds: number,
  settings: SessionCookieSettings,
): string {
  return serializeCookie(settings.sessionCookieName, token, {
    maxAge: ttlSeconds,
    httpOnly: true,
    secure: settings.publicOrigin.startsWith('https://'),
    sameSite: 'Lax',
    path: '/',
  });
}

/**
 * Cookie that removes the session from the browser. Only ever sent *after* the session row has been
 * invalidated server-side: deleting the cookie alone would leave a usable session behind.
 */
export function expiredSessionCookie(settings: SessionCookieSettings): string {
  return clearCookie(settings.sessionCookieName, {
    httpOnly: true,
    secure: settings.publicOrigin.startsWith('https://'),
    sameSite: 'Lax',
    path: '/',
  });
}
