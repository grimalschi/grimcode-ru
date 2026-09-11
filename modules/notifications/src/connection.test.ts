import type { EmailApi } from '@template/contracts/modules/email';
import type { NotificationEvent } from '@template/contracts/modules/notifications';
import { describe, expect, it, vi } from 'vitest';

import { createModule } from './index.js';

const { database, query } = vi.hoisted(() => {
  const query = vi.fn(async (sql: string, params?: unknown[]) => ({
    rows: sql.includes('INSERT INTO events') ? [{ id: params?.[0] }] : [],
  }));
  return { query, database: vi.fn(async () => ({ query })) };
});
vi.mock('./db/database.js', () => ({ createDatabase: () => database }));

const env = {
  databaseUrl: 'postgres://unused/test_notifications',

};
const event: NotificationEvent = {
  type: 'auth.password.reset_requested',
  recipient: { identityId: '00000000-0000-4000-8000-000000000001', email: 'user@example.com' },
  payload: { resetUrl: 'https://example.com/reset?token=one' },
};

describe('direct module caller dependencies', () => {
  it('keeps storage lazy and concurrent inputs separate on the same ready caller', async () => {
    let releaseFirst!: () => void;
    const firstDelivery = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const send = vi.fn<EmailApi['send']>().mockImplementation(async ({ to }) => {
      if (to === 'first@example.com') await firstDelivery;
      return {
        ok: true,
        deliveryId: to === 'first@example.com'
          ? '00000000-0000-4000-8000-000000000003'
          : '00000000-0000-4000-8000-000000000004',
        deduplicated: false,
        status: 'sent',
      };
    });
    const module = createModule({ env, modules: { email: { send } } });
    const caller = module.internalCaller;
    expect(caller.emit).toBeTypeOf('function');
    expect(send).not.toHaveBeenCalled();
    expect(database).not.toHaveBeenCalled();

    const first = caller.emit({
      event: { ...event, recipient: { ...event.recipient, email: 'first@example.com' } },
      dedupeKey: 'first',
    });
    const secondResult = await caller.emit({
      event: {
        ...event,
        recipient: { ...event.recipient, email: 'second@example.com' },
        payload: { resetUrl: 'https://example.com/reset?token=two' },
      },
      dedupeKey: 'second',
    }).finally(releaseFirst);
    const firstResult = await first;

    expect(firstResult.eventId).not.toBe(secondResult.eventId);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({
      templateKey: 'auth-password-reset',
      to: 'first@example.com',
      variables: { email: 'first@example.com', resetUrl: event.payload.resetUrl },
      dedupeKey: `notification:${firstResult.eventId}`,
    });
    expect(send).toHaveBeenCalledWith({
      templateKey: 'auth-password-reset',
      to: 'second@example.com',
      variables: { email: 'second@example.com', resetUrl: 'https://example.com/reset?token=two' },
      dedupeKey: `notification:${secondResult.eventId}`,
    });
    const routed = query.mock.calls.filter(([sql]) => sql.includes("status = 'routed'"));
    expect(routed.map(([, params]) => params)).toEqual([
      [secondResult.eventId, '00000000-0000-4000-8000-000000000004'],
      [firstResult.eventId, '00000000-0000-4000-8000-000000000003'],
    ]);
    expect(database).toHaveBeenCalledTimes(2);
    expect(database).toHaveBeenCalledWith();
  });
});
