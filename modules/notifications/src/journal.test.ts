import { describe, expect, it, vi } from 'vitest';
import type { NotificationEvent } from '@template/contracts/modules/notifications';
import type { Pool } from './db/database.js';
import { internalRouter } from './internal/router.js';
import { NotificationsRepository } from './repository.js';
import { journalPayload } from './journal.js';

const id = '00000000-0000-4000-8000-000000000001';

describe('credential links in the event journal', () => {
  it.each([
    ['auth.user.registered', 'verificationUrl'],
    ['auth.email.verification_requested', 'verificationUrl'],
    ['auth.password.reset_requested', 'resetUrl'],
    ['auth.email.change_requested', 'confirmUrl'],
  ] as const)('stores no token for %s while Email receives the usable link', async (type, field) => {
    const link = 'https://example.test/confirm?lang=ru&token=private-token#form';
    const payload = Object.freeze({ [field]: link });
    const event = { type, recipient: { identityId: id, email: 'user@example.test' }, payload } as NotificationEvent;
    const query = vi.fn(async (sql: string, _params?: unknown[]) => ({ rows: sql.includes('INSERT INTO events') ? [{ id }] : [] }));
    const send = vi.fn(async () => ({ ok: true as const, deliveryId: id, deduplicated: false, status: 'sent' as const }));
    const caller = internalRouter.createCaller({ repo: new NotificationsRepository({ query } as unknown as Pool), email: { send } });

    await caller.emit({ event, dedupeKey: `test:${type}` });

    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO events'))!;
    const stored = String(insert[1]![4]);
    expect(stored).not.toContain('private-token');
    expect(JSON.parse(stored)).toEqual({ [field]: 'https://example.test/confirm?lang=ru&token=***#form' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ variables: { email: 'user@example.test', [field]: link } }));
    expect(payload[field]).toBe(link);
  });

  it('masks repeated and encoded token parameters and leaves non-secret fields unchanged', () => {
    expect(journalPayload({
      resetUrl: 'https://example.test/?%74oken=first&token=second&lang=ru',
      previousEmail: 'old@example.test',
    })).toEqual({ resetUrl: 'https://example.test/?token=***&lang=ru', previousEmail: 'old@example.test' });
  });
});
