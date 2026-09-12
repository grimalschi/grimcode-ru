import { idSchema, okSchema, pageOf, paginationInputSchema } from '../primitives.js';
import { z } from 'zod';
import { newToken, sha256 } from '../crypto.js';
import { isCsrfValid } from '../http/csrf.js';
import type { RpcContext } from '../trpc/context.js';
import type { AdminContext } from '@template/contracts/module-instance';
import { initTRPC, TRPCError } from '@trpc/server';

import type { AuthEnv } from '../env.js';
import type { Notifier } from '../notifier.js';
import type { AuthRepository, IdentityRow } from '../repository.js';
import { adminIdentitySchema, authAuditEntrySchema } from '../schemas.js';

export interface AdminRpcContext extends RpcContext {
  adminContext: AdminContext;
  repo: AuthRepository;
  notifier: Notifier;
  env: Pick<AuthEnv, 'publicOrigin' | 'csrfCookieName'>;
}

const RESET_TTL_SECONDS = 60 * 60;
const VERIFICATION_TTL_SECONDS = 60 * 60 * 24;

const t = initTRPC.context<AdminRpcContext>().create({
  errorFormatter: ({ shape, error }): typeof shape => ({
    ...shape,
    message: error.code === 'INTERNAL_SERVER_ERROR' ? 'Не удалось выполнить запрос' : shape.message,
    data: { ...shape.data, stack: undefined },
  }),
});

/**
 * Every admin mutation checks the verified context and the CSRF token: together they mean a request
 * must come through Router's admin route *and* originate from the admin panel itself. The scope is
 * `'auth'` and not `'panel'` — each surface issues its own cookie, and a token from the shell is
 * refused here on purpose.
 */
const adminProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.adminContext) throw new TRPCError({ code: 'FORBIDDEN', message: 'Контекст администратора отсутствует' });
  return next({ ctx: { adminContext: ctx.adminContext } });
});

const adminMutation = adminProcedure.use(({ ctx, next }) => {
  if (!isCsrfValid(ctx.request.headers, ctx.env.csrfCookieName)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'CSRF-токен отсутствует или неверен' });
  }
  return next();
});

async function loadIdentity(repo: AuthRepository, id: string): Promise<IdentityRow> {
  const row = await repo.findIdentityById(id);
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
  return row;
}

async function adminIdentityOf(repo: AuthRepository, row: IdentityRow) {
  const sessions = await repo.listSessions(row.id);
  return {
    id: row.id,
    email: row.email,
    emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
    blockedAt: row.blocked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    activeSessionCount: sessions.length,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
  };
}

export const adminRouter = t.router({
  listIdentities: adminProcedure
    .input(paginationInputSchema)
    .output(pageOf(adminIdentitySchema))
    .query(
    async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.listIdentities(input.query, input.limit, input.offset);

      return {
        items: rows.map((row) => ({
          id: row.id,
          email: row.email,
          emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
          blockedAt: row.blocked_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
          activeSessionCount: Number(row.active_session_count),
          lastLoginAt: row.last_login_at?.toISOString() ?? null,
        })),
        total,
        limit: input.limit,
        offset: input.offset,
      };
    },
  ),

  getIdentity: adminProcedure
    .input(z.object({ id: idSchema }))
    .output(z.object({ identity: adminIdentitySchema }))
    .query(
    async ({ input, ctx }) => {
      const row = await loadIdentity(ctx.repo, input.id);
      return { identity: await adminIdentityOf(ctx.repo, row) };
    },
  ),

  /**
   * Sends the ordinary user-facing recovery link through Notifications and Email. The administrator
   * never sets, sees or receives the token: it is the same time-limited single-use flow the user
   * would start themselves.
   */
  sendRecovery: adminMutation
    .input(z.object({ id: idSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const row = await loadIdentity(ctx.repo, input.id);

      const token = newToken(32);
      if (!await ctx.repo.issueToken(row.id, 'password-reset', token, RESET_TTL_SECONDS, { email: row.email })) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Аккаунт изменился или заблокирован' });
      }
      await ctx.repo.audit({
        identityId: row.id,
        action: 'admin.recovery.sent',
        actorUserId: ctx.adminContext.userId,
        actorRole: ctx.adminContext.role,
      });

      await ctx.notifier.emit(
        {
          type: 'auth.password.reset_requested',
          recipient: {
            identityId: row.id,
            email: row.email,
          },
          payload: {
            resetUrl: `${ctx.env.publicOrigin}/app/reset-password/confirm?token=${encodeURIComponent(token)}`,
          },
        },
        `auth.password.reset_requested:${row.id}:${sha256(token)}`,
      );

      return { ok: true as const };
    },
  ),

  resendVerification: adminMutation
    .input(z.object({ id: idSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const row = await loadIdentity(ctx.repo, input.id);
      if (row.email_verified_at !== null) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Адрес уже подтверждён' });
      }

      const token = newToken(32);
      if (!await ctx.repo.issueToken(row.id, 'email-verification', token, VERIFICATION_TTL_SECONDS, { email: row.email })) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Аккаунт изменился или заблокирован' });
      }
      await ctx.repo.audit({
        identityId: row.id,
        action: 'admin.verification.resent',
        actorUserId: ctx.adminContext.userId,
        actorRole: ctx.adminContext.role,
      });

      await ctx.notifier.emit(
        {
          type: 'auth.email.verification_requested',
          recipient: {
            identityId: row.id,
            email: row.email,
          },
          payload: {
            verificationUrl: `${ctx.env.publicOrigin}/app/verify-email?token=${encodeURIComponent(token)}`,
          },
        },
        `auth.email.verification_requested:${row.id}:${sha256(token)}`,
      );

      return { ok: true as const };
    },
  ),

  revokeSessions: adminMutation
    .input(z.object({ id: idSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const row = await loadIdentity(ctx.repo, input.id);

      const revoked = await ctx.repo.revokeAllSessions(row.id);
      await ctx.repo.audit({
        identityId: row.id,
        action: 'admin.sessions.revoked',
        actorUserId: ctx.adminContext.userId,
        actorRole: ctx.adminContext.role,
        details: { revoked },
      });

      return { ok: true as const };
    },
  ),

  listAudit: adminProcedure
    .input(paginationInputSchema)
    .output(pageOf(authAuditEntrySchema))
    .query(
    async ({ input, ctx }) => {
      const { rows, total } = await ctx.repo.listAudit(input.query, input.limit, input.offset);

      return {
        items: rows.map((row) => ({
          id: String(row.id),
          identityId: (row.identity_id as string | null) ?? null,
          action: String(row.action),
          actorUserId: (row.actor_user_id as string | null) ?? null,
          actorRole: (row.actor_role as string | null) ?? null,
          details: (row.details as Record<string, unknown>) ?? {},
          createdAt: (row.created_at as Date).toISOString(),
        })),
        total,
        limit: input.limit,
        offset: input.offset,
      };
    },
  ),
});


/** Auth's own module admin is typed from this, and from nothing else. */
export type AuthAdminRouter = typeof adminRouter;
