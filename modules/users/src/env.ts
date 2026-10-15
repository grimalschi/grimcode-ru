/** Database, Auth session cookie and this module's own CSRF cookie, supplied by composition. */
export interface UsersEnv {
  databaseUrl: string;
  sessionCookieName: string;
  /** Scope of the double-submit token the admin screen's changing calls carry. */
  csrfCookieName: string;
}
