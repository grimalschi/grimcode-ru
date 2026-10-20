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
    saveDraft: vi.fn<EmailRepository['saveDraft']>(),
    listAudit: vi.fn<EmailRepository['listAudit']>(),
    withTransaction: (operation: (bound: unknown) => Promise<unknown>) => operation(repo),
  };
  const transport = { name: 'log', send: vi.fn().mockResolvedValue({ providerMessageId: null, providerStatus: 'logged' }) };
  const api = adminRouter.createCaller({
    repo: repo as unknown as EmailRepository, transport: transport as Transport,
    adminContext: { userId: id, email: 'owner@example.com', role: 'owner' },
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

  it('records a save that changed the draft, with the administrator\'s address, and stays silent otherwise', async () => {
    const { api, repo } = caller();
    const row = { id, template_id: id, version: 3, status: 'draft' as const, subject: 'Saved', source: mjml('Saved body'),
      compiled_html: null, compiled_text: null, published_at: null, created_at: new Date(), updated_at: new Date() };
    repo.saveDraft.mockResolvedValueOnce({ row, changed: false });
    await api.saveDraft({ id, subject: 'Saved', source: mjml('Saved body') });
    expect(repo.audit).not.toHaveBeenCalled();

    repo.saveDraft.mockResolvedValueOnce({ row, changed: true });
    await api.saveDraft({ id, subject: 'Saved', source: mjml('Changed body') });
    expect(repo.audit).toHaveBeenCalledExactlyOnceWith({
      action: 'version.draft.saved', actorUserId: id, actorRole: 'owner', actorEmail: 'owner@example.com',
      details: { templateKey: 'welcome', version: 3 },
    });
  });

  it('refuses to save a version that is not a draft and records nothing', async () => {
    const { api, repo } = caller();
    repo.saveDraft.mockResolvedValue(null);
    await expect(api.saveDraft({ id, subject: 'Saved', source: mjml('Body') }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Only a draft can be edited' });
    expect(repo.audit).not.toHaveBeenCalled();
  });

  it('lists the journal newest first as stored, an entry from before addresses with none', async () => {
    const { api, repo } = caller();
    const at = new Date('2026-10-15T10:00:00Z');
    repo.listAudit.mockResolvedValue({ total: 2, rows: [
      { id, action: 'version.published', actor_user_id: id, actor_role: 'admin', actor_email: 'admin@example.com',
        details: { templateKey: 'welcome', version: 2 }, created_at: at },
      { id, action: 'template.created', actor_user_id: id, actor_role: 'owner', actor_email: null, details: null, created_at: at },
    ] });
    const page = await api.listAudit({ limit: 50, offset: 0 });
    expect(repo.listAudit).toHaveBeenCalledWith(undefined, 50, 0);
    expect(page).toEqual({ total: 2, limit: 50, offset: 0, items: [
      { id, action: 'version.published', actorUserId: id, actorRole: 'admin', actorEmail: 'admin@example.com',
        details: { templateKey: 'welcome', version: 2 }, createdAt: at.toISOString() },
      { id, action: 'template.created', actorUserId: id, actorRole: 'owner', actorEmail: null, details: {}, createdAt: at.toISOString() },
    ] });
  });
});
