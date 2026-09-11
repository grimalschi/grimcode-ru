import { emailSchema, idSchema, okSchema } from '../primitives.js';
import { z } from 'zod';
import { initTRPC, TRPCError } from '@trpc/server';

import { toIdentity, type AuthRepository } from '../repository.js';
import { identitySchema } from '../schemas.js';

/** No `request` and no `resHeaders`: this surface is reached by a caller, never by a request. */
export interface InternalContext {
  repo: AuthRepository;
}

/**
 * Called directly through the module capability; no HTTP route exposes these procedures.
 * Admin uses them to resolve the current user and bootstrap the first owner.
 */
const t = initTRPC.context<InternalContext>().create();

export const internalRouter = t.router({
  setIdentityBlocked: t.procedure
    .input(z.object({ userId: idSchema, blocked: z.boolean() }))
    .output(okSchema)
    .mutation(async ({ input, ctx }) => {
      if (!await ctx.repo.setBlocked(input.userId, input.blocked)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
      }
      return { ok: true as const };
    }),

  resolveSession: t.procedure
    .input(z.object({ sessionToken: z.string().min(1).max(400) }))
    .output(z.object({ identity: identitySchema.nullable() }))
    .query(
    async ({ input, ctx }) => {
      const resolved = await ctx.repo.resolveSession(input.sessionToken);
      // A blocked identity has no usable session, even if the row itself has not expired yet.
      if (!resolved || resolved.identity.blocked_at !== null) return { identity: null };
      return { identity: toIdentity(resolved.identity) };
    },
  ),

  /**
   * The same revocation the public `logout` performs, without the cookie: whoever calls this owns
   * the response the browser sees and clears the cookie there.
   */
  revokeSessionByToken: t.procedure
    .input(z.object({ sessionToken: z.string().min(1).max(400) }))
    .output(okSchema)
    .mutation(async ({ input, ctx }) => {
    await ctx.repo.revokeSessionByToken(input.sessionToken);
    return { ok: true as const };
  }),

  getFirstIdentity: t.procedure
    .input(z.object({}))
    .output(z.object({ identity: identitySchema.nullable() }))
    .query(
    async ({ ctx }) => {
      const row = await ctx.repo.findFirstIdentity();
      return { identity: row ? toIdentity(row) : null };
    },
  ),

  getIdentitiesByIds: t.procedure
    .input(z.object({ ids: z.array(idSchema).max(200) }))
    .output(z.object({ identities: z.array(identitySchema) }))
    .query(
    async ({ input, ctx }) => {
      const rows = await ctx.repo.findIdentitiesByIds(input.ids);
      return { identities: rows.map(toIdentity) };
    },
  ),

  searchIdentities: t.procedure
    .input(z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(20).default(10),
    }))
    .output(z.object({ identities: z.array(identitySchema) }))
    .query(
    async ({ input, ctx }) => {
      const rows = await ctx.repo.searchIdentities(input.query, input.limit);
      return { identities: rows.map(toIdentity) };
    },
  ),

  getIdentityByEmail: t.procedure
    .input(z.object({ email: emailSchema }))
    .output(z.object({ identity: identitySchema.nullable() }))
    .query(
    async ({ input, ctx }) => {
      const row = await ctx.repo.findIdentityByEmail(input.email);
      return { identity: row ? toIdentity(row) : null };
    },
  ),
});
