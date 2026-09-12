import type { AdminContext } from '@template/contracts/module-instance';
import { describe, expect, it, vi } from 'vitest';
import type { EmailRepository } from '../repository.js';
import { createAdminFetch } from './index.js';

const owner: AdminContext = {
  userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', role: 'owner',
};
const administrator: AdminContext = {
  userId: '00000000-0000-4000-8000-000000000002', email: 'admin@example.com', role: 'admin',
};
const env = {
  databaseUrl: 'postgres://unused/test_email', csrfCookieName: 'email_csrf',
  mail: { provider: 'log' as const, apiKey: '', apiUrl: '', fromAddress: '', fromName: '' },
};

function request(key: string) {
  return new Request('https://example.test/admin/embed/module/email/rpc/createTemplate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json', cookie: 'email_csrf=token', 'x-csrf-token': 'token',
      'x-template-admin-user-id': owner.userId, 'x-template-admin-email': owner.email,
      'x-template-admin-role': owner.role,
    },
    body: JSON.stringify({ key, name: key, description: null, variables: [] }),
  });
}

function setup() {
  const repo = {
    findTemplateByKey: vi.fn<EmailRepository['findTemplateByKey']>().mockResolvedValue(null),
    createTemplate: vi.fn<EmailRepository['createTemplate']>().mockImplementation(async (key, name, description, variables) => ({
      id: '00000000-0000-4000-8000-000000000003', key, name, description, variables,
      created_at: new Date('2026-01-01T00:00:00Z'), updated_at: new Date('2026-01-01T00:00:00Z'),
    })),
    audit: vi.fn<EmailRepository['audit']>().mockResolvedValue(undefined),
  };
  const adminFetch = createAdminFetch({
    env,
    context: async () => ({
      repo: repo as unknown as EmailRepository,
      transport: { name: 'log', send: vi.fn() },
    }),
  });
  return { adminFetch, repo };
}

describe('Email administrator request bindings', () => {
  it('keeps concurrent request actors separate and ignores forged administrator headers', async () => {
    const { adminFetch, repo } = setup();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    repo.findTemplateByKey.mockImplementation(async (key) => {
      if (key === 'slow') { entered(); await waiting; }
      return null;
    });
    const slow = adminFetch(request('slow'), owner);
    await started;
    try {
      const fast = await adminFetch(request('fast'), administrator);
      expect(fast.status).toBe(200);
      expect(repo.audit).toHaveBeenCalledWith({
        action: 'template.created', actorUserId: administrator.userId,
        actorRole: 'admin', details: { key: 'fast' },
      });
    } finally { release(); }
    expect((await slow).status).toBe(200);
    expect(repo.audit).toHaveBeenLastCalledWith({
      action: 'template.created', actorUserId: owner.userId,
      actorRole: 'owner', details: { key: 'slow' },
    });
  });

  it('refuses an omitted argument even if the request supplies administrator headers', async () => {
    const { adminFetch, repo } = setup();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // @ts-expect-error Exercise a JavaScript caller bypassing the required internal argument.
      const response = await adminFetch(request('forbidden'));
      expect(response.status).toBe(403);
      expect(repo.findTemplateByKey).not.toHaveBeenCalled();
      expect(repo.createTemplate).not.toHaveBeenCalled();
      expect(repo.audit).not.toHaveBeenCalled();
    } finally { logged.mockRestore(); }
  });
});
