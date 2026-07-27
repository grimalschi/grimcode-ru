import { ORPCError } from '@orpc/client';
import { implement } from '@orpc/server';
import { authPublicContract, type Identity } from '@template/contracts';
import {
  createRateLimiter,
  hashPassword,
  intEnv,
  parseCookies,
  publicSiteUrl,
  sessionCookieName,
  verifyPassword,
  type Logger,
} from '@template/shared';

import type { Notifier } from '../notifier.js';
import type { AuthRepository, IdentityRow } from '../repository.js';
import {
  expiredSessionCookie,
  newSessionToken,
  sessionCookie,
  SESSION_TTL_SECONDS,
} from '../sessions.js';
import { toIdentity } from '../repository.js';

export interface PublicContext {
  repo: AuthRepository;
  notifier: Notifier;
  logger: Logger;
  request: Request;
  resHeaders: Headers;
}

const VERIFICATION_TTL_SECONDS = 60 * 60 * 24;

/**
 * How often one account can actually be mailed a recovery link.
 *
 * Anyone may ask for a reset for any address without a session, so a per-request dedupe key would
 * let a stranger send unlimited mail to someone else. Bucketing the key by time means repeated
 * requests inside the window collapse onto the same notification, which Notifications already
 * deduplicates — the person gets one letter, not a flood.
 */
const RESET_REQUEST_WINDOW_MS = 15 * 60 * 1000;

/**
 * Password guessing against one address is not free.
 *
 * Counted per address rather than per client: the address is the thing Auth actually knows, and it
 * is what an attacker has to keep hitting. Rate limits per client address belong to the proxy in
 * front of Gateway, which is the only part that sees the real one.
 */
const loginAttempts = createRateLimiter({
  limit: intEnv('AUTH_LOGIN_ATTEMPT_LIMIT', 10),
  windowMs: intEnv('AUTH_LOGIN_ATTEMPT_WINDOW_SECONDS', 15 * 60) * 1000,
});
const RESET_TTL_SECONDS = 60 * 60;
const EMAIL_CHANGE_TTL_SECONDS = 60 * 60;

/**
 * A fixed hash verified when no identity was found, so a wrong email and a wrong password take
 * comparable time and login cannot be used to probe which addresses exist.
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);

const os = implement(authPublicContract).$context<PublicContext>();

async function currentIdentity(context: PublicContext): Promise<{ row: IdentityRow; token: string }> {
  const token = parseCookies(context.request.headers.get('cookie'))[sessionCookieName()];
  if (!token) throw new ORPCError('UNAUTHORIZED', { message: 'Сессия не активна' });

  const resolved = await context.repo.resolveSession(token);
  if (!resolved || resolved.identity.blocked_at !== null) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Сессия не активна' });
  }
  return { row: resolved.identity, token };
}

function appUrl(path: string, token: string): string {
  return `${publicSiteUrl()}/app/${path}?token=${encodeURIComponent(token)}`;
}

async function openSession(context: PublicContext, identityId: string): Promise<void> {
  const token = newSessionToken();
  const ttl = SESSION_TTL_SECONDS();
  await context.repo.createSession(
    identityId,
    token,
    ttl,
    context.request.headers.get('user-agent'),
  );
  context.resHeaders.append('set-cookie', sessionCookie(token, ttl));
}

export const publicRouter = os.router({
  register: os.register.handler(async ({ input, context }): Promise<{ ok: true; identity: Identity }> => {
    const existing = await context.repo.findIdentityByEmail(input.email);
    if (existing) {
      /*
       * This does tell the caller that the address is taken, and there is no way around it that a
       * person would forgive: a registration form that silently pretends to succeed leaves someone
       * who simply forgot they had an account with no idea what happened.
       *
       * Sign-in and recovery are the flows that must not disclose, and they do not. A project that
       * needs registration not to either replaces this with an "someone tried to register with
       * your address" message to the existing account — see docs/admin-access.md.
       */
      throw new ORPCError('CONFLICT', { message: 'Этот адрес уже занят' });
    }

    const identity = await context.repo.createIdentity(
      input.email,
      await hashPassword(input.password),
    );
    await context.repo.audit({ identityId: identity.id, action: 'identity.registered' });

    const token = newSessionToken();
    await context.repo.issueToken(
      identity.id,
      'email-verification',
      token,
      VERIFICATION_TTL_SECONDS,
    );

    await context.notifier.emit(
      {
        type: 'auth.user.registered',
        recipient: {
          identityId: identity.id,
          email: identity.email,
        },
        payload: { verificationUrl: appUrl('verify-email', token) },
      },
      `auth.user.registered:${identity.id}`,
    );

    await openSession(context, identity.id);
    return { ok: true, identity: toIdentity(identity) };
  }),

  login: os.login.handler(async ({ input, context }) => {
    const attemptKey = input.email.trim().toLowerCase();
    if (!loginAttempts.attempt(attemptKey)) {
      // Said the same way to everyone, so the answer still reveals nothing about the address.
      throw new ORPCError('TOO_MANY_REQUESTS', {
        message: 'Слишком много попыток входа. Попробуйте позже',
      });
    }

    const identity = await context.repo.findIdentityByEmail(input.email);

    const valid = identity
      ? await verifyPassword(input.password, identity.password_hash)
      : await verifyPassword(input.password, DUMMY_PASSWORD_HASH);

    if (!identity || !valid) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Неверный адрес или пароль' });
    }
    if (identity.blocked_at !== null) {
      await context.repo.audit({ identityId: identity.id, action: 'login.blocked' });
      throw new ORPCError('FORBIDDEN', { message: 'Аккаунт заблокирован' });
    }

    const token = newSessionToken();
    const ttl = SESSION_TTL_SECONDS();
    await context.repo.createSession(
      identity.id,
      token,
      ttl,
      context.request.headers.get('user-agent'),
    );
    await context.repo.touchLogin(identity.id);
    await context.repo.audit({ identityId: identity.id, action: 'login.succeeded' });
    // Signing in successfully means the failures before it were this person mistyping.
    loginAttempts.clear(attemptKey);

    context.resHeaders.append('set-cookie', sessionCookie(token, ttl));
    return { ok: true as const, identity: toIdentity(identity) };
  }),

  /** Server-side logout: the session row is invalidated first, the cookie is cleared after. */
  logout: os.logout.handler(async ({ context }) => {
    const token = parseCookies(context.request.headers.get('cookie'))[sessionCookieName()];
    if (token) await context.repo.revokeSessionByToken(token);
    context.resHeaders.append('set-cookie', expiredSessionCookie());
    return { ok: true as const };
  }),

  currentSession: os.currentSession.handler(async ({ context }) => {
    const token = parseCookies(context.request.headers.get('cookie'))[sessionCookieName()];
    if (!token) return { identity: null };

    const resolved = await context.repo.resolveSession(token);
    if (!resolved || resolved.identity.blocked_at !== null) return { identity: null };
    return { identity: toIdentity(resolved.identity) };
  }),

  listOwnSessions: os.listOwnSessions.handler(async ({ context }) => {
    const { row, token } = await currentIdentity(context);
    const current = await context.repo.resolveSession(token);
    const sessions = await context.repo.listSessions(row.id);

    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        createdAt: session.created_at.toISOString(),
        lastSeenAt: session.last_seen_at.toISOString(),
        expiresAt: session.expires_at.toISOString(),
        userAgent: session.user_agent,
        current: session.id === current?.session.id,
      })),
    };
  }),

  revokeOwnSessions: os.revokeOwnSessions.handler(async ({ context }) => {
    const { row } = await currentIdentity(context);
    await context.repo.revokeAllSessions(row.id);
    await context.repo.audit({ identityId: row.id, action: 'sessions.revoked.self' });
    context.resHeaders.append('set-cookie', expiredSessionCookie());
    return { ok: true as const };
  }),

  /** Always answers `ok`, so the flow never reveals whether an address is registered. */
  requestPasswordReset: os.requestPasswordReset.handler(async ({ input, context }) => {
    const identity = await context.repo.findIdentityByEmail(input.email);

    if (identity && identity.blocked_at === null) {
      const token = newSessionToken();
      await context.repo.issueToken(identity.id, 'password-reset', token, RESET_TTL_SECONDS);
      await context.repo.audit({ identityId: identity.id, action: 'password.reset.requested' });

      await context.notifier.emit(
        {
          type: 'auth.password.reset_requested',
          recipient: {
            identityId: identity.id,
            email: identity.email,
          },
          payload: { resetUrl: appUrl('reset-password/confirm', token) },
        },
        `auth.password.reset_requested:${identity.id}:${Math.floor(Date.now() / RESET_REQUEST_WINDOW_MS)}`,
      );
    }

    return { ok: true as const };
  }),

  resetPassword: os.resetPassword.handler(async ({ input, context }) => {
    const consumed = await context.repo.consumeToken(input.token, 'password-reset');
    if (!consumed) throw new ORPCError('BAD_REQUEST', { message: 'Ссылка больше не действует' });

    await context.repo.setPasswordHash(consumed.identity_id, await hashPassword(input.password));
    // A password change ends every existing session, including any an attacker may hold.
    await context.repo.revokeAllSessions(consumed.identity_id);
    await context.repo.audit({ identityId: consumed.identity_id, action: 'password.reset' });

    context.resHeaders.append('set-cookie', expiredSessionCookie());
    return { ok: true as const };
  }),

  changePassword: os.changePassword.handler(async ({ input, context }) => {
    const { row } = await currentIdentity(context);

    if (!(await verifyPassword(input.currentPassword, row.password_hash))) {
      throw new ORPCError('UNAUTHORIZED', { message: 'Текущий пароль неверен' });
    }

    await context.repo.setPasswordHash(row.id, await hashPassword(input.password));
    await context.repo.revokeAllSessions(row.id);
    await context.repo.audit({ identityId: row.id, action: 'password.changed' });

    // The caller stays signed in on this device with a fresh session.
    await openSession(context, row.id);
    return { ok: true as const };
  }),

  verifyEmail: os.verifyEmail.handler(async ({ input, context }) => {
    const consumed = await context.repo.consumeToken(input.token, 'email-verification');
    if (!consumed) throw new ORPCError('BAD_REQUEST', { message: 'Ссылка больше не действует' });

    await context.repo.markEmailVerified(consumed.identity_id);
    await context.repo.audit({ identityId: consumed.identity_id, action: 'email.verified' });
    return { ok: true as const };
  }),

  resendOwnVerification: os.resendOwnVerification.handler(async ({ context }) => {
    const { row } = await currentIdentity(context);
    if (row.email_verified_at !== null) return { ok: true as const };

    const token = newSessionToken();
    await context.repo.issueToken(row.id, 'email-verification', token, VERIFICATION_TTL_SECONDS);

    await context.notifier.emit(
      {
        type: 'auth.email.verification_requested',
        recipient: {
          identityId: row.id,
          email: row.email,
        },
        payload: { verificationUrl: appUrl('verify-email', token) },
      },
      `auth.email.verification_requested:${row.id}:${Date.now()}`,
    );

    return { ok: true as const };
  }),

  requestEmailChange: os.requestEmailChange.handler(async ({ input, context }) => {
    const { row } = await currentIdentity(context);

    const taken = await context.repo.findIdentityByEmail(input.email);
    // Answering `ok` here too keeps the flow from confirming that an address is registered.
    if (taken) return { ok: true as const };

    const token = newSessionToken();
    await context.repo.issueToken(row.id, 'email-change', token, EMAIL_CHANGE_TTL_SECONDS, {
      email: input.email,
    });

    await context.notifier.emit(
      {
        type: 'auth.email.change_requested',
        recipient: {
          identityId: row.id,
          email: input.email,
        },
        payload: { confirmUrl: appUrl('confirm-email-change', token) },
      },
      `auth.email.change_requested:${row.id}:${Date.now()}`,
    );

    return { ok: true as const };
  }),

  confirmEmailChange: os.confirmEmailChange.handler(async ({ input, context }) => {
    const consumed = await context.repo.consumeToken(input.token, 'email-change');
    if (!consumed) throw new ORPCError('BAD_REQUEST', { message: 'Ссылка больше не действует' });

    const nextEmail = consumed.payload.email;
    if (typeof nextEmail !== 'string') {
      throw new ORPCError('BAD_REQUEST', { message: 'Ссылка больше не действует' });
    }

    const previous = await context.repo.findIdentityById(consumed.identity_id);
    if (!previous) throw new ORPCError('BAD_REQUEST', { message: 'Ссылка больше не действует' });

    await context.repo.setEmail(consumed.identity_id, nextEmail);
    await context.repo.audit({
      identityId: consumed.identity_id,
      action: 'email.changed',
      details: { previousEmail: previous.email },
    });

    // The previous address is told about the change, so a hijacked account is noticed.
    await context.notifier.emit(
      {
        type: 'auth.email.changed',
        recipient: {
          identityId: consumed.identity_id,
          email: previous.email,
        },
        payload: { previousEmail: previous.email },
      },
      `auth.email.changed:${consumed.id}`,
    );

    return { ok: true as const };
  }),
});
