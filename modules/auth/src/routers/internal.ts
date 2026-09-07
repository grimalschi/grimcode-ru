import { emailSchema, idSchema, okSchema } from '@template/shared/vocabulary';
import { z } from 'zod';
import { initTRPC } from '@trpc/server';

import { toIdentity, type AuthRepository } from '../repository.js';
import { identitySchema } from '../schemas.js';

/** No `request` and no `resHeaders`: this surface is reached by a caller, never by a request. */
export interface InternalContext {
  repo: AuthRepository;
}

/**
 * Reachable only on `/internal/rpc`, which Gateway never proxies, so these procedures stay inside
 * the Docker network. Admin depends on them to resolve the current user and to bootstrap the very
 * first owner.
 */
const t = initTRPC.context<InternalContext>().create();

/**
 * The internal surface, by name. Their arguments say why the mount matters — a session token, a list
 * of identity ids, an address to look up: every one assumes a caller that is already trusted.
 */
type InternalName =
  | 'resolveSession'
  | 'revokeSessionByToken'
  | 'getFirstIdentity'
  | 'getIdentitiesByIds'
  | 'searchIdentities'
  | 'getIdentityByEmail';

export const internalRouter = t.router({
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
} satisfies Record<InternalName, unknown>);


/** Calls the internal procedures directly, with their schemas and without a request. */
export const createInternalCallerFactory = t.createCallerFactory(internalRouter);
