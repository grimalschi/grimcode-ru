import { describe, expect, it, vi } from 'vitest';
import { adminRouter } from './router.js';
import type { EmailRepository } from '../repository.js';
import type { Transport } from '../transport.js';

const id = '00000000-0000-4000-8000-000000000001';

function mjml(body: string): string {
  return `<mjml><mj-body><mj-section><mj-column><mj-text>${body}</mj-text></mj-column></mj-section></mj-body></mjml>`;
}

function caller() {
  const repo = {
    findVersion: vi.fn().mockResolvedValue({ id, template_id: id, subject: 'Saved', source: mjml('Saved body'), compiled_html: null, compiled_text: null }),
    findTemplateById: vi.fn().mockResolvedValue({ id, key: 'welcome' }),
    openDelivery: vi.fn().mockResolvedValue({ row: { id } }),
    markSent: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    audit: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn<EmailRepository['publish']>(),
  };
  const transport = { name: 'log', send: vi.fn().mockResolvedValue({ providerMessageId: null, providerStatus: 'logged' }) };
  const api = adminRouter.createCaller({
    repo: repo as unknown as EmailRepository, transport: transport as Transport,
    admin: { userId: id, email: 'owner@example.com', role: 'owner' },
    env: { csrfCookieName: 'csrf_email' },
    request: new Request('https://example.com/', { headers: { cookie: 'csrf_email=token', 'x-csrf-token': 'token' } }),
  });
  return { api, repo, transport };
}

describe('Email administration', () => {
  it('previews the current draft without changing the saved version', async () => {
    const { api, repo } = caller();
    const preview = await api.previewVersion({ id, draft: {
      subject: 'Unsaved subject', source: mjml('Unsaved body'),
    } });
    expect(preview.subject).toBe('Unsaved subject');
    expect(preview.html).toContain('Unsaved body');
    expect(preview.text).toContain('Unsaved body');
    expect(repo.openDelivery).not.toHaveBeenCalled();
  });

  it('previews and test-sends the compiled snapshot of a published version', async () => {
    const { api, repo, transport } = caller();
    repo.findVersion.mockResolvedValue({
      id, template_id: id, status: 'published', subject: 'Hello {{name}}',
      source: 'source is not used for published content',
      compiled_html: '<p>Approved {{name}}</p>', compiled_text: 'Approved {{name}}',
    });
    const preview = await api.previewVersion({ id, variables: { name: 'Ada' } });
    expect(preview).toEqual({ subject: 'Hello Ada', html: '<p>Approved Ada</p>', text: 'Approved Ada' });
    await api.testSend({ id, to: 'a@example.com', variables: { name: 'Ada' } });
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining(preview));
  });

  it('refuses to preview, publish or send a raw HTML draft', async () => {
    const { api, repo, transport } = caller();
    const draft = {
      id, template_id: id, version: 1, status: 'draft' as const, subject: 'HTML draft',
      source: '<p>Plain HTML</p>', compiled_html: null, compiled_text: null,
      published_at: null, created_at: new Date(), updated_at: new Date(),
    };
    repo.findVersion.mockResolvedValue(draft);
    repo.publish.mockImplementation(async (_id, compile) => {
      await compile(draft, []);
      return draft;
    });
    for (const operation of [
      () => api.previewVersion({ id }),
      () => api.publishDraft({ id }),
      () => api.testSend({ id, to: 'a@example.com' }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('Invalid MJML') });
    }
    expect(repo.openDelivery).not.toHaveBeenCalled();
    expect(repo.audit).not.toHaveBeenCalled();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('reports a failed test send instead of returning success', async () => {
    const { api, repo, transport } = caller();
    transport.send.mockRejectedValue(new Error('provider rejected recipient'));
    await expect(api.testSend({ id, to: 'a@example.com' })).rejects.toMatchObject({ code: 'BAD_GATEWAY' });
    expect(repo.markFailed).toHaveBeenCalledWith(id, 'provider rejected recipient');
    expect(repo.markSent).not.toHaveBeenCalled();
  });

  it('does not mark an accepted test send failed if recording acceptance fails', async () => {
    const { api, repo, transport } = caller();
    repo.markSent.mockRejectedValue(new Error('connection lost'));
    await expect(api.testSend({ id, to: 'a@example.com' })).rejects.toThrow('connection lost');
    expect(transport.send).toHaveBeenCalledOnce();
    expect(repo.markFailed).not.toHaveBeenCalled();
  });
});
