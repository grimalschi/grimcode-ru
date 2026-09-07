/** What this module is given: the database it works in. Who may sign in is data in it, not a variable. */
export interface AdminEnv {
  databaseUrl: string;
  /** The database `databaseUrl` must land on; the pool refuses anything else. */
  databaseName: string;
  /** The server itself, for the one `CREATE DATABASE`. */
  maintenanceUrl: string;
}
