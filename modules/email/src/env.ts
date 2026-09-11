import type { MailSettings } from './transport.js';

/** What this module is given: its database, mail settings and admin CSRF cookie name. */
export interface EmailEnv {
  databaseUrl: string;
  csrfCookieName: string;
  mail: MailSettings;
}
