import { describe, expect, it, vi } from 'vitest';

import { adminRouter } from './admin/router.js';
import type { Pool } from './db/database.js';
import { EmailRepository } from './repository.js';
import type { Transport } from './transport.js';

/*
 * A change and its audit entry commit together. The pool here is a recorder: it hands out one
 * connection per transaction and keeps every statement in order, so a test can read where BEGIN,
 * the change, the audit and COMMIT fell — and where the transport ran relative to them.
 */
const id = '00000000-0000-4000-8000-000000000001';
const stamp = new Date('2026-01-01T00:00:00Z');
const template = { id, key: 'welcome', name: 'Welcome', description: null, variables: [] as string[], created_at: stamp, updated_at: stamp };
const mjml = '<mjml><mj-body><mj-section><mj-column><mj-text>Body</mj-text></mj-column></mj-section></mj-body></mjml>';
const draft = {
  id, template_id: id, version: 1, status: 'draft', subject: 'Subject', source: mjml,
  compiled_html: null, compiled_text: null, published_at: null, created_at: stamp, updated_at: stamp,
};
const published = { ...draft, status: 'published', compiled_html: '<p>Body</p>', compiled_text: 'Body', published_at: stamp };

function recorder(options: { auditFails?: boolean; versionStatus?: 'draft' | 'published' } = {}) {
  /** Statements in order, tagged with where they ran: `pool`, `tx<n>` or `transport`. */
  const statements: { on: string; text: string }[] = [];
  let transactions = 0;
  const answer = (text: string) => {
    if (options.auditFails && text.includes('INSERT INTO email_audit')) throw new Error('audit storage refused');
    if (text.includes('WHERE key = $1')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM templates') || text.includes('INSERT INTO templates')) return { rows: [template], rowCount: 1 };
    if (text.includes("SET status = 'published'")) return { rows: [published], rowCount: 1 };
    if (text.includes('SET subject = $2')) return { rows: [{ ...draft, subject: 'Changed' }], rowCount: 1 };
    if (options.versionStatus === 'published' && text.includes("status = 'draft' FOR UPDATE")) return { rows: [], rowCount: 0 };
    if (text.includes('FROM template_versions')) {
      return { rows: [options.versionStatus === 'published' ? published : draft], rowCount: 1 };
    }
    if (text.includes('INSERT INTO deliveries')) {
      return { rows: [{ id, dedupe_key: 'test', template_key: 'welcome', template_version_id: id, recipient_email: 'a@example.test',
        subject: 'Subject', html: '<p>Body</p>', text: 'Body', transport: 'log', status: 'queued', provider_message_id: null,
        provider_status: null, error: null, created_at: stamp, sent_at: null }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const pool = {
    query: vi.fn(async (text: string) => { statements.push({ on: 'pool', text }); return answer(text); }),
    connect: vi.fn(async () => {
      const name = `tx${++transactions}`;
      return {
        query: async (text: string) => { statements.push({ on: name, text }); return answer(text); },
        release: vi.fn(),
      };
    }),
  } as unknown as Pool;
  const transport = {
    name: 'log' as const,
    send: vi.fn(async () => { statements.push({ on: 'transport', text: 'SEND' }); return { providerMessageId: null, providerStatus: 'logged' }; }),
  };
  const api = adminRouter.createCaller({
    repo: new EmailRepository(pool), transport: transport as unknown as Transport,
    adminContext: { userId: id, email: 'owner@example.test', role: 'owner' },
    env: { csrfCookieName: 'csrf_email' },
    request: new Request('https://example.test/', { headers: { cookie: 'csrf_email=token', 'x-csrf-token': 'token' } }),
  });
  return { api, statements, transport };
}

/** The statements of one connection, reduced to what they do. */
function on(statements: { on: string; text: string }[], name: string): string[] {
  return statements.filter((entry) => entry.on === name).map(({ text }) => text.trim().split(/\s+/).slice(0, 3).join(' '));
}

describe('a template change and its audit entry share one transaction', () => {
  it('creates the template and its audit entry between one BEGIN and one COMMIT', async () => {
    const { api, statements } = recorder();
    await api.createTemplate({ key: 'welcome', name: 'Welcome', description: null, variables: [] });
    const inside = on(statements, 'tx1');
    expect(inside[0]).toBe('BEGIN');
    expect(inside.at(-1)).toBe('COMMIT');
    expect(inside).toEqual(expect.arrayContaining(['INSERT INTO templates', 'INSERT INTO email_audit']));
    expect(on(statements, 'pool')).toEqual(['SELECT id, key,']);
  });

  it('rolls the template back when the audit entry cannot be written', async () => {
    const { api, statements } = recorder({ auditFails: true });
    await expect(api.createTemplate({ key: 'welcome', name: 'Welcome', description: null, variables: [] }))
      .rejects.toThrow('audit storage refused');
    const inside = on(statements, 'tx1');
    expect(inside).toContain('INSERT INTO templates');
    expect(inside.at(-1)).toBe('ROLLBACK');
    expect(inside).not.toContain('COMMIT');
  });

  it('publishes a draft and records it in the one transaction the repository already opens', async () => {
    const { api, statements } = recorder();
    await api.publishDraft({ id });
    const inside = on(statements, 'tx1');
    expect(inside[0]).toBe('BEGIN');
    expect(inside.at(-1)).toBe('COMMIT');
    expect(inside.filter((text) => text === 'BEGIN')).toHaveLength(1);
    expect(inside).toEqual(expect.arrayContaining(['UPDATE template_versions SET', 'INSERT INTO email_audit']));
    expect(statements.some((entry) => entry.on === 'tx2')).toBe(false);
  });

  it('leaves no published version behind when the publication audit fails', async () => {
    const { api, statements } = recorder({ auditFails: true });
    await expect(api.publishDraft({ id })).rejects.toThrow('audit storage refused');
    const inside = on(statements, 'tx1');
    expect(inside).toContain('UPDATE template_versions SET');
    expect(inside.at(-1)).toBe('ROLLBACK');
  });

  it('records a test send as a decision before the transport runs, together with the delivery row', async () => {
    const { api, statements, transport } = recorder({ versionStatus: 'published' });
    await api.testSend({ id, to: 'a@example.test', variables: {} });
    const inside = on(statements, 'tx1');
    expect(inside[0]).toBe('BEGIN');
    expect(inside.at(-1)).toBe('COMMIT');
    expect(inside).toEqual(expect.arrayContaining(['INSERT INTO deliveries', 'INSERT INTO email_audit']));
    // Committed first, then the transport, then the outcome on the delivery row outside the transaction.
    const order = statements.map((entry) => entry.on === 'transport' ? 'SEND' : entry.on === 'pool' && /UPDATE deliveries/.test(entry.text) ? 'MARK' : entry.text.trim() === 'COMMIT' ? 'COMMIT' : null).filter(Boolean);
    expect(order).toEqual(['COMMIT', 'SEND', 'MARK']);
    expect(transport.send).toHaveBeenCalledOnce();
  });

  it('sends nothing when the test-send audit entry cannot be written', async () => {
    const { api, statements, transport } = recorder({ auditFails: true, versionStatus: 'published' });
    await expect(api.testSend({ id, to: 'a@example.test', variables: {} })).rejects.toThrow('audit storage refused');
    expect(on(statements, 'tx1').at(-1)).toBe('ROLLBACK');
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('saves a changed draft and records it between one BEGIN and one COMMIT, the row locked first', async () => {
    const { api, statements } = recorder();
    await api.saveDraft({ id, subject: 'Changed', source: mjml });
    const inside = on(statements, 'tx1');
    expect(inside[0]).toBe('BEGIN');
    expect(inside.at(-1)).toBe('COMMIT');
    expect(inside.filter((text) => text === 'BEGIN')).toHaveLength(1);
    expect(statements.find((entry) => entry.on === 'tx1' && entry.text.includes('FROM template_versions'))?.text).toContain('FOR UPDATE');
    expect(inside.indexOf('UPDATE template_versions SET')).toBeLessThan(inside.indexOf('INSERT INTO email_audit'));
    expect(on(statements, 'pool')).toEqual([]);
  });

  it('writes nothing for a save identical to the stored draft', async () => {
    const { api, statements } = recorder();
    await api.saveDraft({ id, subject: 'Subject', source: mjml });
    const inside = on(statements, 'tx1');
    expect(inside).not.toContain('UPDATE template_versions SET');
    expect(inside).not.toContain('INSERT INTO email_audit');
    expect(inside.at(-1)).toBe('COMMIT');
  });

  it('keeps the old draft when the save cannot be recorded', async () => {
    const { api, statements } = recorder({ auditFails: true });
    await expect(api.saveDraft({ id, subject: 'Changed', source: mjml })).rejects.toThrow('audit storage refused');
    const inside = on(statements, 'tx1');
    expect(inside).toContain('UPDATE template_versions SET');
    expect(inside.at(-1)).toBe('ROLLBACK');
  });

  it('refuses a version that is no longer a draft without touching it', async () => {
    const { api, statements } = recorder({ versionStatus: 'published' });
    await expect(api.saveDraft({ id, subject: 'Changed', source: mjml })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const inside = on(statements, 'tx1');
    expect(inside).not.toContain('UPDATE template_versions SET');
    expect(inside).not.toContain('INSERT INTO email_audit');
  });
});
