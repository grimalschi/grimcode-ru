/**
 * What this module is given, and the whole of it: a name missing here does not exist on `c.env`. Values,
 * not variable names — and only what an installation decides, so the login limits stay constants in
 * `index.ts`.
 */
export interface AuthEnv {
  databaseUrl: string;
  /** The database `databaseUrl` must land on; the pool refuses anything else. */
  databaseName: string;
  /** The server itself, for the one `CREATE DATABASE`. */
  maintenanceUrl: string;
  sessionTtlSeconds: number;
}
