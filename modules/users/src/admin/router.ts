import type { AuthApi } from '@template/contracts/modules/auth';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';

import { idSchema, pageOf, paginationInputSchema } from '../primitives.js';
import { adminUserProfileSchema } from '../schemas.js';
import { toProfile, type ProfileRow, type UsersRepository } from '../repository.js';
import type { RpcContext } from '../trpc/context.js';
import type { AdminContext } from '../http/admin-context.js';

/**
 * Fills in the sign-in address for a page of profiles.
 *
 * Users does not store it, so it is fetched per request, in one call for the whole page. An id Auth
 * does not know stays `null`, which is how a profile left by a deleted account is visible as one.
 */
async function withEmails(rows: ProfileRow[], auth: AuthApi) {
  const profiles = rows.map((row) => ({ ...toProfile(row), email: null as string | null }));
  if (profiles.length === 0) return profiles;

  try {
    const { identities } = await auth.getIdentitiesByIds({
      ids: [...new Set(rows.map((row) => row.identity_id))],
    });

    const byId = new Map(identities.map((identity) => [identity.id, identity.email]));
    for (const profile of profiles) profile.email = byId.get(profile.identityId) ?? null;
  } catch (error) {
    console.error('Users could not load identity emails', error);
  }

  return profiles;
}

export interface AdminRpcContext extends RpcContext {
  admin: AdminContext | null;
  repo: UsersRepository;
  /** Ready Auth API; the profile list reads sign-in addresses through it. */
  auth: AuthApi;
}

const adminT = initTRPC.context<AdminRpcContext>().create({
  errorFormatter({ shape, error }) {
    return error.code === 'INTERNAL_SERVER_ERROR'
      ? { ...shape, message: 'Internal server error', data: { ...shape.data, stack: undefined } }
      : shape;
  },
});

const adminProcedure = adminT.procedure.use(({ ctx, next }) => {
  if (!ctx.admin) throw new TRPCError({ code: 'FORBIDDEN', message: 'Контекст администратора отсутствует' });
  return next({ ctx: { admin: ctx.admin } });
});

/**
 * Users has no admin operation that changes anything — a profile belongs to the person it describes
 * — so there is no `adminMutation` here.
 */
export const adminRouter = adminT.router({
  listProfiles: adminProcedure
    .input(paginationInputSchema)
    .output(pageOf(adminUserProfileSchema))
    .query(async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.list(input.query, input.limit, input.offset);
      return {
        items: await withEmails(rows, ctx.auth),
        total,
        limit: input.limit,
        offset: input.offset,
      };
    }),

  getProfile: adminProcedure
    .input(z.object({ id: idSchema }))
    .output(z.object({ profile: adminUserProfileSchema }))
    .query(async ({ input, ctx }) => {
      const row = await ctx.repo.findById(input.id);
      if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Профиль не найден' });

      const [profile] = await withEmails([row], ctx.auth);
      return { profile: profile! };
    }),
});

export type UsersAdminRouter = typeof adminRouter;
