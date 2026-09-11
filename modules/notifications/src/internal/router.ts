import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import type { EmailApi } from '@template/contracts/modules/email';
import { idSchema } from '../primitives.js';
import type { NotificationsRepository } from '../repository.js';
import type { NotificationEvent } from '@template/contracts/modules/notifications';
import { EVENT_TEMPLATE_KEYS, notificationEventSchema } from '../schemas.js';

export interface InternalContext {
  repo: NotificationsRepository;
  email: EmailApi;
}

/** Variables handed to the email template. Only the event's own payload is exposed. */
export function variablesOf(event: NotificationEvent): Record<string, string> {
  const variables: Record<string, string> = { email: event.recipient.email };
  for (const [key, value] of Object.entries(event.payload)) variables[key] = String(value);
  return variables;
}

const internalT = initTRPC.context<InternalContext>().create();
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
        // The event stays stored as `failed`, so the failure is visible in the module admin
        // instead of disappearing.
        await ctx.repo.markFailed(row.id, error instanceof Error ? error.message : String(error));
      }

      return { ok: true as const, eventId: row.id, deduplicated: false };
    }),
});
