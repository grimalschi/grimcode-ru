import type { MailSettings } from './transport.js';

/** What this module is given: its database, and the mail settings — one road for both. */
export interface EmailEnv {
  databaseUrl: string;
  /** The database `databaseUrl` must land on; the pool refuses anything else. */
  databaseName: string;
  /** The server itself, for the one `CREATE DATABASE`. */
  maintenanceUrl: string;
  mail: MailSettings;
}
