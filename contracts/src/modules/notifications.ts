interface Recipient {
  identityId: string;
  email: string;
}

interface Event<Type, Payload> {
  type: Type;
  recipient: Recipient;
  payload: Payload;
}

/** Explicit discriminated union: providers validate exactly these event payloads. */
export type NotificationEvent =
  | Event<'auth.user.registered', { verificationUrl: string }>
  | Event<'auth.email.verification_requested', { verificationUrl: string }>
  | Event<'auth.password.reset_requested', { resetUrl: string }>
  | Event<'auth.email.change_requested', { confirmUrl: string }>
  | Event<'auth.email.changed', { previousEmail: string }>;

export type NotificationEventType = NotificationEvent['type'];

export interface StoredNotificationEvent {
  id: string;
  type: NotificationEventType;
  dedupeKey: string;
  recipientEmail: string;
  status: 'accepted' | 'routed' | 'failed';
  error: string | null;
  deliveryId: string | null;
  createdAt: string;
  routedAt: string | null;
}

export interface NotificationsApi {
  emit: (input: { event: NotificationEvent; dedupeKey: string }) => Promise<{
    ok: true;
    eventId: string;
    deduplicated: boolean;
  }>;
}
