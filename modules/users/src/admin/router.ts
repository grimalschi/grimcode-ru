import type { AuthApi } from '@template/contracts/modules/auth';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';

import { isCsrfValid } from '../http/csrf.js';
import { idSchema, pageOf, paginationInputSchema } from '../primitives.js';
import { adminUserProfileSchema } from '../schemas.js';
import { toProfile, type ProfileRow, type UsersRepository } from '../repository.js';
import type { RpcContext } from '../trpc/context.js';
import type { UsersEnv } from '../env.js';
import type { AdminContext } from '@template/contracts/module-instance';

/**
 * Fills in what Auth knows about the account behind each profile: the sign-in address, whether it
 * is blocked, and whether the panel protects it from blocking.
 *
 * Users does not store any of it, so it is fetched per request, in one call for the whole page. An
 * id Auth does not know stays `null`, which is how a profile left by a deleted account is visible as one.
 */
async function withIdentities(rows: ProfileRow[], auth: AuthApi) {
  const profiles = rows.map((row) => ({
    ...toProfile(row), email: null as string | null, blockedAt: null as string | null, blockingProtectedAt: null as string | null,
  }));
  if (profiles.length === 0) return profiles;

  try {
    const { identities } = await auth.getIdentitiesByIds({
      ids: [...new Set(rows.map((row) => row.identity_id))],
    });

    const byId = new Map(identities.map((identity) => [identity.id, identity]));
    for (const profile of profiles) {
      const identity = byId.get(profile.identityId);
      if (!identity) continue;
      profile.email = identity.email;
      profile.blockedAt = identity.blockedAt;
      profile.blockingProtectedAt = identity.blockingProtectedAt;
    }
  } catch (error) {
    console.error('Users could not load identity emails', error);
  }

  return profiles;
}

export interface AdminRpcContext extends RpcContext {
  adminContext: AdminContext;
  env: UsersEnv;
  repo: UsersRepository;
  /** Ready Auth API; the profile list reads sign-in addresses through it. */
  auth: AuthApi;
}

// Same shape as the public surface: no stack in any answer, generic wording only for internal failures.
const adminT = initTRPC.context<AdminRpcContext>().create({
  errorFormatter({ shape, error }): typeof shape {
    return {
      ...shape,
      message: error.code === 'INTERNAL_SERVER_ERROR' ? 'Internal server error' : shape.message,
      data: { ...shape.data, stack: undefined },
    };
  },
});

const adminProcedure = adminT.procedure.use(({ ctx, next }) => {
  if (!ctx.adminContext) throw new TRPCError({ code: 'FORBIDDEN', message: 'Контекст администратора отсутствует' });
  return next({ ctx: { adminContext: ctx.adminContext } });
});

/**
 * The one changing call here acts on the account, not the profile — a profile still belongs to the
 * person it describes. It is the owner's alone, and carries this module's own CSRF token, as every
 * module admin mutation does.
 */
const ownerMutation = adminProcedure.use(({ ctx, next }) => {
  if (!isCsrfValid(ctx.request.headers, ctx.env.csrfCookieName)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Недействительный CSRF-токен' });
  }
  if (ctx.adminContext.role !== 'owner') throw new TRPCError({ code: 'FORBIDDEN', message: 'Только владелец' });
  return next();
});

export const adminRouter = adminT.router({
  /** Who is looking: the screen offers blocking to the owner only. */
  viewer: adminProcedure
    .input(z.object({}))
    .output(z.object({ userId: idSchema, role: z.enum(['owner', 'admin']) }))
    .query(({ ctx }) => ({ userId: ctx.adminContext.userId, role: ctx.adminContext.role })),

  listProfiles: adminProcedure
    .input(paginationInputSchema)
    .output(pageOf(adminUserProfileSchema))
    .query(async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.list(input.query, input.limit, input.offset);
      return {
        items: await withIdentities(rows, ctx.auth),
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

      const [profile] = await withIdentities([row], ctx.auth);
      return { profile: profile! };
    }),

  /**
   * Blocks or unblocks the account behind a profile, through Auth. Who may be blocked is Auth's
   * question (an owner is protected there); whether the asker may ask is answered here: the owner,
   * never for their own account. Auth records the event with this verified actor.
   */
  setBlocked: ownerMutation
    .input(z.object({ identityId: idSchema, blocked: z.boolean() }))
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ input, ctx }) => {
      if (input.blocked && input.identityId === ctx.adminContext.userId) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Нельзя заблокировать собственный аккаунт' });
      }
      await ctx.auth.setIdentityBlocked({
        userId: input.identityId, blocked: input.blocked,
        actor: { userId: ctx.adminContext.userId, role: ctx.adminContext.role },
      });
      return { ok: true as const };
    }),
});

export type UsersAdminRouter = typeof adminRouter;
