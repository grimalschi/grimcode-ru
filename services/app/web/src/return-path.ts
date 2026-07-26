/**
 * The page a visitor was trying to reach before being sent to sign in.
 *
 * Only an internal application route survives this. An absolute URL, a protocol-relative one, a
 * backslash trick or anything outside `/app/` is dropped, so the sign-in page can never be turned
 * into an open redirect towards someone else's site.
 */
export function safeReturnPath(value: string | undefined | null): string | null {
  if (typeof value !== 'string' || value === '') return null;

  // `//evil.test` and `/\evil.test` are both read as another host by browsers.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (/^\/app\/(login|register|reset-password|verify-email)\b/.test(value)) return null;
  if (value !== '/app' && !value.startsWith('/app/')) return null;

  // A control character would be stripped by the browser and could change where this points.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;

  return value;
}

/** The path to return to after signing in, defaulting to the application's own home. */
export function returnPathOrHome(value: string | undefined | null): string {
  return safeReturnPath(value) ?? '/app/';
}
