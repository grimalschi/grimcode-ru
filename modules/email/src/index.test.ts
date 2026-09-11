import { describe, expect, it } from 'vitest';
import { createModule } from './index.js';

const env = {
  databaseUrl: 'postgres://unused/test_email',
  csrfCookieName: 'email_csrf',
  mail: { provider: 'log', apiKey: '', apiUrl: '', fromAddress: '', fromName: '' },
};

describe('Email module connection', () => {
  it('exposes no public handler and requires no database to create the module or serve CSRF', async () => {
    const module = createModule({ env });
    expect(module).not.toHaveProperty('publicFetch');
    expect(module.internalCaller.send).toBeTypeOf('function');
    expect(module).not.toHaveProperty('app');
    const response = await module.adminFetch(new Request('https://example.test/admin/embed/module/email/csrf'));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/^email_csrf=/);
    expect((await module.adminFetch(new Request('https://example.test/module/email/rpc/send'))).status).toBe(404);
    expect((await module.adminFetch(new Request('https://example.test/internal/rpc/send'))).status).toBe(404);
  });
  it('opening a second tab preserves the token already used by the first', async () => {
    const module = createModule({ env });
    const url = 'https://example.test/admin/embed/module/email/csrf';
    const first = await module.adminFetch(new Request(url));
    const { token } = await first.json() as { token: string };
    const second = await module.adminFetch(new Request(url, {
      headers: { cookie: `email_csrf=${token}` },
    }));
    expect(await second.json()).toEqual({ token });
    expect(second.headers.get('set-cookie')).toBeNull();
    expect(second.headers.get('cache-control')).toBe('no-store');
  });

});
