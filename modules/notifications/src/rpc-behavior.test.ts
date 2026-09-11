import type { NotificationEvent } from '@template/contracts/modules/notifications';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createModule } from './index.js';

const query = vi.hoisted(() => vi.fn());
vi.mock('./db/database.js', () => ({ createDatabase: () => async () => ({ query }) }));

const id = '00000000-0000-4000-8000-000000000001';
const env = {
  databaseUrl: 'postgres://unused/test_notifications',

};
const event: NotificationEvent = {
  type: 'auth.password.reset_requested', recipient: { identityId: id, email: 'person@example.com' },
  payload: { resetUrl: 'https://example.test/reset?token=secret' },
};

function request(eventId: string) {
  const url = new URL('https://example.test/admin/embed/module/notifications/rpc/getEvent');
  url.searchParams.set('input', JSON.stringify({ id: eventId }));
  return new Request(url, { headers: {
    'x-template-admin-user-id': id, 'x-template-admin-email': 'owner@example.com',
    'x-template-admin-role': 'owner',
  } });
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('Notifications RPC validation', () => {
  it('rejects malformed event delivery and lookup before storage or Email', async () => {
    const send = vi.fn();
    const module = createModule({ env, modules: { email: { send } } });
    await expect(module.internalCaller.emit({
      event: { ...event, recipient: { ...event.recipient, email: 'invalid' } }, dedupeKey: 'test',
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    const response = await module.adminFetch(request('invalid-id'));
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns event metadata without its private payload and refuses an unknown stored status', async () => {
    const module = createModule({ env, modules: { email: { send: vi.fn() } } });
    const row = {
      id, type: event.type, dedupe_key: 'test', recipient_email: event.recipient.email, payload: event.payload,
      status: 'accepted', error: null, delivery_id: null, created_at: new Date('2026-01-01T00:00:00Z'), routed_at: null,
    };
    query.mockResolvedValue({ rows: [row], rowCount: 1 });
    const response = await module.adminFetch(request(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { data: { event: {
      id, type: event.type, dedupeKey: 'test', recipientEmail: event.recipient.email, status: 'accepted',
      error: null, deliveryId: null, createdAt: '2026-01-01T00:00:00.000Z', routedAt: null,
    } } } });

    query.mockResolvedValue({ rows: [{ ...row, status: 'invented-status' }], rowCount: 1 });
    const invalid = await module.adminFetch(request(id));
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toMatchObject({ error: { message: 'Internal server error', data: { code: 'INTERNAL_SERVER_ERROR' } } });
  });
});
