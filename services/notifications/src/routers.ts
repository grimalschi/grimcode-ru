import { ORPCError } from '@orpc/client';
import { implement } from '@orpc/server';
import {
  EVENT_TEMPLATE_KEYS,
  notificationsAdminContract,
  notificationsInternalContract,
  type AdminContext,
  type ContractRouterClient,
  type emailInternalContract,
  type NotificationEvent,
} from '@template/contracts';
import { createRpcClient, internalServiceUrl, REQUEST_ID_HEADER, type Logger } from '@template/shared';

import type { EventRow, NotificationsRepository } from './repository.js';

type EmailClient = ContractRouterClient<typeof emailInternalContract>;

export interface InternalContext {
  repo: NotificationsRepository;
  logger: Logger;
  requestId: string;
}

export interface AdminRpcContext {
  repo: NotificationsRepository;
  admin: AdminContext | null;
}

function toStored(row: EventRow) {
  return {
    id: row.id,
    type: row.type as keyof typeof EVENT_TEMPLATE_KEYS,
    dedupeKey: row.dedupe_key,
    recipientEmail: row.recipient_email,
    status: row.status,
    error: row.error,
    deliveryId: row.delivery_id,
    createdAt: row.created_at.toISOString(),
    routedAt: row.routed_at?.toISOString() ?? null,
  };
}

/** Variables handed to the email template. Only the event's own payload is exposed. */
function variablesOf(event: NotificationEvent): Record<string, string> {
  const variables: Record<string, string> = { email: event.recipient.email };
  for (const [key, value] of Object.entries(event.payload)) variables[key] = String(value);
  return variables;
}

const internalOs = implement(notificationsInternalContract).$context<InternalContext>();

export const internalRouter = internalOs.router({
  /**
   * Accepts one typed event and routes it to Email.
   *
   * The contract's discriminated union already rejects anything that is not a known event type,
   * so an unknown event never reaches storage. `dedupeKey` makes a repeated delivery harmless.
   */
  emit: internalOs.emit.handler(async ({ input, context }) => {
    const { event, dedupeKey } = input;

    const { row, created } = await context.repo.accept(
      event.type,
      dedupeKey,
      event.recipient.email,
      event.payload,
    );

    if (!created) {
      context.logger.info('event already accepted, not routed again', { dedupeKey });
      return { ok: true as const, eventId: row.id, deduplicated: true };
    }

    const templateKey = EVENT_TEMPLATE_KEYS[event.type];

    try {
      const email = createRpcClient<EmailClient>({
        url: `${internalServiceUrl('email')}/internal/rpc`,
        headers: { [REQUEST_ID_HEADER]: context.requestId },
      });

      const result = await email.send({
        templateKey,
        locale: event.recipient.locale,
        to: event.recipient.email,
        variables: variablesOf(event),
        // Email deduplicates on its own side too, so a retried routing cannot send twice.
        dedupeKey: `notification:${row.id}`,
      });

      await context.repo.markRouted(row.id, result.deliveryId);
    } catch (error) {
      // The event stays stored as `failed`, so the failure is visible in the service admin
      // instead of disappearing.
      await context.repo.markFailed(row.id, error instanceof Error ? error.message : String(error));
      context.logger.error('event could not be routed to email', { type: event.type, error });
    }

    return { ok: true as const, eventId: row.id, deduplicated: false };
  }),
});

const adminOs = implement(notificationsAdminContract).$context<AdminRpcContext>();

function requireAdmin(context: AdminRpcContext): AdminContext {
  if (!context.admin) throw new ORPCError('FORBIDDEN', { message: 'Administrator context missing' });
  return context.admin;
}

export const adminRouter = adminOs.router({
  listEvents: adminOs.listEvents.handler(async ({ input, context }) => {
    requireAdmin(context);
    const { rows, total } = await context.repo.list(
      { query: input.query, type: input.type, status: input.status },
      input.limit,
      input.offset,
    );
    return { items: rows.map(toStored), total, limit: input.limit, offset: input.offset };
  }),

  getEvent: adminOs.getEvent.handler(async ({ input, context }) => {
    requireAdmin(context);
    const row = await context.repo.findById(input.id);
    if (!row) throw new ORPCError('NOT_FOUND', { message: 'Event not found' });
    return { event: toStored(row) };
  }),
});
