/**
 * The smallest HTTP client these tests need.
 *
 * They speak to the stack the way a browser does — over Gateway, with cookies — rather than
 * importing service code: a test that called a router directly would prove the router works and say
 * nothing about whether Gateway lets the request through.
 */

export const BASE_URL = (process.env.ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:63000').replace(
  /\/+$/,
  '',
);

/** One browser: it holds its cookies and nothing else. */
export class Session {
  private cookies = new Map<string, string>();
  /**
   * One token per surface, because each issues its own cookie: a single cached token would send the
   * panel's to a service admin and be refused.
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
   * A redirect is returned as it is. Walking redirects by hand used to live here, for the one page
   * that answered with one — the third-party database browser — and nothing in this template does.
   */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) headers.set('cookie', this.cookieHeader);

    const response = await fetch(`${BASE_URL}${path}`, { ...init, headers, redirect: 'manual' });
    this.remember(response);
    return response;
  }

  /** Status of a plain GET, which is what "can this person open that page" means. */
  async status(path: string): Promise<number> {
    return (await this.fetch(path)).status;
  }

  /** A token from the surface being called, fetched from the same prefix the call goes to. */
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
      body: JSON.stringify(input),
    });

    const text = await response.text();
    const parsed = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);

    // An answer is `{ result: { data } }` on success and `{ error: … }` on refusal. The error
    // shape is kept whole so that `errorCode` and `errorMessage` can read it.
    const result = parsed?.result as { data?: unknown } | undefined;
    return { status: response.status, body: (result ? result.data : parsed) as T };
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

/**
 * The code of a refusal.
 *
 * The string code is at `body.error.data.code`. At `body.error.code` there is a **number** —
 * `-32003` and friends — and reading that one instead compiles, never throws, and makes every
 * `expect(errorCode(...)).toBe('FORBIDDEN')` in this suite silently false: the checks would stop
 * checking without a single red run. Hence the explicit path.
 */
export function errorCode(body: unknown): string | undefined {
  return (body as { error?: { data?: { code?: string } } } | null)?.error?.data?.code;
}

/** The text of a refusal, from the same envelope. */
export function errorMessage(body: unknown): string {
  return String((body as { error?: { message?: string } } | null)?.error?.message);
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
    `The stack did not answer at ${BASE_URL}. Start it with "pnpm dev", or point ` +
      'ACCEPTANCE_BASE_URL at a running one.',
  );
}
