import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
  emailSchema,
  idSchema,
  isoDateTimeSchema,
  localeSchema,
  pageOf,
  paginationInputSchema,
} from './common.js';

/**
 * Notifications accepts only these known typed events. Anything else is rejected before it can
 * reach Email. The template ships the base auth events needed for registration, email
 * verification, recovery and email change.
 */
export const NOTIFICATION_EVENT_TYPES = [
  'auth.user.registered',
  'auth.email.verification_requested',
  'auth.password.reset_requested',
  'auth.email.change_requested',
  'auth.email.changed',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

const recipientSchema = z.object({
  identityId: idSchema,
  email: emailSchema,
  locale: localeSchema.default('en'),
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

export type NotificationEvent = z.infer<typeof notificationEventSchema>;

/**
 * Whether an event may be turned off by the person receiving it.
 *
 * `account` messages are about the account itself — confirming an address, recovering a password,
 * being told the address changed. They are always sent: a person who could switch off the notice
 * that their email was changed would lose the one signal that someone else took their account.
 *
 * `product` messages are everything a product decides to say. They are sent only to people whose
 * `productEmails` preference allows it.
 *
 * Every event the template ships is `account`. The first product message a project adds is governed
 * by this the moment it is listed here, without touching Notifications.
 */
export const NOTIFICATION_EVENT_CATEGORY: Record<NotificationEventType, 'account' | 'product'> = {
  'auth.user.registered': 'account',
  'auth.email.verification_requested': 'account',
  'auth.password.reset_requested': 'account',
  'auth.email.change_requested': 'account',
  'auth.email.changed': 'account',
};

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
  /** `suppressed` means the recipient's preferences told Notifications not to send this. */
  status: z.enum(['accepted', 'routed', 'failed', 'suppressed']),
  error: z.string().max(1000).nullable(),
  deliveryId: idSchema.nullable(),
  createdAt: isoDateTimeSchema,
  routedAt: isoDateTimeSchema.nullable(),
});

export const notificationsInternalContract = {
  /**
   * Accepts one typed event. `dedupeKey` makes repeated delivery of the same event harmless:
   * the second call reports the original event instead of routing it again.
   */
  emit: oc
    .input(z.object({ event: notificationEventSchema, dedupeKey: z.string().min(1).max(200) }))
    .output(
      z.object({
        ok: z.literal(true),
        eventId: idSchema,
        deduplicated: z.boolean(),
      }),
    ),
};

export const notificationsAdminContract = {
  listEvents: oc
    .input(
      paginationInputSchema.extend({
        type: z.enum(NOTIFICATION_EVENT_TYPES).optional(),
        status: z.enum(['accepted', 'routed', 'failed', 'suppressed']).optional(),
      }),
    )
    .output(pageOf(storedNotificationEventSchema)),

  getEvent: oc
    .input(z.object({ id: idSchema }))
    .output(z.object({ event: storedNotificationEventSchema })),
};

export const notificationsContract = {
  internal: notificationsInternalContract,
  admin: notificationsAdminContract,
};
