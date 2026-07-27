/**
 * The smallest HTTP client these tests need.
 *
 * They deliberately speak to the stack the way a browser does — over Gateway, with cookies — rather
 * than importing service code. A test that called a router directly would prove the router works
 * while saying nothing about whether Gateway lets the request through, which is the part that
 * actually protects anything.
 */

export const BASE_URL = (process.env.ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:8080').replace(
  /\/+$/,
  '',
);

/** One browser: it holds its cookies and nothing else. */
export class Session {
  private cookies = new Map<string, string>();
  /**
   * One token per surface, because each issues its own cookie.
   *
   * A single cached token here would send the panel's token to a service admin and be refused —
   * which is exactly the confusion the per-surface cookies exist to prevent.
   */
  private csrf = new Map<string, string>();

  get cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  get hasSession(): boolean {
    return [...this.cookies.keys()].some((name) => name.endsWith('_session'));
  }

  private remember(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index === -1) continue;

      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();

      // `Max-Age=0` is how the server deletes a cookie; keeping it would make a signed-out session
      // look signed in.
      if (/max-age=0/i.test(header) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /**
   * `follow` walks redirects by hand rather than letting fetch do it, so a cookie the first
   * response set is carried into the next request — which is exactly what Adminer's own redirect
   * needs.
   */
  async fetch(
    path: string,
    init: RequestInit = {},
    options: { follow?: boolean } = {},
  ): Promise<Response> {
    let target = path;

    for (let hop = 0; hop < 5; hop += 1) {
      const headers = new Headers(init.headers);
      if (this.cookies.size > 0) headers.set('cookie', this.cookieHeader);

      const response = await fetch(`${BASE_URL}${target}`, { ...init, headers, redirect: 'manual' });
      this.remember(response);

      const location = response.headers.get('location');
      if (!options.follow || response.status < 300 || response.status >= 400 || !location) {
        return response;
      }

      target = new URL(location, `${BASE_URL}${target}`).pathname + new URL(location, `${BASE_URL}${target}`).search;
      init = { ...init, method: 'GET', body: undefined };
    }

    throw new Error(`Too many redirects from ${path}`);
  }

  /** Status of a plain GET, which is what "can this person open that page" means. */
  async status(path: string): Promise<number> {
    return (await this.fetch(path)).status;
  }

  /**
   * A token from the surface being called.
   *
   * Each surface issues its own, so the token is fetched from the same prefix the call goes to.
   */
  private async csrfToken(prefix: string): Promise<string> {
    const cached = this.csrf.get(prefix);
    if (cached) return cached;

    const response = await this.fetch(`${prefix}/csrf`);
    if (!response.ok) throw new Error(`CSRF token unavailable at ${prefix}: ${response.status}`);

    const body = (await response.json()) as { token: string };
    this.csrf.set(prefix, body.token);
    return body.token;
  }

  /** Forgets the cached tokens, so a test can prove that a call without one is refused. */
  forgetCsrf(): void {
    this.csrf.clear();
  }

  async rpc<T = unknown>(
    prefix: string,
    procedure: string,
    input: unknown = {},
    options: { csrf?: boolean } = {},
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.csrf) headers['x-csrf-token'] = await this.csrfToken(prefix);

    const response = await this.fetch(`${prefix}/rpc/${procedure}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ json: input }),
    });

    const text = await response.text();
    const parsed = text === '' ? null : (JSON.parse(text) as { json?: unknown });

    return { status: response.status, body: (parsed?.json ?? parsed) as T };
  }

  /** An RPC that is expected to succeed; anything else fails the test where it happened. */
  async call<T = unknown>(
    prefix: string,
    procedure: string,
    input: unknown = {},
    options: { csrf?: boolean } = {},
  ): Promise<T> {
    const result = await this.rpc<T>(prefix, procedure, input, options);
    if (result.status !== 200) {
      throw new Error(
        `${procedure} failed with ${result.status}: ${JSON.stringify(result.body)}`,
      );
    }
    return result.body;
  }
}

export const AUTH = '/service/auth';
export const USERS = '/service/users';
export const ADMIN = '/admin';

/** Where an embedded service admin actually lives; the panel's own page for it is a path. */
export function serviceAdmin(service: string): string {
  return `/admin/embed/service/${service}`;
}

/** oRPC reports a refusal in the body; the code is what these tests assert on. */
export function errorCode(body: unknown): string | undefined {
  return (body as { code?: string } | null)?.code;
}

export async function waitForStack(attempts = 30): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(
    `The stack did not answer at ${BASE_URL}. Start it with "pnpm up", or point ` +
      'ACCEPTANCE_BASE_URL at a running one.',
  );
}
