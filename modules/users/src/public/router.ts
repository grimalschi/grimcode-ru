import type { inferRouterInputs } from '@trpc/server';
import type { UsersPublicRouter as PublicContract } from '@template/contracts/modules/users';
import type { Identity } from '@template/contracts/modules/auth';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { RpcContext } from '../trpc/context.js';
import { userProfileSchema } from '../schemas.js';
import { toProfile, type UsersRepository } from '../repository.js';

export interface PublicContext extends RpcContext {
  repo: UsersRepository;
  /** Resolved through Auth on every call; `null` means no valid session. */
  identity: Identity | null;
}

const publicT = initTRPC.context<PublicContext>().create({
  errorFormatter({ shape, error }) {
    return error.code === 'INTERNAL_SERVER_ERROR'
      ? { ...shape, message: 'Internal server error', data: { ...shape.data, stack: undefined } }
      : shape;
  },
});

/**
 * A session is required, and this is where that requirement lives: the route guard in the SPA is for
 * the user flow, this is what actually protects the data.
 */
const withIdentity = publicT.procedure.use(({ ctx, next }) => {
  if (!ctx.identity) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Сессия не активна' });
  return next({ ctx: { identity: ctx.identity } });
});

export const publicRouter = publicT.router({
  /** Profile of the caller. Requires a valid user session, verified through Auth. */
  getOwnProfile: withIdentity
    .input(z.object({}))
    .output(z.object({ profile: userProfileSchema }))
    .query(async ({ ctx }) => {
      // The profile is created lazily on first access, so Auth never has to know about Users.
      return { profile: toProfile(await ctx.repo.ensure(ctx.identity.id)) };
    }),

  updateOwnProfile: withIdentity
    .input(z.object({ displayName: z.string().min(1).max(120).nullable() }))
    .output(z.object({ ok: z.literal(true), profile: userProfileSchema }))
    .mutation(async ({ input, ctx }) => {
      await ctx.repo.ensure(ctx.identity.id);
      const row = await ctx.repo.updateProfile(ctx.identity.id, input.displayName);
      return { ok: true as const, profile: toProfile(row) };
    }),
} satisfies PublicContract['_def']['record']) satisfies PublicContract<PublicContext>;

// Native router assignability permits narrower inputs; require the declared inputs to match.
export interface PublicInputsCheck extends inferRouterInputs<typeof publicRouter>, inferRouterInputs<PublicContract> {}
