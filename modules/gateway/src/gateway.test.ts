import type { AuthorizationResult } from '@template/admin/contract';
import { ADMIN_CONTEXT_HEADERS, ServiceUnavailableError } from '@template/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isAdminService, isPublicService, type GatewayTargets } from './registry.js';
import { routeRequest } from './router.js';

/**
 * The Admin call itself is stubbed here: these tests are about Gateway's own routing, allowlists
 * and header handling. The real round-trip to Admin is covered by the acceptance checks.
 */
const stub = vi.hoisted(() => ({
  authorize: null as unknown as (request: Request, target: unknown) => Promise<unknown>,
  calls: [] as unknown[],
}));

vi.mock('./authorize.js', () => ({
  authorizeAdminRequest: (request: Request, target: unknown) => {
    stub.calls.push(target);
    return stub.authorize(request, target);
  },
}));

/** What Gateway actually sent onwards, and to which of its targets. */
interface Forwarded {
  target: string;
  path: string;
  method: string;
  headers: Headers;
}

const forwarded: Forwarded[] = [];

let upstreamResponse: () => Response;

/**
 * A module standing in for a real one.
 *
 * Gateway is handed applications rather than addresses, so a fake is a function that answers a
 * `Request` — which is all a real module is from here. Where a request went is now the name of the
 * target rather than a host in a URL, and that is the honest question: in one process there is no
 * host to look at, and the module still receives the address the browser asked for.
 */
function fakeModule(name: string) {
  return (request: Request): Response => {
    const url = new URL(request.url);
    forwarded.push({
      target: name,
      path: url.pathname + url.search,
      method: request.method,
      headers: new Headers(request.headers),
    });
    return upstreamResponse();
  };
}

function fakeTargets(): GatewayTargets {
  return {
    site: fakeModule('site'),
    app: fakeModule('app'),
    admin: fakeModule('admin'),
    auth: fakeModule('auth'),
    users: fakeModule('users'),
    notifications: fakeModule('notifications'),
    email: fakeModule('email'),
    database: fakeModule('database'),
  };
}

let targets: GatewayTargets;

const OWNER = {
  state: 'allowed',
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'owner@example.com',
  role: 'owner',
} satisfies AuthorizationResult;

const DENIED = { state: 'denied', reason: 'not-an-administrator' } satisfies AuthorizationResult;

beforeEach(() => {
  // Both are required now, without a fallback: a refusal names the missing one instead of the
  // program guessing a slug or an origin. The refusal page links to sign-in, hence the origin here.
  process.env.PROJECT_SLUG = 'template';
  process.env.PUBLIC_SITE_URL = 'http://127.0.0.1:63000';
  forwarded.length = 0;
  stub.calls.length = 0;
  stub.authorize = async () => DENIED;
  upstreamResponse = () => new Response('upstream', { status: 200 });
  targets = fakeTargets();
});

/** Admin's caller, unused: the module that reads it is mocked above. */
const callAdmin = (() => ({})) as Parameters<typeof routeRequest>[3];

async function route(path: string, init?: RequestInit): Promise<Response> {
  return routeRequest(
    new Request(`http://gateway.test${path}`, init),
    'req-test',
    targets,
    callAdmin,
  );
}

describe('allowlists', () => {
  /**
   * The database section is not a module of this template. It is a section of the admin panel, so
   * it appears in neither list and is reached by its own area instead.
   */
  it('keeps the database section out of both service lists', () => {
    expect(isPublicService('database')).toBe(false);
    expect(isAdminService('database')).toBe(false);
  });

  it('does not recognise an unknown service name', () => {
    expect(isPublicService('billing')).toBe(false);
    expect(isAdminService('../auth')).toBe(false);
  });
});

describe('public routing', () => {
  it('sends everything unmatched to site without rewriting the path', async () => {
    await route('/pricing?ref=1');
    expect(forwarded[0]?.target).toBe('site');
    expect(forwarded[0]?.path).toBe('/pricing?ref=1');
  });

  it('sends /app/** to app', async () => {
    await route('/app/dashboard');
    expect(forwarded[0]?.target).toBe('app');
    expect(forwarded[0]?.path).toBe('/app/dashboard');
  });

  it('sends an allowlisted /service/:name/** to that service, path preserved', async () => {
    await route('/service/auth/rpc/login', { method: 'POST', body: '{}' });
    expect(forwarded[0]?.target).toBe('auth');
    expect(forwarded[0]?.path).toBe('/service/auth/rpc/login');
  });

  it('refuses an unknown public service', async () => {
    const response = await route('/service/billing/anything');
    expect(response.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  it('never exposes the database section through the public service path', async () => {
    const response = await route('/service/database/');
    expect(response.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });
});

describe('admin authorization', () => {
  it('denies an anonymous request to central Admin', async () => {
    const response = await route('/admin');
    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it('applies the same check to admin assets, not just HTML', async () => {
    const response = await route('/admin/assets/index-abc123.js');
    expect(response.status).toBe(403);
    expect(stub.calls).toEqual([{ area: 'panel' }]);
    expect(forwarded).toHaveLength(0);
  });

  it('forwards a verified administrator context after Admin allowed the request', async () => {
    stub.authorize = async () => OWNER;
    await route('/admin/embed/service/email/templates/123');

    const sent = forwarded[0];
    expect(sent?.target).toBe('email');
    expect(sent?.path).toBe('/admin/embed/service/email/templates/123');
    expect(sent?.headers.get('x-template-admin-user-id')).toBe(OWNER.userId);
    expect(sent?.headers.get('x-template-admin-email')).toBe('owner@example.com');
    expect(sent?.headers.get('x-template-admin-role')).toBe('owner');
    expect(sent?.headers.get('x-template-request-id')).toBe('req-test');
  });

  it('replaces control headers a client tried to forge', async () => {
    stub.authorize = async () => OWNER;
    const headers = new Headers();
    for (const name of ADMIN_CONTEXT_HEADERS) headers.set(name, 'forged-by-client');
    await route('/admin/embed/service/email/', { headers });

    const sent = forwarded[0];
    for (const name of ADMIN_CONTEXT_HEADERS) {
      expect(sent?.headers.get(name)).not.toBe('forged-by-client');
    }
    expect(sent?.headers.get('x-template-admin-user-id')).toBe(OWNER.userId);
  });

  it('strips forged control headers even on a public route that is never authorized', async () => {
    const headers = new Headers();
    for (const name of ADMIN_CONTEXT_HEADERS) headers.set(name, 'forged-by-client');
    await route('/service/auth/rpc/login', { method: 'POST', body: '{}', headers });

    const sent = forwarded[0];
    expect(sent?.headers.get('x-template-admin-user-id')).toBeNull();
    expect(sent?.headers.get('x-template-admin-role')).toBeNull();
    expect(sent?.headers.get('x-template-admin-email')).toBeNull();
  });

  it('asks Admin about the requested service', async () => {
    stub.authorize = async () => OWNER;
    await route('/admin/embed/service/email/');
    expect(stub.calls).toEqual([{ area: 'service', service: 'email' }]);
  });

  it('asks Admin about the database area and proxies it to the interface', async () => {
    stub.authorize = async () => OWNER;
    await route('/admin/embed/database/api/databases');
    expect(stub.calls).toEqual([{ area: 'database' }]);
    expect(forwarded[0]?.target).toBe('database');
    // Unrewritten, like every other target: the interface reads its own path off the request.
    expect(forwarded[0]?.path).toBe('/admin/embed/database/api/databases');
  });

  it('asks Admin about the panel itself for everything else', async () => {
    stub.authorize = async () => OWNER;
    await route('/admin/administrators');
    expect(stub.calls).toEqual([{ area: 'panel' }]);
    expect(forwarded[0]?.target).toBe('admin');
    expect(forwarded[0]?.path).toBe('/admin/administrators');
  });

  it('refuses an unknown admin service without asking Admin at all', async () => {
    stub.authorize = async () => OWNER;
    const response = await route('/admin/embed/service/billing/');
    expect(response.status).toBe(404);
    expect(stub.calls).toHaveLength(0);
    expect(forwarded).toHaveLength(0);
  });

  it('denies the owner-only database area to a regular administrator', async () => {
    stub.authorize = async () => ({ state: 'denied', reason: 'owner-only' });
    const response = await route('/admin/embed/database/');
    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  it('reports a missing first user instead of pretending the rights are missing', async () => {
    stub.authorize = async () => ({ state: 'awaiting-first-user' });
    const response = await route('/admin');
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'awaiting-first-user' });
  });

  it('fails closed with 503 when Admin is unreachable', async () => {
    stub.authorize = async () => {
      throw new ServiceUnavailableError('admin', new Error('connect ECONNREFUSED'));
    };
    const response = await route('/admin');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'service-unavailable' });
    expect(forwarded).toHaveLength(0);
  });
});

describe('response headers', () => {
  it('never forwards stale content-encoding or content-length', async () => {
    upstreamResponse = () =>
      new Response('decoded-asset-body', {
        status: 200,
        headers: {
          'content-type': 'application/javascript',
          'content-encoding': 'gzip',
          'content-length': '17',
        },
      });

    const response = await route('/assets/app.js');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-type')).toBe('application/javascript');
  });

  it('asks upstream for an identity encoding so the runtime never decodes behind our back', async () => {
    await route('/assets/app.js');
    expect(forwarded[0]?.headers.get('accept-encoding')).toBe('identity');
  });

  it('keeps a target redirect and its cookie for the browser', async () => {
    upstreamResponse = () =>
      new Response(null, {
        status: 302,
        headers: { location: '/app/login', 'set-cookie': 'template_session=abc' },
      });

    const response = await route('/app/account');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/app/login');
    expect(response.headers.get('set-cookie')).toBe('template_session=abc');
  });

  it('drops hop-by-hop headers in both directions', async () => {
    upstreamResponse = () =>
      new Response('body', { status: 200, headers: { connection: 'keep-alive' } });

    const response = await route('/', { headers: { connection: 'keep-alive', te: 'trailers' } });
    expect(forwarded[0]?.headers.get('connection')).toBeNull();
    expect(forwarded[0]?.headers.get('te')).toBeNull();
    expect(response.headers.get('connection')).toBeNull();
  });
});
