import {
  clearCookie,
  intEnv,
  isProduction,
  newToken,
  serializeCookie,
  sessionCookieName,
} from '@template/shared';

export const SESSION_TTL_SECONDS = () => intEnv('AUTH_SESSION_TTL_SECONDS', 60 * 60 * 24 * 30);

export function newSessionToken(): string {
  return newToken(32);
}

/**
 * The session cookie is HttpOnly, so the browser can send it but no script can read it. The
 * application never learns its internal format.
 */
export function sessionCookie(token: string, ttlSeconds: number): string {
  return serializeCookie(sessionCookieName(), token, {
    maxAge: ttlSeconds,
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'Lax',
    path: '/',
  });
}

/**
 * Cookie that removes the session from the browser.
 *
 * It is only ever sent *after* the session row has been invalidated server-side: deleting the
 * cookie alone would leave a usable session behind.
 */
export function expiredSessionCookie(): string {
  return clearCookie(sessionCookieName(), {
    httpOnly: true,
    secure: isProduction(),
    sameSite: 'Lax',
    path: '/',
  });
}
