import { ORPCError } from '@orpc/client';
import { implement } from '@orpc/server';
import {
  adminContract,
  type AdminContext,
  type AdminRole,
} from '@template/contracts';
import {
  createRpcClient,
  internalServiceUrl,
  isCsrfValid,
  parseCookies,
  REQUEST_ID_HEADER,
  sessionCookieName,
  type Logger,
} from '@template/shared';

import { authorize, canOpenDatabase, visibleServices, type AuthClient } from './authorization.js';
import { toAdministrator, type AdminRepository } from './repository.js';

export interface InternalContext {
  repo: AdminRepository;
  auth: AuthClient;
  logger: Logger;
}

export interface AdminRpcContext {
  repo: AdminRepository;
  auth: AuthClient;
  request: Request;
  /** Headers this call adds to the response, used to forward Auth's cookie-clearing header. */
  resHeaders: Headers;
  requestId: string;
  admin: AdminContext | null;
}

const internalOs = implement(adminContract.internal).$context<InternalContext>();

export const internalRouter = internalOs.router({
  authorize: internalOs.authorize.handler(({ input, context }) => authorize(input, context)),
});

const adminOs = implement(adminContract.admin).$context<AdminRpcContext>();

function requireAdmin(context: AdminRpcContext): AdminContext {
  if (!context.admin) throw new ORPCError('FORBIDDEN', { message: 'Administrator context missing' });
  return context.admin;
}

/** Owner-only mutations are protected by both the verified context and a CSRF token. */
/** Reading the registry is owner-only too, but it changes nothing and needs no token. */
function requireOwner(context: AdminRpcContext): AdminContext {
  const admin = requireAdmin(context);
  if (admin.role !== 'owner') {
    throw new ORPCError('FORBIDDEN', { message: 'Only the owner can manage administrators' });
  }
  return admin;
}

function requireOwnerMutation(context: AdminRpcContext): AdminContext {
  const admin = requireAdmin(context);
  if (admin.role !== 'owner') {
    throw new ORPCError('FORBIDDEN', { message: 'Only the owner can manage administrators' });
  }
  if (!isCsrfValid(context.request.headers, 'panel')) {
    throw new ORPCError('FORBIDDEN', { message: 'CSRF token missing or invalid' });
  }
  return admin;
}

function lastOwnerGuard(userId: string) {
  return (next: { role: AdminRole; enabled: boolean }, activeOwners: number): void => {
    const staysActiveOwner = next.role === 'owner' && next.enabled;
    if (!staysActiveOwner && activeOwners === 0) {
      throw new ORPCError('CONFLICT', {
        message: 'The last active owner cannot be demoted or disabled',
        data: { userId },
      });
    }
  };
}

export const adminRouter = adminOs.router({
  session: adminOs.session.handler(async ({ context }) => {
    const admin = requireAdmin(context);
    const row = await context.repo.findByUserId(admin.userId);
    if (!row) throw new ORPCError('FORBIDDEN', { message: 'Not an administrator' });

    return {
      userId: row.user_id,
      email: row.email,
      role: row.role,
      // Hiding a menu item is interface only — the direct URL passes the very same Gateway check.
      services: visibleServices(row.role, row.grants ?? []),
      database: canOpenDatabase(row.role),
    };
  }),

  listAdministrators: adminOs.listAdministrators.handler(async ({ input, context }) => {
    const admin = requireAdmin(context);
    if (admin.role !== 'owner') {
      throw new ORPCError('FORBIDDEN', { message: 'Only the owner can see the administrator list' });
    }

    const { rows, total } = await context.repo.list(input.query, input.limit, input.offset);
    return {
      items: rows.map(toAdministrator),
      total,
      limit: input.limit,
      offset: input.offset,
    };
  }),

  /** Adds an already registered user by email. Product users from Users are never listed here. */
  searchUsers: adminOs.searchUsers.handler(async ({ input, context }) => {
    requireOwner(context);

    const { identities } = await context.auth.searchIdentities({ query: input.query, limit: 10 });

    // Whether each one is already an administrator, so the interface can say so before the owner
    // tries and is refused.
    const users = await Promise.all(
      identities.map(async (identity) => ({
        userId: identity.id,
        email: identity.email,
        isAdministrator: (await context.repo.findByUserId(identity.id)) !== null,
      })),
    );

    return { users };
  }),

  addAdministrator: adminOs.addAdministrator.handler(async ({ input, context }) => {
    const admin = requireOwnerMutation(context);

    const { identity } = await context.auth.getIdentityByEmail({ email: input.email });
    if (!identity) {
      throw new ORPCError('NOT_FOUND', {
        message: 'No registered user with this email. The user must sign up first.',
      });
    }

    if (await context.repo.findByUserId(identity.id)) {
      throw new ORPCError('CONFLICT', { message: 'This user is already an administrator' });
    }

    const row = await context.repo.add(identity.id, identity.email, input.role, input.grants);
    await context.repo.audit({
      action: 'administrator.added',
      actorUserId: admin.userId,
      subjectUserId: identity.id,
      details: { role: input.role, grants: input.grants },
    });

    return { ok: true as const, administrator: toAdministrator(row) };
  }),

  updateAdministrator: adminOs.updateAdministrator.handler(async ({ input, context }) => {
    const admin = requireOwnerMutation(context);

    const existing = await context.repo.findByUserId(input.userId);
    if (!existing) throw new ORPCError('NOT_FOUND', { message: 'Administrator not found' });

    // The last-owner rule is enforced inside the transaction, so two simultaneous requests cannot
    // both believe another owner remains.
    const row = await context.repo.update(
      input.userId,
      { role: input.role, enabled: input.enabled, grants: input.grants },
      lastOwnerGuard(input.userId),
    );

    await context.repo.audit({
      action: 'administrator.updated',
      actorUserId: admin.userId,
      subjectUserId: input.userId,
      details: {
        role: input.role ?? null,
        enabled: input.enabled ?? null,
        grants: input.grants ?? null,
      },
    });

    return { ok: true as const, administrator: toAdministrator(row) };
  }),

  listAudit: adminOs.listAudit.handler(async ({ input, context }) => {
    const admin = requireAdmin(context);
    if (admin.role !== 'owner') {
      throw new ORPCError('FORBIDDEN', { message: 'Only the owner can read the admin audit' });
    }

    const { rows, total } = await context.repo.listAudit(input.query, input.limit, input.offset);
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
   * Auth invalidates the session row in its own database and answers with the cookie-clearing
   * header, which is forwarded to the browser. Removing the cookie in client JavaScript alone
   * would leave a usable session behind, so the order matters.
   */
  logout: adminOs.logout.handler(async ({ context }) => {
    requireAdmin(context);

    const token = parseCookies(context.request.headers.get('cookie'))[sessionCookieName()];
    if (!token) return { ok: true as const };

    const response = await fetch(`${internalServiceUrl('auth')}/service/auth/rpc/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${sessionCookieName()}=${encodeURIComponent(token)}`,
        [REQUEST_ID_HEADER]: context.requestId,
      },
      body: JSON.stringify({ json: {} }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'Sign out could not be completed' });
    }

    for (const cookie of response.headers.getSetCookie()) {
      context.resHeaders.append('set-cookie', cookie);
    }

    return { ok: true as const };
  }),
});

/** Typed client for Auth's internal surface, used by authorization and the administrator list. */
export function createAuthClient(requestId: string): AuthClient {
  return createRpcClient<AuthClient>({
    url: `${internalServiceUrl('auth')}/internal/rpc`,
    headers: { [REQUEST_ID_HEADER]: requestId },
  });
}
