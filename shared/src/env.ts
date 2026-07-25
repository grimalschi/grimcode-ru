/**
 * Typed access to the environment.
 *
 * Every value comes from the single root `.env` documented in `.env.example`. A service only ever
 * reads the variables that are declared for it in the Compose file.
 */

export class MissingEnvError extends Error {
  constructor(name: string) {
    super(`Required environment variable ${name} is not set`);
    this.name = 'MissingEnvError';
  }
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new MissingEnvError(name);
  return value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${name} is not an integer`);
  return parsed;
}

export function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function projectSlug(): string {
  return optionalEnv('PROJECT_SLUG', 'template');
}

export function isProduction(): boolean {
  return optionalEnv('NODE_ENV', 'development') === 'production';
}

export function publicSiteUrl(): string {
  return optionalEnv('PUBLIC_SITE_URL', 'http://127.0.0.1:8080').replace(/\/+$/, '');
}

/**
 * Connection string of one service database.
 *
 * The template uses a single base `DATABASE_URL`; each stateful service owns the database
 * `<PROJECT_SLUG>_<service>` on that server. A deployment that needs different credentials or
 * hosts per service can set `DATABASE_URL_<SERVICE>` instead.
 */
export function serviceDatabaseUrl(service: string): string {
  const override = process.env[`DATABASE_URL_${service.toUpperCase()}`];
  if (override !== undefined && override !== '') return override;

  const base = requireEnv('DATABASE_URL');
  const url = new URL(base);
  url.pathname = `/${serviceDatabaseName(service)}`;
  return url.toString();
}

export function serviceDatabaseName(service: string): string {
  return `${projectSlug()}_${service}`;
}

/** Name of the session cookie. Scoped by project slug so parallel worktrees do not collide. */
export function sessionCookieName(): string {
  return `${projectSlug()}_session`;
}

export function csrfCookieName(): string {
  return `${projectSlug()}_csrf`;
}
