import { z } from 'zod';

import { emailSchema, idSchema, isoDateTimeSchema } from './primitives.js';
import { NOTIFICATION_EVENT_TYPES } from './vocabulary.js';
import type { NotificationEventType } from '@template/contracts/modules/notifications';

const recipientSchema = z.object({
  identityId: idSchema,
  email: emailSchema,
});

export const notificationEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth.user.registered'),
    recipient: recipientSchema,
    payload: z.object({ verificationUrl: z.url() }),
  }),
  z.object({
    type: z.literal('auth.email.verification_requested'),
    recipient: recipientSchema,
    payload: z.object({ verificationUrl: z.url() }),
  }),
  z.object({
    type: z.literal('auth.password.reset_requested'),
    recipient: recipientSchema,
    payload: z.object({ resetUrl: z.url() }),
  }),
  z.object({
    type: z.literal('auth.email.change_requested'),
    recipient: recipientSchema,
    payload: z.object({ confirmUrl: z.url() }),
  }),
  z.object({
    type: z.literal('auth.email.changed'),
    recipient: recipientSchema,
    payload: z.object({ previousEmail: emailSchema }),
  }),
]);

/** Template key each event is routed to in Email. */
export const EVENT_TEMPLATE_KEYS: Record<NotificationEventType, string> = {
  'auth.user.registered': 'auth-welcome',
  'auth.email.verification_requested': 'auth-verify-email',
  'auth.password.reset_requested': 'auth-password-reset',
  'auth.email.change_requested': 'auth-confirm-email-change',
  'auth.email.changed': 'auth-email-changed',
};

export const storedNotificationEventSchema = z.object({
  id: idSchema,
  type: z.enum(NOTIFICATION_EVENT_TYPES),
  dedupeKey: z.string().min(1).max(200),
  recipientEmail: emailSchema,
  status: z.enum(['accepted', 'routed', 'failed']),
  error: z.string().max(1000).nullable(),
  deliveryId: idSchema.nullable(),
  createdAt: isoDateTimeSchema,
  routedAt: isoDateTimeSchema.nullable(),
});
