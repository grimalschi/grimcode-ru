/**
 * What this module is given: the database it works in. The delivery budgets stay constants — a call's
 * timeout and its caller's are tied by an invariant a `.env` cannot see.
 */
export interface NotificationsEnv {
  databaseUrl: string;
  /** The database `databaseUrl` must land on; the pool refuses anything else. */
  databaseName: string;
  /** The server itself, for the one `CREATE DATABASE`. */
  maintenanceUrl: string;
}
