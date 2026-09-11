/** Database and cookie settings. Who may sign in is data, not configuration. */
export interface AdminEnv {
  databaseUrl: string;
  sessionCookieName: string;
  /** The public origin determines whether the session cookie must be Secure. */
  publicOrigin: string;
  csrfCookieName: string;
}
