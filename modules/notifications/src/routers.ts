import { idSchema, notificationEventTypeSchema, pageOf, paginationInputSchema } from '@template/shared/vocabulary';
import type { EmailInternalCaller } from '@template/email/contract';
import { verifiedAdmin, type AdminAwareContext } from '@template/shared';
import { initTRPC, TRPCError } from '@trpc/server';

import { z } from 'zod';

import type { EventRow, NotificationsRepository } from './repository.js';
import {
  EVENT_TEMPLATE_KEYS,
  notificationEventSchema,
  storedNotificationEventSchema,
  type NotificationEvent,
} from './schemas.js';

/** No `request` and no `resHeaders`: this surface is reached by a caller, never by a request. */
export interface InternalContext {
  repo: NotificationsRepository;
  /** Email's internal surface, built for this request by whoever assembled the context. */
  email: EmailInternalCaller;
}

export interface AdminRpcContext extends AdminAwareContext {
  repo: NotificationsRepository;
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
export function variablesOf(event: NotificationEvent): Record<string, string> {
  const variables: Record<string, string> = { email: event.recipient.email };
  for (const [key, value] of Object.entries(event.payload)) variables[key] = String(value);
  return variables;
}

// --- internal surface ---------------------------------------------------------------------------

const internalT = initTRPC.context<InternalContext>().create();

/**
 * Each router is constrained to exactly these names, which stops a procedure written into the wrong
 * surface: `emit` belongs to the internal router, and in a public one would let anyone forge
 * notifications.
 */
type InternalName = 'emit';
type AdminName = 'listEvents' | 'getEvent';

export const internalRouter = internalT.router({
  /**
   * Accepts one typed event and routes it to Email. The discriminated union rejects anything that is
   * not a known event type, so an unknown event never reaches storage, and `dedupeKey` makes a
   * repeated delivery harmless.
   */
  emit: internalT.procedure
    .input(z.object({ event: notificationEventSchema, dedupeKey: z.string().min(1).max(200) }))
    .output(z.object({ ok: z.literal(true), eventId: idSchema, deduplicated: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const { event, dedupeKey } = input;

      const { row, created } = await ctx.repo.accept(
        event.type,
        dedupeKey,
        event.recipient.email,
        event.payload,
      );

      if (!created) {
        return { ok: true as const, eventId: row.id, deduplicated: true };
      }

      const templateKey = EVENT_TEMPLATE_KEYS[event.type];

      try {
        /*
         * Email puts the deadline on its own caller, so an Email that hung cannot hang the event —
         * without that the `catch` below would never be reached.
         */
        const result = await ctx.email.send({
          templateKey,
          to: event.recipient.email,
          variables: variablesOf(event),
          // Email deduplicates on its own side too, so a retried routing cannot send twice.
          dedupeKey: `notification:${row.id}`,
        });

        /*
         * Email answers with the delivery it stored even when the transport refused it. Recording
         * that as `routed` would put a green row in the log for a message nobody received.
         */
        if (result.status === 'failed') {
          await ctx.repo.markFailed(row.id, 'Email accepted the message but could not send it.');
        } else {
          await ctx.repo.markRouted(row.id, result.deliveryId);
        }
      } catch (error) {
        // The event stays stored as `failed`, so the failure is visible in the service admin
        // instead of disappearing.
        await ctx.repo.markFailed(row.id, error instanceof Error ? error.message : String(error));
      }

      return { ok: true as const, eventId: row.id, deduplicated: false };
    }),
} satisfies Record<InternalName, unknown>);


// --- admin surface ------------------------------------------------------------------------------

const adminT = initTRPC.context<AdminRpcContext>().create();

/**
 * No admin operation here changes anything, so there is no `adminMutation`: an event is a record of
 * what happened, and a log that can be edited is not a record.
 */
const adminProcedure = adminT.procedure.use(({ ctx, next }) =>
  next({ ctx: { admin: verifiedAdmin(ctx) } }),
);

export const adminRouter = adminT.router({
  listEvents: adminProcedure
    .input(
      paginationInputSchema.extend({
        type: notificationEventTypeSchema.optional(),
        status: z.enum(['accepted', 'routed', 'failed']).optional(),
      }),
    )
    .output(pageOf(storedNotificationEventSchema))
    .query(async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.list(
        { query: input.query, type: input.type, status: input.status },
        input.limit,
        input.offset,
      );
      return { items: rows.map(toStored), total, limit: input.limit, offset: input.offset };
    }),

  getEvent: adminProcedure
    .input(z.object({ id: idSchema }))
    .output(z.object({ event: storedNotificationEventSchema }))
    .query(async ({ input, ctx }) => {
      const row = await ctx.repo.findById(input.id);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Событие не найдено' });
      return { event: toStored(row) };
    }),
} satisfies Record<AdminName, unknown>);


/** Calls the internal procedures directly, with their schemas and without a request. */
export const createInternalCallerFactory = internalT.createCallerFactory(internalRouter);

/** The browser client of this module's admin screen is typed from this, and from nothing else. */
export type NotificationsAdminRouter = typeof adminRouter;
