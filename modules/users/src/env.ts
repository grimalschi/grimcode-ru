/** What this module is given: the database it works in, and nothing else. */
export interface UsersEnv {
  databaseUrl: string;
  /** The database `databaseUrl` must land on; the pool refuses anything else. */
  databaseName: string;
  /** The server itself, for the one `CREATE DATABASE`. */
  maintenanceUrl: string;
}
