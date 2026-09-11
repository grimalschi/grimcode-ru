import { adminT, adminProcedure, adminMutation, ownerProcedure, ownerMutation, type AdminRpcContext } from './rpc.js';
import { databaseRouter } from './database/router.js';
import type { AuthApi } from '@template/contracts/modules/auth';
import type { AdminRole } from '@template/contracts/modules/admin';
import {
  adminModuleDescriptorSchema,
  adminRoleSchema,
  adminModuleIdSchema,
  type CatalogueEntry,
} from '../vocabulary.js';
import {
  emailSchema,
  idSchema,
  okSchema,
  pageOf,
  paginationInputSchema,
} from '../primitives.js';
import { expiredSessionCookie, parseCookies } from '../http/cookies.js';
import { TRPCError } from '@trpc/server';

import { visibleModules } from '../authorization.js';
import { z } from 'zod';

import { toAdministrator, type AdminRepository } from '../repository.js';
import { administratorSchema, adminAuditEntrySchema } from '../schemas.js';

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

/** Auth resolves which registry owners can sign in while the registry lock is held. */
export async function ownersAbleToSignIn(
  userIds: readonly string[],
  auth: AuthApi,
): Promise<string[]> {
  const eligible: string[] = [];
  for (let offset = 0; offset < userIds.length; offset += 200) {
    const { identities } = await auth.getIdentitiesByIds({ ids: userIds.slice(offset, offset + 200) });
    eligible.push(...identities.filter((identity) => identity.blockedAt === null).map((identity) => identity.id));
  }
  return eligible;
}

export const adminRouter = adminT.router({
  database: databaseRouter,
  session: adminProcedure
    .input(z.object({}))
    .output(
      z.object({
        userId: idSchema,
        email: emailSchema,
        role: adminRoleSchema,
        modules: z.array(adminModuleIdSchema),
        catalogue: z.array(adminModuleDescriptorSchema),
      }),
    )
    .query(async ({ ctx }) => {
    const row = await ctx.repo.findByUserId(ctx.admin.userId);
    if (!row) throw new TRPCError({ code: 'FORBIDDEN', message: 'Не администратор' });

    const modules = visibleModules(row.role, row.grants ?? [], ctx.catalogue);
    return {
      userId: row.user_id,
      email: ctx.admin.email,
      role: row.role,
      // Hiding a menu item is interface only — the direct URL passes the very same Router check.
      modules,
      catalogue: ctx.catalogue.filter(({ id }) => modules.includes(id)),
    };
  }),

  listAdministrators: ownerProcedure
    .input(paginationInputSchema)
    .output(pageOf(administratorSchema))
    .query(async ({ input, ctx }) => {
      const rows = await ctx.repo.list();
      const emails = new Map<string, string>();
      for (let offset = 0; offset < rows.length; offset += 200) {
        const { identities } = await ctx.auth.getIdentitiesByIds({ ids: rows.slice(offset, offset + 200).map((row) => row.user_id) });
        for (const identity of identities) emails.set(identity.id, identity.email);
      }
      const current = rows.map((row) => toAdministrator({ ...row, email: emails.get(row.user_id) ?? row.email }));
      const filtered = input.query ? current.filter((row) => row.email.toLowerCase().includes(input.query!.toLowerCase())) : current;
      return { items: filtered.slice(input.offset, input.offset + input.limit), total: filtered.length, limit: input.limit, offset: input.offset };
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
            blockedAt: z.string().nullable(),
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
          blockedAt: identity.blockedAt,
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
        grants: z.array(adminModuleIdSchema).default([]),
      }),
    )
    .output(z.object({ ok: z.literal(true), administrator: administratorSchema }))
    .mutation(async ({ input, ctx }) => {
      validateGrants(input.grants, ctx.catalogue);
      return ctx.repo.withRegistryLock(async (repo) => {
        await requireCurrentOwner(ctx, repo);
        const { identity } = await ctx.auth.getIdentityByEmail({ email: input.email });
        if (!identity) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'С таким адресом никто не зарегистрирован — сначала нужен аккаунт',
          });
        }

        if (await repo.findByUserId(identity.id)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Этот человек уже администратор' });
        }

        const row = await repo.add(identity.id, identity.email, input.role, input.grants);
        await repo.audit({
          action: 'administrator.added',
          actorUserId: ctx.admin.userId,
          subjectUserId: identity.id,
          details: { role: input.role, grants: input.grants },
        });

        return { ok: true as const, administrator: toAdministrator(row) };
      });
    }),

  updateAdministrator: ownerMutation
    .input(
      z.object({
        userId: idSchema,
        role: adminRoleSchema.optional(),
        enabled: z.boolean().optional(),
        grants: z.array(adminModuleIdSchema).optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true), administrator: administratorSchema }))
    .mutation(async ({ input, ctx }) => {
    if (input.grants) validateGrants(input.grants, ctx.catalogue);
    const existing = await ctx.repo.findByUserId(input.userId);
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Администратор не найден' });

    const row = await ctx.repo.withRegistryLock(async (repo) => {
      await requireCurrentOwner(ctx, repo);
      const eligible = await ownersAbleToSignIn(await repo.otherActiveOwnerIds(input.userId), ctx.auth);
      return repo.update(input.userId, input, lastOwnerGuard(input.userId), eligible);
    });
    const { identities } = await ctx.auth.getIdentitiesByIds({ ids: [row.user_id] });
    row.email = identities[0]?.email ?? row.email;

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

  setIdentityBlocked: ownerMutation
    .input(z.object({ userId: idSchema, blocked: z.boolean() }))
    .output(okSchema)
    .mutation(async ({ ctx, input }) => ctx.repo.withRegistryLock(async (repo) => {
      await requireCurrentOwner(ctx, repo);
      if (input.blocked && input.userId === ctx.admin.userId) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Нельзя заблокировать собственный аккаунт' });
      }
      const target = await repo.findByUserId(input.userId);
      if (input.blocked && target?.role === 'owner' && target.enabled) {
        const eligible = await ownersAbleToSignIn(await repo.otherActiveOwnerIds(input.userId), ctx.auth);
        lastOwnerGuard(input.userId)({ role: 'owner', enabled: false }, eligible.length);
      }
      await ctx.auth.setIdentityBlocked(input);
      await repo.audit({ action: input.blocked ? 'identity.blocked' : 'identity.unblocked', actorUserId: ctx.admin.userId, subjectUserId: input.userId });
      return { ok: true as const };
    })),

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
    const token = parseCookies(ctx.request.headers.get('cookie'))[ctx.env.sessionCookieName];
    if (!token) return { ok: true as const };

    await ctx.auth.revokeSessionByToken({ sessionToken: token });
    ctx.resHeaders.append('set-cookie', expiredSessionCookie(ctx.env));

    return { ok: true as const };
    }),
});

/** The panel's browser client is typed from this, and from nothing else. */
export type AdminPanelRouter = typeof adminRouter;

/** The installed catalogue, not a syntactically valid string, decides what may be granted. */
function validateGrants(grants: readonly string[], catalogue: readonly CatalogueEntry[]): void {
  if (grants.some((grant) => !catalogue.some(({ id, admin }) => id === grant && admin.assignable !== false))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Неизвестный или недоступный для назначения модуль' });
  }
}

/** Recheck the actor after acquiring the lock; another owner may have just removed their access. */
async function requireCurrentOwner(ctx: AdminRpcContext & { admin: NonNullable<AdminRpcContext['admin']> }, repo: AdminRepository): Promise<void> {
  const row = await repo.findByUserId(ctx.admin.userId);
  const token = parseCookies(ctx.request.headers.get('cookie'))[ctx.env.sessionCookieName];
  const { identity } = token ? await ctx.auth.resolveSession({ sessionToken: token }) : { identity: null };
  if (!row?.enabled || row.role !== 'owner' || identity?.id !== ctx.admin.userId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Доступ владельца больше не действует' });
  }
}
