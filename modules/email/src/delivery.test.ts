import { describe, expect, it, vi } from 'vitest';
import { sendTemplate } from './delivery.js';
import type { EmailRepository } from './repository.js';
import type { Transport } from './transport.js';

function delivery() {
  const stored = {
    findDeliveryByDedupeKey: vi.fn().mockResolvedValue(null),
    findPublished: vi.fn().mockResolvedValue({
      id: 'version', subject: '{{resetUrl}}', compiled_html: '<p>{{resetUrl}}</p>', compiled_text: '{{resetUrl}}',
    }),
    openDelivery: vi.fn().mockResolvedValue({ row: { id: 'delivery', status: 'queued' }, created: true }),
    markSent: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
  const transport = { name: 'unisender', send: vi.fn().mockResolvedValue({ providerMessageId: 'accepted' }) };
  const deps = { repo: stored as unknown as EmailRepository, transport: transport as Transport };
  const input = {
    templateKey: 'auth-password-reset', to: 'a@example.com', dedupeKey: 'one',
    variables: { resetUrl: 'https://example.com/reset?token=PRIVATE_TOKEN' },
  };
  return { stored, transport, deps, input };
}

describe('delivery outcomes', () => {
  it.each([
    'https://example.com/reset?token=PRIVATE_TOKEN',
    'https://example.com/reset?lang=en&token=PRIVATE_TOKEN&next=profile#form',
  ])('redacts every snapshot while sending the real link: %s', async (resetUrl) => {
    const { stored, transport, deps, input } = delivery();
    input.variables.resetUrl = resetUrl;
    await sendTemplate(input, deps);
    const snapshot = stored.openDelivery.mock.calls[0]![0];
    for (const field of ['subject', 'html', 'text']) {
      expect(snapshot[field]).not.toContain('PRIVATE_TOKEN');
      expect(snapshot[field]).toContain('token=***');
    }
    const message = transport.send.mock.calls[0]![0];
    for (const field of ['subject', 'html', 'text']) {
      expect(message[field]).toContain('PRIVATE_TOKEN');
    }
    expect(message.subject).toBe(resetUrl);
    expect(message.text).toBe(resetUrl);
  });

  it('keeps an accepted delivery unresolved when the database cannot record acceptance', async () => {
    const { stored, transport, deps, input } = delivery();
    stored.markSent.mockRejectedValue(new Error('database disconnected'));
    await expect(sendTemplate(input, deps)).rejects.toThrow('database disconnected');
    expect(transport.send).toHaveBeenCalledOnce();
    expect(stored.markFailed).not.toHaveBeenCalled();
  });

  it('records a transport rejection as failed', async () => {
    const { stored, transport, deps, input } = delivery();
    transport.send.mockRejectedValue(new Error('recipient rejected'));
    await expect(sendTemplate(input, deps)).resolves.toMatchObject({ status: 'failed' });
    expect(stored.markFailed).toHaveBeenCalledWith('delivery', 'recipient rejected');
    expect(stored.markSent).not.toHaveBeenCalled();
  });
});
