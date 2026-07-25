import type { AuthorizationResult } from '@template/contracts';
import { ADMIN_CONTEXT_HEADERS, createLogger, ServiceUnavailableError } from '@template/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isAdminService, isPublicService } from './registry.js';
import { routeRequest } from './router.js';

/**
 * The Admin call itself is stubbed here: these tests are about Gateway's own routing, allowlists
 * and header handling. The real oRPC round-trip is covered by the integration checks.
 */
const stub = vi.hoisted(() => ({
  authorize: null as unknown as (request: Request, service: string | null) => Promise<unknown>,
  calls: [] as (string | null)[],
}));

vi.mock('./authorize.js', () => ({
  authorizeAdminRequest: (request: Request, service: string | null) => {
    stub.calls.push(service);
    return stub.authorize(request, service);
  },
}));

/** Captures what Gateway actually sent upstream. */
interface Forwarded {
  url: string;
  method: string;
  headers: Headers;
}

const forwarded: Forwarded[] = [];
const logger = createLogger('gateway-test');

const OWNER = {
  state: 'allowed',
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'owner@example.com',
  role: 'owner',
} satisfies AuthorizationResult;

const DENIED = { state: 'denied', reason: 'not-an-administrator' } satisfies AuthorizationResult;

let upstreamResponse: () => Response;

beforeEach(() => {
  process.env.PROJECT_SLUG = 'template';
  forwarded.length = 0;
  stub.calls.length = 0;
  stub.authorize = async () => DENIED;
  upstreamResponse = () => new Response('upstream', { status: 200 });

  vi.stubGlobal('fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    forwarded.push({
      url: input instanceof URL ? input.toString() : String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers as HeadersInit),
    });
    return upstreamResponse();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function route(path: string, init?: RequestInit): Promise<Response> {
  return routeRequest(new Request(`http://gateway.test${path}`, init), 'req-test', logger);
}

describe('allowlists', () => {
  it('keeps Adminer out of the public list and inside the admin list', () => {
    expect(isPublicService('adminer')).toBe(false);
    expect(isAdminService('adminer')).toBe(true);
  });

  it('does not recognise an unknown service name', () => {
    expect(isPublicService('billing')).toBe(false);
    expect(isAdminService('../auth')).toBe(false);
  });
});

describe('public routing', () => {
  it('sends everything unmatched to site without rewriting the path', async () => {
    await route('/pricing?ref=1');
    expect(forwarded[0]?.url).toBe('http://site:3000/pricing?ref=1');
  });

  it('sends /app/** to app', async () => {
    await route('/app/dashboard');
    expect(forwarded[0]?.url).toBe('http://app:3001/app/dashboard');
  });

  it('sends an allowlisted /service/:name/** to that service, path preserved', async () => {
    await route('/service/auth/rpc/login', { method: 'POST', body: '{}' });
    expect(forwarded[0]?.url).toBe('http://auth:3003/service/auth/rpc/login');
  });

  it('refuses an unknown public service', async () => {
    const response = await route('/service/billing/anything');
    expect(response.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  it('never exposes Adminer through the public service path', async () => {
    const response = await route('/service/adminer/');
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
    expect(stub.calls).toEqual([null]);
    expect(forwarded).toHaveLength(0);
  });

  it('forwards a verified administrator context after Admin allowed the request', async () => {
    stub.authorize = async () => OWNER;
    await route('/admin/service/email/templates/123');

    const sent = forwarded[0];
    expect(sent?.url).toBe('http://email:3006/admin/service/email/templates/123');
    expect(sent?.headers.get('x-template-admin-user-id')).toBe(OWNER.userId);
    expect(sent?.headers.get('x-template-admin-email')).toBe('owner@example.com');
    expect(sent?.headers.get('x-template-admin-role')).toBe('owner');
    expect(sent?.headers.get('x-template-request-id')).toBe('req-test');
  });

  it('replaces control headers a client tried to forge', async () => {
    stub.authorize = async () => OWNER;
    const headers = new Headers();
    for (const name of ADMIN_CONTEXT_HEADERS) headers.set(name, 'forged-by-client');
    await route('/admin/service/email/', { headers });

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

  it('asks Admin about the requested service name', async () => {
    stub.authorize = async () => OWNER;
    await route('/admin/service/adminer/');
    expect(stub.calls).toEqual(['adminer']);
  });

  it('asks Admin without a service name for central Admin', async () => {
    stub.authorize = async () => OWNER;
    await route('/admin/administrators');
    expect(stub.calls).toEqual([null]);
    expect(forwarded[0]?.url).toBe('http://admin:3002/admin/administrators');
  });

  it('refuses an unknown admin service without asking Admin at all', async () => {
    stub.authorize = async () => OWNER;
    const response = await route('/admin/service/billing/');
    expect(response.status).toBe(404);
    expect(stub.calls).toHaveLength(0);
    expect(forwarded).toHaveLength(0);
  });

  it('denies an owner-only service to a regular administrator', async () => {
    stub.authorize = async () => ({ state: 'denied', reason: 'owner-only' });
    const response = await route('/admin/service/adminer/');
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

  it('keeps a service redirect and its cookie for the browser', async () => {
    upstreamResponse = () =>
      new Response(null, {
        status: 302,
        headers: { location: '/admin/service/adminer/?pgsql=', 'set-cookie': 'adminer_sid=abc' },
      });
    stub.authorize = async () => OWNER;

    const response = await route('/admin/service/adminer/');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/service/adminer/?pgsql=');
    expect(response.headers.get('set-cookie')).toBe('adminer_sid=abc');
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
