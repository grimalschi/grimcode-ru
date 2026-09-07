import {
  adminRoleSchema,
  adminServiceIdSchema,
  adminTargetSchema,
  assignableServiceIdSchema,
  emailSchema,
  idSchema,
  okSchema,
  pageOf,
  paginationInputSchema,
  type AdminRole,
} from '@template/shared/vocabulary';
import {
  expiredSessionCookie,
  parseCookies,
  requireCsrf,
  sessionCookieName,
  verifiedAdmin,
  type AdminAwareContext,
} from '@template/shared';
import { initTRPC, TRPCError } from '@trpc/server';

import { authorize, canOpenDatabase, visibleServices, type AuthCaller } from './authorization.js';
import { z } from 'zod';

import { toAdministrator, type AdminRepository } from './repository.js';
import { administratorSchema, adminAuditEntrySchema, authorizationResultSchema } from './schemas.js';

/** No `request` and no `resHeaders`: this surface is reached by a caller, never by a request. */
export interface InternalContext {
  repo: AdminRepository;
  auth: AuthCaller;
}

export interface AdminRpcContext extends AdminAwareContext {
  repo: AdminRepository;
  auth: AuthCaller;
  requestId: string;
}

// --- internal surface -----------------------------------------------------------------------

const internalT = initTRPC.context<InternalContext>().create();

/**
 * `authorize` is the decision Gateway trusts on every `/admin/**` request. The same line in the admin
 * router would put it behind a screen anyone with a session can reach.
 */
type InternalName = 'authorize';
type AdminName =
  | 'session'
  | 'listAdministrators'
  | 'searchUsers'
  | 'addAdministrator'
  | 'updateAdministrator'
  | 'listAudit'
  | 'logout';

export const internalRouter = internalT.router({
  /**
   * A query, because from Gateway's side it is a question asked on every `/admin/**` request. It can
   * write once — the first call bootstraps the owner from Auth's first account when the registry is
   * empty — and that is the exception the registry exists to make.
   */
  authorize: internalT.procedure
    .input(
      z.object({
        sessionToken: z.string().min(1).max(400).nullable(),
        /** What is being opened; Gateway works it out from the URL. */
        target: adminTargetSchema,
      }),
    )
    .output(authorizationResultSchema)
    .query(({ input, ctx }) => authorize(input, ctx)),
} satisfies Record<InternalName, unknown>);


// --- panel surface --------------------------------------------------------------------------

const adminT = initTRPC.context<AdminRpcContext>().create();

/**
 * Four builders, because this surface has two axes and not one.
 *
 * Everywhere else a procedure is either an admin read or an admin change; the panel adds a second
 * question — administrator or owner — and the two multiply. The owner half is Admin's alone. What
 * they buy is that the answer is in the declaration and not in the first line of nine bodies.
 */
const adminProcedure = adminT.procedure.use(({ ctx, next }) =>
  next({ ctx: { admin: verifiedAdmin(ctx) } }),
);

const adminMutation = adminProcedure.use(({ ctx, next }) => {
  requireCsrf(ctx, 'panel');
  return next();
});

/**
 * One owner rule and one sentence for it — three wordings of one condition is how a rule starts
 * being edited in one place only.
 */
const ownerProcedure = adminProcedure.use(({ ctx, next }) => {
  if (ctx.admin.role !== 'owner') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Доступно только владельцу' });
  }
  return next();
});

const ownerMutation = ownerProcedure.use(({ ctx, next }) => {
  requireCsrf(ctx, 'panel');
  return next();
});

/**
 * Refuses a change that would leave the panel with nobody able to enter.
 *
 * Exported because this rule and the question below it are the whole of what can go wrong here, and
 * the procedure around them needs a database and a running Auth to say anything.
 */
export function lastOwnerGuard(userId: string) {
  return (next: { role: AdminRole; enabled: boolean }, activeOwners: number): void => {
    const staysActiveOwner = next.role === 'owner' && next.enabled;
    if (!staysActiveOwner && activeOwners === 0) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'Последнего владельца, который может войти, нельзя понизить или отключить',
        cause: { userId },
      });
    }
  };
}

/**
 * Which of these owners could actually take the panel over: an owner blocked in Auth has no sessions
 * and cannot sign in, so the registry's own `enabled` flag is not enough to count them.
 *
 * Asked before the transaction opens, so the table lock is not held while Auth answers. More owners
 * than one request may ask about are cut off, which can only refuse a change that would have been
 * allowed — never allow one that leaves nobody able to enter.
 */
export async function ownersAbleToSignIn(
  userIds: readonly string[],
  auth: AuthCaller,
): Promise<string[]> {
  if (userIds.length === 0) return [];

  const { identities } = await auth.getIdentitiesByIds({ ids: userIds.slice(0, 200) });
  return identities.filter((identity) => identity.blockedAt === null).map((identity) => identity.id);
}

export const adminRouter = adminT.router({
  session: adminProcedure
    .input(z.object({}))
    .output(
      z.object({
        userId: idSchema,
        email: emailSchema,
        role: adminRoleSchema,
        services: z.array(adminServiceIdSchema),
        /** Whether this administrator may open the panel's database browser. Owners only. */
        database: z.boolean(),
      }),
    )
    .query(async ({ ctx }) => {
    const row = await ctx.repo.findByUserId(ctx.admin.userId);
    if (!row) throw new TRPCError({ code: 'FORBIDDEN', message: 'Не администратор' });

    return {
      userId: row.user_id,
      email: row.email,
      role: row.role,
      // Hiding a menu item is interface only — the direct URL passes the very same Gateway check.
      services: visibleServices(row.role, row.grants ?? []),
      database: canOpenDatabase(row.role),
    };
  }),

  listAdministrators: ownerProcedure
    .input(paginationInputSchema)
    .output(pageOf(administratorSchema))
    .query(async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.list(input.query, input.limit, input.offset);
      return {
        items: rows.map(toAdministrator),
        total,
        limit: input.limit,
        offset: input.offset,
      };
    }),

  /** Adds an already registered user by email. Product users from Users are never listed here. */
  searchUsers: ownerProcedure
    .input(z.object({ query: z.string().min(1).max(200) }))
    .output(
      z.object({
        users: z.array(
          z.object({
            userId: idSchema,
            email: emailSchema,
            /** Already in the registry, so adding them again would be refused. */
            isAdministrator: z.boolean(),
          }),
        ),
      }),
    )
    .query(async ({ input, ctx }) => {
      const { identities } = await ctx.auth.searchIdentities({
        query: input.query,
        limit: 10,
      });

      // Whether each one is already an administrator, so the interface can say so before the owner
      // tries and is refused.
      const users = await Promise.all(
        identities.map(async (identity) => ({
          userId: identity.id,
          email: identity.email,
          isAdministrator: (await ctx.repo.findByUserId(identity.id)) !== null,
        })),
      );

      return { users };
    }),

  addAdministrator: ownerMutation
    .input(
      z.object({
        email: emailSchema,
        role: adminRoleSchema,
        grants: z.array(assignableServiceIdSchema).default([]),
      }),
    )
    .output(z.object({ ok: z.literal(true), administrator: administratorSchema }))
    .mutation(async ({ input, ctx }) => {
      const { identity } = await ctx.auth.getIdentityByEmail({ email: input.email });
      if (!identity) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'С таким адресом никто не зарегистрирован — сначала нужен аккаунт',
        });
      }

      if (await ctx.repo.findByUserId(identity.id)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Этот человек уже администратор' });
      }

      const row = await ctx.repo.add(identity.id, identity.email, input.role, input.grants);
      await ctx.repo.audit({
        action: 'administrator.added',
        actorUserId: ctx.admin.userId,
        subjectUserId: identity.id,
        details: { role: input.role, grants: input.grants },
      });

      return { ok: true as const, administrator: toAdministrator(row) };
    }),

  updateAdministrator: ownerMutation
    .input(
      z.object({
        userId: idSchema,
        role: adminRoleSchema.optional(),
        enabled: z.boolean().optional(),
        grants: z.array(assignableServiceIdSchema).optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true), administrator: administratorSchema }))
    .mutation(async ({ input, ctx }) => {
    const existing = await ctx.repo.findByUserId(input.userId);
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Администратор не найден' });

    /*
     * Who is left able to enter, established before the transaction and checked inside it: the rule
     * is enforced under the table lock, so two simultaneous requests cannot both believe another
     * owner remains. Blocking is Auth's fact, hence the question.
     */
    const eligible = await ownersAbleToSignIn(
      await ctx.repo.otherActiveOwnerIds(input.userId),
      ctx.auth,
    );

    const row = await ctx.repo.update(
      input.userId,
      { role: input.role, enabled: input.enabled, grants: input.grants },
      lastOwnerGuard(input.userId),
      eligible,
    );

    await ctx.repo.audit({
      action: 'administrator.updated',
      actorUserId: ctx.admin.userId,
      subjectUserId: input.userId,
      details: {
        role: input.role ?? null,
        enabled: input.enabled ?? null,
        grants: input.grants ?? null,
      },
    });

    return { ok: true as const, administrator: toAdministrator(row) };
  }),

  listAudit: ownerProcedure
    .input(paginationInputSchema)
    .output(pageOf(adminAuditEntrySchema))
    .query(async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.listAudit(input.query, input.limit, input.offset);
      return {
        items: rows.map((row) => ({
          id: String(row.id),
          action: String(row.action),
          actorUserId: (row.actor_user_id as string | null) ?? null,
          subjectUserId: (row.subject_user_id as string | null) ?? null,
          details: (row.details as Record<string, unknown>) ?? {},
          createdAt: (row.created_at as Date).toISOString(),
        })),
        total,
        limit: input.limit,
        offset: input.offset,
      };
    }),

  /**
   * Logout is a server-side Auth operation.
   *
   * Auth invalidates the session row; the cookie is cleared here, because this response is the one
   * the browser receives. The order is the whole of it: clearing the cookie without invalidating the
   * row leaves a session that still works, so a failed call must reach the caller.
   */
  logout: adminMutation
    .input(z.object({}))
    .output(okSchema)
    .mutation(async ({ ctx }) => {
    const token = parseCookies(ctx.request.headers.get('cookie'))[sessionCookieName()];
    if (!token) return { ok: true as const };

    await ctx.auth.revokeSessionByToken({ sessionToken: token });
    ctx.resHeaders.append('set-cookie', expiredSessionCookie());

    return { ok: true as const };
    }),
} satisfies Record<AdminName, unknown>);


/** Calls the internal procedures directly, with their schemas and without a request. */
export const createInternalCallerFactory = internalT.createCallerFactory(internalRouter);

/** The panel's browser client is typed from this, and from nothing else. */
export type AdminPanelRouter = typeof adminRouter;
