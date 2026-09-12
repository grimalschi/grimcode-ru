import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import { idSchema, pageOf, paginationInputSchema } from '../primitives.js';
import type { NotificationEventType } from '@template/contracts/modules/notifications';
import { notificationEventTypeSchema } from '../vocabulary.js';
import type { AdminContext } from '@template/contracts/module-instance';
import type { EventRow, NotificationsRepository } from '../repository.js';
import { storedNotificationEventSchema } from '../schemas.js';

interface AdminRpcContext {
  adminContext: AdminContext;
  repo: NotificationsRepository;
}

function toStored(row: EventRow) {
  return {
    id: row.id,
    type: row.type as NotificationEventType,
    dedupeKey: row.dedupe_key,
    recipientEmail: row.recipient_email,
    status: row.status,
    error: row.error,
    deliveryId: row.delivery_id,
    createdAt: row.created_at.toISOString(),
    routedAt: row.routed_at?.toISOString() ?? null,
  };
}

const adminT = initTRPC.context<AdminRpcContext>().create({
  errorFormatter({ shape, error }) {
    return error.code === 'INTERNAL_SERVER_ERROR'
      ? { ...shape, message: 'Internal server error', data: { ...shape.data, stack: undefined } }
      : shape;
  },
});

const adminProcedure = adminT.procedure.use(({ ctx, next }) => {
  if (!ctx.adminContext)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Контекст администратора отсутствует' });
  return next({ ctx: { adminContext: ctx.adminContext } });
});

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
});

/** The browser client of this module's admin screen is typed from this, and from nothing else. */
export type NotificationsAdminRouter = typeof adminRouter;
