import type { AuthInternalCaller } from '@template/auth/contract';
import type { Identity } from '@template/auth/contract';

import { idSchema, pageOf, paginationInputSchema } from '@template/shared/vocabulary';
import {
  verifiedAdmin,
  type AdminAwareContext,
  type RpcContext,
} from '@template/shared';
import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';

import { adminUserProfileSchema, userProfileSchema } from './schemas.js';

import { toProfile, type ProfileRow, type UsersRepository } from './repository.js';

/**
 * Fills in the sign-in address for a page of profiles.
 *
 * Users does not store it, so it is fetched per request, in one call for the whole page. An id Auth
 * does not know stays `null`, which is how a profile left by a deleted account is visible as one.
 * The `catch` below is why the deadline Auth puts on its own caller matters.
 */
async function withEmails(rows: ProfileRow[], ctx: Pick<AdminRpcContext, 'auth'>) {
  const profiles = rows.map((row) => ({ ...toProfile(row), email: null as string | null }));
  if (profiles.length === 0) return profiles;

  try {
    const { identities } = await ctx.auth.getIdentitiesByIds({
      ids: [...new Set(rows.map((row) => row.identity_id))],
    });

    const byId = new Map(identities.map((identity) => [identity.id, identity.email]));
    for (const profile of profiles) profile.email = byId.get(profile.identityId) ?? null;
  } catch {
    // The page is worth showing without addresses. Auth's refusal is swallowed here and reported
    // nowhere — the cost of having no logging at all, and it is paid knowingly.
  }

  return profiles;
}

export interface PublicContext extends RpcContext {
  repo: UsersRepository;
  /** Resolved through Auth on every call; `null` means no valid session. */
  identity: Identity | null;
}

export interface AdminRpcContext extends AdminAwareContext {
  repo: UsersRepository;
  /** Auth's internal surface, built for this request; the profile list needs the address from it. */
  auth: AuthInternalCaller;
}

// --- public surface ---------------------------------------------------------------------------

const publicT = initTRPC.context<PublicContext>().create();

/**
 * A session is required, and this is where that requirement lives: the route guard in the SPA is for
 * the user flow, this is what actually protects the data.
 */
const withIdentity = publicT.procedure.use(({ ctx, next }) => {
  if (!ctx.identity) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Сессия не активна' });
  return next({ ctx: { identity: ctx.identity } });
});

/**
 * The public surface, by name, and the list is the point.
 *
 * The mistake worth stopping is an admin procedure written into the public router: `listProfiles`
 * reads *everyone's* profiles, and one line in the wrong object is the distance between an admin
 * screen and a data leak.
 *
 * `satisfies` and nothing else, because the constraint lands on the object **literal** passed to
 * `.router()` — excess property checking is what TypeScript does to literals and declines to do for
 * a variable, which is why `.output()` is still needed for what a resolver returns.
 */
type PublicName = 'getOwnProfile' | 'updateOwnProfile';
type AdminName = 'listProfiles' | 'getProfile';

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
} satisfies Record<PublicName, unknown>);

// --- admin surface ----------------------------------------------------------------------------

const adminT = initTRPC.context<AdminRpcContext>().create();

const adminProcedure = adminT.procedure.use(({ ctx, next }) =>
  next({ ctx: { admin: verifiedAdmin(ctx) } }),
);

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
        items: await withEmails(rows, ctx),
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

      const [profile] = await withEmails([row], ctx);
      return { profile: profile! };
    }),
} satisfies Record<AdminName, unknown>);

/** The browser client is typed from these, and from nothing else. */
export type UsersPublicRouter = typeof publicRouter;
export type UsersAdminRouter = typeof adminRouter;
