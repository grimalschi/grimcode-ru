import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import { emailSchema, idSchema } from '../primitives.js';
import { deliveryStatusSchema } from '../schemas.js';
import { sendTemplate, UnknownTemplateError } from '../delivery.js';
import type { ModuleContext } from '../context.js';

const internalT = initTRPC.context<ModuleContext>().create();
export const internalRouter = internalT.router({
  send: internalT.procedure
    .input(
      z.object({
        templateKey: z.string().min(1).max(80),
        to: emailSchema,
        variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
        dedupeKey: z.string().min(1).max(200),
      }),
    )
    .output(
      z.object({
        ok: z.literal(true),
        deliveryId: idSchema,
        deduplicated: z.boolean(),
        status: deliveryStatusSchema,
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const result = await sendTemplate(input, ctx);
        return { ok: true as const, ...result };
      } catch (error) {
        if (error instanceof UnknownTemplateError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        throw error;
      }
    }),
});
