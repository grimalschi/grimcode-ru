import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { authorize } from '../authorization.js';
import { adminTargetSchema } from '../vocabulary.js';
import { authorizationResultSchema } from '../schemas.js';
import type { ModuleContext } from '../context.js';

const internalT = initTRPC.context<ModuleContext>().create();

export const internalRouter = internalT.router({
  /**
   * A query, because from Router's side it is a question asked on every `/admin/**` request. It can
   * write once — the first call bootstraps the owner from Auth's first account when the registry is
   * empty — and that is the exception the registry exists to make.
   */
  authorize: internalT.procedure
    .input(
      z.object({
        sessionToken: z.string().min(1).max(400).nullable(),
        /** What is being opened; Router works it out from the URL. */
        target: adminTargetSchema,
      }),
    )
    .output(authorizationResultSchema)
    .query(({ input, ctx }) => authorize(input, ctx)),
});
