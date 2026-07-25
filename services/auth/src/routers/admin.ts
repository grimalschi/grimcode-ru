import { ORPCError } from '@orpc/client';
import { implement } from '@orpc/server';
import { authAdminContract, type AdminContext } from '@template/contracts';
import { isCsrfValid, newToken, publicSiteUrl, type Logger } from '@template/shared';

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
  if (!context.admin) throw new ORPCError('FORBIDDEN', { message: 'Administrator context missing' });
  return context.admin;
}

function requireMutation(context: AdminRpcContext): AdminContext {
  const admin = requireAdmin(context);
  if (!isCsrfValid(context.request.headers)) {
    throw new ORPCError('FORBIDDEN', { message: 'CSRF token missing or invalid' });
  }
  return admin;
}

async function loadIdentity(repo: AuthRepository, id: string): Promise<IdentityRow> {
  const row = await repo.findIdentityById(id);
  if (!row) throw new ORPCError('NOT_FOUND', { message: 'Identity not found' });
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
          locale: await context.notifier.localeOf(row.id),
        },
        payload: {
          resetUrl: `${publicSiteUrl()}/app/reset-password?token=${encodeURIComponent(token)}`,
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
      throw new ORPCError('BAD_REQUEST', { message: 'This email is already verified' });
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
          locale: await context.notifier.localeOf(row.id),
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

  /** Owner-only, and an owner can never block their own identity. */
  setBlocked: os.setBlocked.handler(async ({ input, context }) => {
    const admin = requireMutation(context);
    if (admin.role !== 'owner') {
      throw new ORPCError('FORBIDDEN', { message: 'Only the owner can block an identity' });
    }
    if (input.blocked && admin.userId === input.id) {
      // Otherwise the last working owner session could be removed by the owner themselves.
      throw new ORPCError('FORBIDDEN', { message: 'You cannot block your own identity' });
    }

    const row = await loadIdentity(context.repo, input.id);
    const updated = await context.repo.setBlocked(row.id, input.blocked);
    if (!updated) throw new ORPCError('NOT_FOUND', { message: 'Identity not found' });

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
