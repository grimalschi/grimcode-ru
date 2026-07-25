import { describe, expect, it } from 'vitest';

import { authorizationResultSchema } from './admin.js';
import {
  ADMIN_SERVICE_IDS,
  ASSIGNABLE_SERVICE_IDS,
  SERVICE_IDS,
  adminContextSchema,
  assignableServiceIdSchema,
  paginationInputSchema,
} from './common.js';
import { editorDocumentSchema, EDITOR_FORMAT, editorFormatSchema } from './email.js';
import { EVENT_TEMPLATE_KEYS, NOTIFICATION_EVENT_TYPES, notificationEventSchema } from './notifications.js';

describe('service ids', () => {
  it('keeps every admin service inside the canonical service list', () => {
    for (const id of ADMIN_SERVICE_IDS) {
      expect(SERVICE_IDS).toContain(id);
    }
  });

  it('never lets an owner grant Adminer to a regular administrator', () => {
    expect(ASSIGNABLE_SERVICE_IDS).not.toContain('adminer' as never);
    expect(assignableServiceIdSchema.safeParse('adminer').success).toBe(false);
  });

  it('keeps assignable services a subset of admin services', () => {
    for (const id of ASSIGNABLE_SERVICE_IDS) {
      expect(ADMIN_SERVICE_IDS).toContain(id);
    }
  });
});

describe('admin context', () => {
  it('rejects a context without a request id', () => {
    const result = adminContextSchema.safeParse({
      userId: '00000000-0000-4000-8000-000000000000',
      email: 'owner@example.com',
      role: 'owner',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a complete verified context', () => {
    const result = adminContextSchema.safeParse({
      userId: '00000000-0000-4000-8000-000000000000',
      email: 'Owner@Example.com',
      role: 'owner',
      requestId: 'req-1',
    });
    expect(result.success).toBe(true);
    expect(result.data?.email).toBe('owner@example.com');
  });
});

describe('authorization result', () => {
  it('models denial reasons explicitly so Gateway never interprets an error', () => {
    expect(authorizationResultSchema.safeParse({ state: 'denied', reason: 'owner-only' }).success).toBe(
      true,
    );
    expect(authorizationResultSchema.safeParse({ state: 'denied' }).success).toBe(false);
    expect(authorizationResultSchema.safeParse({ state: 'awaiting-first-user' }).success).toBe(true);
  });
});

describe('pagination', () => {
  it('applies safe defaults and an upper bound', () => {
    expect(paginationInputSchema.parse({})).toEqual({ limit: 25, offset: 0 });
    expect(paginationInputSchema.safeParse({ limit: 1000 }).success).toBe(false);
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

  it('accepts a known event and defaults the locale', () => {
    const result = notificationEventSchema.safeParse({
      type: 'auth.password.reset_requested',
      recipient: { identityId: '00000000-0000-4000-8000-000000000000', email: 'a@example.com' },
      payload: { resetUrl: 'https://example.com/app/reset?token=abc' },
    });
    expect(result.success).toBe(true);
    expect(result.data?.recipient.locale).toBe('en');
  });
});

describe('email editor document', () => {
  it('pins the stored editor format marker', () => {
    expect(EDITOR_FORMAT).toBe('maily@1');
    expect(editorFormatSchema.safeParse('unlayer@1').success).toBe(false);
  });

  it('accepts an empty document', () => {
    expect(editorDocumentSchema.parse({ type: 'doc' })).toEqual({ type: 'doc', content: [] });
  });
});
