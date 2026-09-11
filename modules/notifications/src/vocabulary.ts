import { z } from 'zod';

/** Notifications owns the accepted event names; neighbours receive their types through contract. */
export const NOTIFICATION_EVENT_TYPES = [
  'auth.user.registered',
  'auth.email.verification_requested',
  'auth.password.reset_requested',
  'auth.email.change_requested',
  'auth.email.changed',
] as const;

export const notificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);
