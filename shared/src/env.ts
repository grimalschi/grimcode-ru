/**
 * Typed access to the environment, for the composer and for `shared` itself while answering a request. A
 * module reaches for none of it. Which database a module opens is not here — that is the composer's.
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

/**
 * Required, without a fallback, and both of these used to have one: `template` for the slug and
 * `http://127.0.0.1:8080` for the origin. A missing value is not a case worth guessing at — measured
 * on 27 August, a run without `PROJECT_SLUG` answered 200 and created `template_auth`,
 * `template_email` and `template_notifications`, so the data went where nobody asked for it. A missing
 * origin is quieter still: the links in verification and recovery mail are built from it, and the
 * session cookie is marked `Secure` by its scheme, so a forgotten value sends working mail nobody can
 * follow and drops `Secure` on an https deployment.
 */
export function projectSlug(): string {
  return requireEnv('PROJECT_SLUG');
}

export function publicSiteUrl(): string {
  return requireEnv('PUBLIC_SITE_URL').replace(/\/+$/, '');
}

/** Name of the session cookie. Scoped by project slug so parallel worktrees do not collide. */
export function sessionCookieName(): string {
  return `${projectSlug()}_session`;
}

/**
 * Name of the CSRF cookie of one admin surface. The panel and each embedded service admin issue
 * their own, because they share an origin: one name for all of them means whichever asked last
 * overwrites the others' cookie, and the first is refused on its next change with nothing to say why.
 */
export function csrfCookieName(scope: string): string {
  return `${projectSlug()}_csrf_${scope}`;
}
