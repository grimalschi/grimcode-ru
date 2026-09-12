import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

const { query, send } = vi.hoisted(() => ({ query: vi.fn(), send: vi.fn() }));
vi.mock('./db/database.js', () => ({ createDatabase: () => async () => ({ query }) }));
vi.mock('./transport.js', () => ({ createTransport: () => ({ name: 'log', send }) }));

const id = '00000000-0000-4000-8000-000000000001';
const adminContext = { userId: '00000000-0000-4000-8000-000000000001', email: 'owner@example.com', role: 'owner' as const };
const env = {
  databaseUrl: 'postgres://unused/test_email',
  csrfCookieName: 'email_csrf', mail: { provider: 'log', apiKey: '', apiUrl: '', fromAddress: '', fromName: '' },
};

function request(procedure: string, input: unknown, token: string | null = 'csrf-value') {
  const headers = new Headers({
    'content-type': 'application/json', cookie: 'email_csrf=csrf-value',
  });
  if (token !== null) headers.set('x-csrf-token', token);
  return new Request(`https://example.test/admin/embed/module/email/rpc/${procedure}`, {
    method: 'POST', headers, body: JSON.stringify(input),
  });
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  send.mockReset();
});

describe('Email RPC boundaries', () => {
  it('logs the procedure and original cause when a request fails', async () => {
    const cause = new Error('соединение с базой не открылось');
    query.mockRejectedValue(cause);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await createModule({ env }).adminFetch(request('listTemplates', {}), adminContext);
      expect(response.status).toBe(500);
      expect(logged).toHaveBeenCalledWith(
        'procedure failed: listTemplates (query, INTERNAL_SERVER_ERROR)', cause,
      );
    } finally {
      logged.mockRestore();
    }
  });

  it.each([
    { procedure: 'createTemplate', input: { key: 'welcome', name: 'Welcome', description: null, variables: [] } },
    { procedure: 'updateTemplate', input: { id, name: 'Welcome' } },
    { procedure: 'createDraft', input: { templateId: id } },
    { procedure: 'saveDraft', input: { id, subject: 'Welcome', source: '<mjml><mj-body /></mjml>' } },
    { procedure: 'publishDraft', input: { id } },
    { procedure: 'testSend', input: { id, to: 'person@example.com', variables: {} } },
  ])('$procedure refuses missing or mismatched CSRF before storage or delivery', async ({ procedure, input }) => {
    const module = createModule({ env });
    for (const token of [null, 'different-token']) {
      const response = await module.adminFetch(request(procedure, input, token), adminContext);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('CSRF') } });
      expect(query).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('rejects malformed editor and delivery inputs before storage or transport', async () => {
    const module = createModule({ env });
    const response = await module.adminFetch(request('saveDraft', { id, subject: 'Welcome', source: { type: 'doc' } }), adminContext);
    expect(response.status).toBe(400);
    await expect(module.internalCaller.send({ templateKey: 'welcome', to: 'invalid', variables: {}, dedupeKey: 'test' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(query).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns a delivery acknowledgement without stored content and rejects an invalid stored status', async () => {
    query.mockResolvedValue({ rows: [{ id, status: 'sent', html: 'private message', text: 'private message' }], rowCount: 1 });
    const { internalCaller } = createModule({ env });
    const input = { templateKey: 'welcome', to: 'person@example.com', variables: {}, dedupeKey: 'already-sent' };
    await expect(internalCaller.send(input)).resolves.toEqual({ ok: true, deliveryId: id, deduplicated: true, status: 'sent' });
    expect(send).not.toHaveBeenCalled();

    query.mockResolvedValue({ rows: [{ id, status: 'invented-status' }], rowCount: 1 });
    await expect(internalCaller.send(input))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Output validation failed' });
    expect(send).not.toHaveBeenCalled();
  });
});
