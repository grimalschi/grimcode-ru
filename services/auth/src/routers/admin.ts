import { ORPCError } from '@orpc/client';
import { implement } from '@orpc/server';
import {
  authAdminContract,
  type AdminContext,
  type adminInternalContract,
  type ContractRouterClient,
} from '@template/contracts';
import {
  createRpcClient,
  internalServiceUrl,
  isCsrfValid,
  newToken,
  publicSiteUrl,
  type Logger,
} from '@template/shared';

import type { Notifier } from '../notifier.js';
import type { AuthRepository, IdentityRow } from '../repository.js';

export interface AdminRpcContext {
  repo: AuthRepository;
  notifier: Notifier;
  logger: Logger;
  request: Request;
  /** Verified by Gateway. Absent means the request did not come through the admin route. */
  admin: AdminContext | null;
}

const RESET_TTL_SECONDS = 60 * 60;
const VERIFICATION_TTL_SECONDS = 60 * 60 * 24;

const os = implement(authAdminContract).$context<AdminRpcContext>();

/**
 * Every admin mutation checks the verified context and the CSRF token. Both together mean a
 * request must come through Gateway's admin route *and* originate from the admin panel itself.
 */
function requireAdmin(context: AdminRpcContext): AdminContext {
  if (!context.admin) throw new ORPCError('FORBIDDEN', { message: 'Контекст администратора отсутствует' });
  return context.admin;
}

function requireMutation(context: AdminRpcContext): AdminContext {
  const admin = requireAdmin(context);
  if (!isCsrfValid(context.request.headers, 'auth')) {
    throw new ORPCError('FORBIDDEN', { message: 'CSRF-токен отсутствует или неверен' });
  }
  return admin;
}

async function loadIdentity(repo: AuthRepository, id: string): Promise<IdentityRow> {
  const row = await repo.findIdentityById(id);
  if (!row) throw new ORPCError('NOT_FOUND', { message: 'Пользователь не найден' });
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

/** Admin's internal endpoint, used for the facts Auth does not own. */
function adminService(): ContractRouterClient<typeof adminInternalContract> {
  return createRpcClient<ContractRouterClient<typeof adminInternalContract>>({
    url: `${internalServiceUrl('admin')}/internal/rpc`,
  });
}

export const adminRouter = os.router({
  listIdentities: os.listIdentities.handler(async ({ input, context }) => {
    requireAdmin(context);
    const { rows, total } = await context.repo.listIdentities(input.query, input.limit, input.offset);

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
  }),

  getIdentity: os.getIdentity.handler(async ({ input, context }) => {
    requireAdmin(context);
    const row = await loadIdentity(context.repo, input.id);
    return { identity: await adminIdentityOf(context.repo, row) };
  }),

  /**
   * Sends the ordinary user-facing recovery link through Notifications and Email.
   *
   * The administrator never sets, sees or receives the token: it is the same time-limited
   * single-use flow the user would start themselves.
   */
  sendRecovery: os.sendRecovery.handler(async ({ input, context }) => {
    const admin = requireMutation(context);
    const row = await loadIdentity(context.repo, input.id);

    const token = newToken(32);
    await context.repo.issueToken(row.id, 'password-reset', token, RESET_TTL_SECONDS);
    await context.repo.audit({
      identityId: row.id,
      action: 'admin.recovery.sent',
      actorUserId: admin.userId,
      actorRole: admin.role,
    });

    await context.notifier.emit(
      {
        type: 'auth.password.reset_requested',
        recipient: {
          identityId: row.id,
          email: row.email,
        },
        payload: {
          resetUrl: `${publicSiteUrl()}/app/reset-password/confirm?token=${encodeURIComponent(token)}`,
        },
      },
      `auth.password.reset_requested:${row.id}:${Date.now()}`,
    );

    return { ok: true as const };
  }),

  resendVerification: os.resendVerification.handler(async ({ input, context }) => {
    const admin = requireMutation(context);
    const row = await loadIdentity(context.repo, input.id);
    if (row.email_verified_at !== null) {
      throw new ORPCError('BAD_REQUEST', { message: 'Адрес уже подтверждён' });
    }

    const token = newToken(32);
    await context.repo.issueToken(row.id, 'email-verification', token, VERIFICATION_TTL_SECONDS);
    await context.repo.audit({
      identityId: row.id,
      action: 'admin.verification.resent',
      actorUserId: admin.userId,
      actorRole: admin.role,
    });

    await context.notifier.emit(
      {
        type: 'auth.email.verification_requested',
        recipient: {
          identityId: row.id,
          email: row.email,
        },
        payload: {
          verificationUrl: `${publicSiteUrl()}/app/verify-email?token=${encodeURIComponent(token)}`,
        },
      },
      `auth.email.verification_requested:${row.id}:${Date.now()}`,
    );

    return { ok: true as const };
  }),

  revokeSessions: os.revokeSessions.handler(async ({ input, context }) => {
    const admin = requireMutation(context);
    const row = await loadIdentity(context.repo, input.id);

    const revoked = await context.repo.revokeAllSessions(row.id);
    await context.repo.audit({
      identityId: row.id,
      action: 'admin.sessions.revoked',
      actorUserId: admin.userId,
      actorRole: admin.role,
      details: { revoked },
    });

    return { ok: true as const };
  }),

  /** Owner-only, and no owner's identity can be blocked while they hold the rights. */
  setBlocked: os.setBlocked.handler(async ({ input, context }) => {
    const admin = requireMutation(context);
    if (admin.role !== 'owner') {
      throw new ORPCError('FORBIDDEN', { message: 'Блокировать может только владелец' });
    }
    if (input.blocked && admin.userId === input.id) {
      // Otherwise the last working owner session could be removed by the owner themselves.
      throw new ORPCError('FORBIDDEN', { message: 'Нельзя заблокировать самого себя' });
    }

    /*
     * Blocking takes away every session and every token, so a blocked owner is an owner the panel
     * can no longer let in. The registry's own rule counts owners by its `enabled` flag and cannot
     * see that, so two owners could be reduced to none: block one here, remove the other there.
     *
     * Ownership is Admin's fact and blocking is Auth's, so Auth asks before it acts, and refuses
     * outright: rights come off in Administrators first, and only then does blocking apply.
     */
    if (input.blocked) {
      const { activeOwner } = await adminService().isActiveOwner({ userId: input.id });
      if (activeOwner) {
        throw new ORPCError('CONFLICT', {
          message: 'Сначала снимите права владельца в разделе «Администраторы»',
        });
      }
    }

    const row = await loadIdentity(context.repo, input.id);
    const updated = await context.repo.setBlocked(row.id, input.blocked);
    if (!updated) throw new ORPCError('NOT_FOUND', { message: 'Пользователь не найден' });

    if (input.blocked) {
      // Blocking takes effect immediately: sessions and outstanding auth tokens are revoked.
      await context.repo.revokeAllSessions(row.id);
      await context.repo.revokeTokens(row.id);
    }

    await context.repo.audit({
      identityId: row.id,
      action: input.blocked ? 'admin.identity.blocked' : 'admin.identity.unblocked',
      actorUserId: admin.userId,
      actorRole: admin.role,
    });

    return { ok: true as const, identity: await adminIdentityOf(context.repo, updated) };
  }),

  listAudit: os.listAudit.handler(async ({ input, context }) => {
    requireAdmin(context);
    const { rows, total } = await context.repo.listAudit(input.query, input.limit, input.offset);

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
  }),
});
