/**
 * What this module is given, and the whole of it: settings are captured once by `createModule`. Values,
 * not variable names — and only what an installation decides, so the login limits stay constants in
 * `public/index.ts`.
 */
export interface AuthEnv {
  databaseUrl: string;
  /** Positive safe integer; defaults to 30 days when omitted. */
  sessionTtlSeconds?: number;
  /** Public origin for account links and the session cookie’s Secure flag. */
  publicOrigin: string;
  sessionCookieName: string;
  /** Full cookie name for this module’s administrative surface. */
  csrfCookieName: string;
}
