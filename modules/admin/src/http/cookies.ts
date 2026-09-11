import type { AdminEnv } from '../env.js';

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

/** Clear the browser cookie only after Auth has revoked the session. */
export function expiredSessionCookie({ sessionCookieName, publicOrigin }: Pick<AdminEnv, 'sessionCookieName' | 'publicOrigin'>): string {
  const secure = publicOrigin.startsWith('https://') ? '; Secure' : '';
  return `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly${secure}; SameSite=Lax`;
}
