import type { AdminContext } from '@template/contracts/module-instance';
import type { AdminApi, AuthorizationResult } from '@template/contracts/modules/admin';
import { gzipSync, gunzipSync } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';

import { hasModule, type RouterOptions } from './registry.js';
import { routeRequest } from './router.js';
import type { RouterEnv } from './env.js';

/**
 * The Admin call itself is stubbed here: these tests are about Router's own routing, allowlists
 * and header handling. The connection to Admin is covered by the acceptance checks.
 */
const stub = {
  authorize: null as unknown as AdminApi['authorize'],
  calls: [] as unknown[],
};

/** What Router actually sent onwards, and to which of its targets. */
interface Forwarded {
  target: string;
  path: string;
  method: string;
  headers: Headers;
  adminContext?: AdminContext;
}

const forwarded: Forwarded[] = [];

let upstreamResponse: () => Response;

/** A bound module handler records the unchanged request address. */
function fakeModule(name: string) {
  return (request: Request, adminContext?: AdminContext): Response => {
    const url = new URL(request.url);
    forwarded.push({
      target: name,
      path: url.pathname + url.search,
      method: request.method,
      headers: new Headers(request.headers),
      adminContext,
    });
    return upstreamResponse();
  };
}

function fakeOptions(): RouterOptions {
  return {
    env: ENV,
    modules: { admin },
    publicFetches: {
      web: fakeModule('web'),
      auth: fakeModule('auth.public'), users: fakeModule('users.public'),
    },
    adminFetches: {
      admin: fakeModule('admin'),
      auth: fakeModule('auth.admin'), users: fakeModule('users.admin'),
      notifications: fakeModule('notifications.admin'), email: fakeModule('email.admin'),
    },
  };
}

let options: RouterOptions;

const OWNER = {
  state: 'allowed',
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'owner@example.com',
  role: 'owner',
} satisfies AuthorizationResult;

const DENIED = { state: 'denied', reason: 'not-an-administrator' } satisfies AuthorizationResult;

const ENV: RouterEnv = {
  sessionCookieName: 'template_session',
  publicOrigin: 'http://127.0.0.1:63000',
};

beforeEach(() => {
  forwarded.length = 0;
  stub.calls.length = 0;
  stub.authorize = async () => DENIED;
  upstreamResponse = () => new Response('upstream', { status: 200 });
  options = fakeOptions();
});

const admin: AdminApi = {
  authorize: (input) => {
    stub.calls.push(input.target);
    return stub.authorize(input);
  },
};

async function route(path: string, init?: RequestInit): Promise<Response> {
  return routeRequest(
    new Request(`http://router.test${path}`, init),
    options,
  );
}

describe('allowlists', () => {
  /**
   * The database section is not a module of this template. It is a section of the admin panel, so
   * it appears in neither list and is handled inside Admin.
   */
  it('keeps the database section out of both module lists', () => {
    expect(hasModule(options.publicFetches, 'database')).toBe(false);
    expect(hasModule(options.adminFetches, 'database')).toBe(false);
  });

  it('does not recognise an unknown module name', () => {
    expect(hasModule(options.publicFetches, 'billing')).toBe(false);
    expect(hasModule(options.adminFetches, '../auth')).toBe(false);
  });

  it.each(['/module/', '/admin/embed/module/'])('refuses reserved names under %s even when registered', async (prefix) => {
    stub.authorize = async () => OWNER;
    for (const name of ['web', 'admin', 'router']) {
      options.publicFetches = { ...options.publicFetches, [name]: fakeModule(`${name}.public`) };
      options.adminFetches = { ...options.adminFetches, [name]: fakeModule(`${name}.admin`) };

      expect((await route(`${prefix}${name}/rpc/example`)).status, name).toBe(404);
      expect(stub.calls).toHaveLength(0);
      expect(forwarded).toHaveLength(0);
    }
  });

  it.each(['/module/', '/admin/embed/module/'])('routes explicitly registered own property names under %s', async (prefix) => {
    stub.authorize = async () => OWNER;
    const names = Object.getOwnPropertyNames(Object.prototype);
    const surface = prefix.startsWith('/admin/') ? 'admin' : 'public';
    for (const name of names) {
      options.publicFetches = { ...options.publicFetches, [name]: fakeModule(`${name}.public`) };
      options.adminFetches = { ...options.adminFetches, [name]: fakeModule(`${name}.admin`) };
      const path = `${prefix}${name}/rpc/example`;

      expect((await route(path)).status, name).toBe(200);
      expect(forwarded.at(-1)?.target).toBe(`${name}.${surface}`);
      expect(forwarded.at(-1)?.path).toBe(path);
    }
    expect(stub.calls).toEqual(surface === 'admin'
      ? names.map((module) => ({ area: 'module', module }))
      : []);
  });

  it.each(['/module/', '/admin/embed/module/'])('refuses inherited names under %s before authorization or forwarding', async (prefix) => {
    stub.authorize = async () => OWNER;
    for (const name of Object.getOwnPropertyNames(Object.prototype)) {
      expect((await route(`${prefix}${name}/rpc/example`)).status, name).toBe(404);
    }
    Object.setPrototypeOf(options.publicFetches, { billing: fakeModule('inherited.public') });
    Object.setPrototypeOf(options.adminFetches, { billing: fakeModule('inherited.admin') });
    expect((await route(`${prefix}billing/rpc/example`)).status).toBe(404);
    expect(stub.calls).toHaveLength(0);
    expect(forwarded).toHaveLength(0);
  });
});

describe('public routing', () => {
  it('sends public pages to Web without rewriting the path', async () => {
    await route('/pricing?ref=1');
    expect(forwarded[0]?.target).toBe('web');
    expect(forwarded[0]?.path).toBe('/pricing?ref=1');
  });

  it('sends product pages to the same Web handler', async () => {
    await route('/app/dashboard');
    expect(forwarded[0]?.target).toBe('web');
    expect(forwarded[0]?.path).toBe('/app/dashboard');
  });

  it('sends an allowlisted /module/:name/** to that module, path preserved', async () => {
    await route('/module/auth/rpc/login', { method: 'POST', body: '{}' });
    expect(forwarded[0]?.target).toBe('auth.public');
    expect(forwarded[0]?.path).toBe('/module/auth/rpc/login');
  });

  it('refuses an unknown public module', async () => {
    const response = await route('/module/billing/anything');
    expect(response.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  it('never exposes the database section through the public module path', async () => {
    const response = await route('/module/database/');
    expect(response.status).toBe(404);
    expect(forwarded).toHaveLength(0);
  });

  it('selects a distinct surface and never exposes an admin-only module publicly', async () => {
    stub.authorize = async () => OWNER;
    await route('/module/auth/rpc/example');
    await route('/admin/embed/module/auth/rpc/example');
    expect(forwarded.map(({ target }) => target)).toEqual(['auth.public', 'auth.admin']);
    const response = await route('/module/email/rpc/example');
    expect(response.status).toBe(404);
    expect(forwarded).toHaveLength(2);
  });

  it('routes installed modules without a source-level name list and rejects inherited names', async () => {
    options.publicFetches = {
      web: options.publicFetches.web,
      billing: fakeModule('billing.public'),
    };
    await route('/module/billing/rpc/example');
    expect(forwarded[0]?.target).toBe('billing.public');
    expect((await route('/module/toString/rpc/example')).status).toBe(404);
    expect((await route('/module/auth/rpc/example')).status).toBe(404);
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
    await route('/admin/embed/module/email/templates/123');

    const sent = forwarded[0];
    expect(sent?.target).toBe('email.admin');
    expect(sent?.path).toBe('/admin/embed/module/email/templates/123');
    expect(sent?.adminContext).toEqual({ userId: OWNER.userId, email: OWNER.email, role: OWNER.role });
  });

  it('builds administrator context from authorization independently of client headers', async () => {
    stub.authorize = async () => OWNER;
    const headers = new Headers({
      'x-template-admin-user-id': 'forged-by-client',
      'x-template-admin-email': 'attacker@example.com',
      'x-template-admin-role': 'admin',
      adminContext: '{"role":"owner"}',
    });
    await route('/admin/embed/module/email/', { headers });

    const sent = forwarded[0];
    expect(sent?.adminContext).toEqual({ userId: OWNER.userId, email: OWNER.email, role: OWNER.role });
    expect(sent?.headers.get('x-template-admin-user-id')).toBe('forged-by-client');
  });

  it('never supplies administrator context to a public handler', async () => {
    const headers = new Headers({ 'x-template-admin-role': 'owner', adminContext: '{"role":"owner"}' });
    await route('/module/auth/rpc/login', { method: 'POST', body: '{}', headers });

    const sent = forwarded[0];
    expect(sent?.adminContext).toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });

  it('asks Admin about the requested module', async () => {
    stub.authorize = async () => OWNER;
    await route('/admin/embed/module/email/');
    expect(stub.calls).toEqual([{ area: 'module', module: 'email' }]);
  });

  it.each(['/admin/database', '/admin/rpc/database.rows'])('routes %s through the ordinary Admin handler', async (path) => {
    stub.authorize = async () => OWNER;
    await route(path);
    expect(stub.calls).toEqual([{ area: 'panel' }]);
    expect(forwarded[0]?.target).toBe('admin');
    expect(forwarded[0]?.path).toBe(path);
  });

  it('asks Admin about the panel itself for everything else', async () => {
    stub.authorize = async () => OWNER;
    await route('/admin/administrators');
    expect(stub.calls).toEqual([{ area: 'panel' }]);
    expect(forwarded[0]?.target).toBe('admin');
    expect(forwarded[0]?.path).toBe('/admin/administrators');
  });

  it('refuses an unknown admin module without asking Admin at all', async () => {
    stub.authorize = async () => OWNER;
    const response = await route('/admin/embed/module/billing/');
    expect(response.status).toBe(404);
    expect(stub.calls).toHaveLength(0);
    expect(forwarded).toHaveLength(0);
  });

  it('routes an arbitrary installed admin module after checking its grant', async () => {
    stub.authorize = async () => OWNER;
    options.adminFetches = { ...options.adminFetches, billing: fakeModule('billing.admin') };
    const response = await route('/admin/embed/module/billing/rpc/example');
    expect(response.status).toBe(200);
    expect(stub.calls).toEqual([{ area: 'module', module: 'billing' }]);
    expect(forwarded[0]?.target).toBe('billing.admin');
    expect(forwarded[0]?.path).toBe('/admin/embed/module/billing/rpc/example');
  });

  it.each(['/admin/embed/database/', '/admin/embed/database/api/schemas'])('refuses the removed embedded database path %s', async (path) => {
    stub.authorize = async () => OWNER;
    expect((await route(path)).status).toBe(404);
    expect(stub.calls).toHaveLength(0);
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
      throw new Error('Admin unavailable');
    };
    const response = await route('/admin');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'module-unavailable' });
    expect(forwarded).toHaveLength(0);
  });

  it('returns 502 when authorization succeeds but the selected handler fails', async () => {
    stub.authorize = async () => OWNER;
    upstreamResponse = () => { throw new Error('Module handler failed'); };

    const response = await route('/admin/embed/module/email/');

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'bad-gateway' });
    expect(forwarded).toHaveLength(1);
  });
});

describe('module grant boundaries', () => {
  it.each([
    ['/admin/embed/module/auth/../users/rpc/listProfiles', 403, 'users'],
    ['/admin/embed/module/auth/%2e%2e/users/rpc/listProfiles', 403, 'users'],
    ['/admin//embed/module/users/rpc/listProfiles', 403, 'users'],
    ['/admin/embed/module/auth%2f..%2fusers/rpc/listProfiles', 404, null],
    ['/admin/embed/module/%75sers/rpc/listProfiles', 404, null],
    ['/admin/embed/module/users/rpc/listProfiles?module=auth&path=auth', 403, 'users'],
  ])('checks the destination of %s instead of a granted prefix', async (path, status, module) => {
    stub.authorize = async ({ target }) => target.area === 'module' && target.module === 'auth'
      ? OWNER : DENIED;
    const response = await route(path, { headers: {
      'x-template-admin-user-id': OWNER.userId,
      'x-template-admin-email': OWNER.email,
      'x-template-admin-role': OWNER.role,
      'x-original-url': '/admin/embed/module/auth/',
      'x-rewrite-url': '/admin/embed/module/auth/',
    } });
    expect(response.status).toBe(status);
    expect(stub.calls).toEqual(module ? [{ area: 'module', module }] : []);
    expect(forwarded).toHaveLength(0);
  });

  it('reauthorizes the whole batch on every request after a grant changes', async () => {
    const path = '/admin/embed/module/auth/rpc/listIdentities,listAudit?batch=1';
    const request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"0":{},"1":{}}' };
    stub.authorize = async () => OWNER;
    expect((await route(path, request)).status).toBe(200);
    stub.authorize = async () => DENIED;
    expect((await route(path, request)).status).toBe(403);
    expect(stub.calls).toEqual([{ area: 'module', module: 'auth' }, { area: 'module', module: 'auth' }]);
    expect(forwarded).toHaveLength(1);
  });
});

describe('response headers', () => {
  it('preserves a module response encoding and compressed body', async () => {
    const compressed = gzipSync('asset-body');
    upstreamResponse = () =>
      new Response(compressed, {
        status: 200,
        headers: {
          'content-type': 'application/javascript',
          'content-encoding': 'gzip',
          'content-length': String(compressed.length),
        },
      });

    const response = await route('/assets/app.js');
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-type')).toBe('application/javascript');
    const body = Buffer.from(await response.arrayBuffer());
    expect(body).toEqual(compressed);
    expect(gunzipSync(body).toString()).toBe('asset-body');
  });

  it('passes the browser encoding preferences to the module', async () => {
    await route('/assets/app.js', { headers: { 'accept-encoding': 'gzip, br' } });
    expect(forwarded[0]?.headers.get('accept-encoding')).toBe('gzip, br');
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
