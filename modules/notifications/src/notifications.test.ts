import { NOTIFICATION_EVENT_TYPES } from '@template/shared/vocabulary';

import { EVENT_TEMPLATE_KEYS, notificationEventSchema } from './schemas.js';
import { describe, expect, it } from 'vitest';

import { variablesOf } from './routers.js';

describe('event routing', () => {
  it('has a template for every accepted event type', () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(EVENT_TEMPLATE_KEYS[type]).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('template variables', () => {
  it('exposes the recipient address and the event payload, and nothing else', () => {
    const variables = variablesOf({
      type: 'auth.password.reset_requested',
      recipient: {
        identityId: '00000000-0000-4000-8000-000000000001',
        email: 'user@example.com',
      },
      payload: { resetUrl: 'https://example.com/app/reset-password?token=abc' },
    });

    expect(variables).toEqual({
      email: 'user@example.com',
      resetUrl: 'https://example.com/app/reset-password?token=abc',
    });
    // The identity id is internal routing data, not something a template may print.
    expect(variables).not.toHaveProperty('identityId');
  });
});

describe('notification events', () => {
  it('routes every known event type to a template key', () => {
    for (const type of NOTIFICATION_EVENT_TYPES) {
      expect(EVENT_TEMPLATE_KEYS[type]).toBeTruthy();
    }
  });

  it('rejects unknown event types', () => {
    const result = notificationEventSchema.safeParse({
      type: 'billing.invoice.paid',
      recipient: { identityId: '00000000-0000-4000-8000-000000000000', email: 'a@example.com' },
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it('accepts a known event', () => {
    const result = notificationEventSchema.safeParse({
      type: 'auth.password.reset_requested',
      recipient: { identityId: '00000000-0000-4000-8000-000000000000', email: 'a@example.com' },
      payload: { resetUrl: 'https://example.com/app/reset?token=abc' },
    });
    expect(result.success).toBe(true);
  });
});
