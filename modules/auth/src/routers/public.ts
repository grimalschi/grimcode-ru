import { emailSchema, okSchema } from '@template/shared/vocabulary';
import { z } from 'zod';
import {
  expiredSessionCookie,
  hashPassword,
  parseCookies,
  publicSiteUrl,
  sessionCookie,
  sessionCookieName,
  verifyPassword,
  type RateLimiter,
  type RpcContext,
} from '@template/shared';
import { initTRPC, TRPCError } from '@trpc/server';

import type { AuthEnv } from '../env.js';
import type { Notifier } from '../notifier.js';
import type { AuthRepository, IdentityRow } from '../repository.js';
import { identitySchema, passwordSchema, sessionSummarySchema, type Identity } from '../schemas.js';
import { newSessionToken } from '../sessions.js';
import { toIdentity } from '../repository.js';

export interface PublicContext extends RpcContext {
  repo: AuthRepository;
  notifier: Notifier;
  /**
   * The part of `AuthEnv` these procedures need. Narrowed rather than passed whole: the connection
   * string beside it is this module's own, and no procedure has any use for it.
   */
  env: Pick<AuthEnv, 'sessionTtlSeconds'>;
  /**
   * Password guessing, counted per address. Handed in rather than made here: one limiter per
   * application instead of one per module load, and the window it counts in comes from the composer.
   */
  loginAttempts: RateLimiter;
}

const VERIFICATION_TTL_SECONDS = 60 * 60 * 24;

/**
 * How often one account can actually be mailed a recovery link.
 *
 * Anyone may ask for a reset for any address without a session, so a per-request dedupe key would
 * let a stranger send unlimited mail to someone else. Bucketing the key by time collapses repeated
 * requests onto the same notification, which Notifications already deduplicates.
 */
const RESET_REQUEST_WINDOW_MS = 15 * 60 * 1000;

const RESET_TTL_SECONDS = 60 * 60;
const EMAIL_CHANGE_TTL_SECONDS = 60 * 60;

/**
 * A fixed hash verified when no identity was found, so a wrong email and a wrong password take
 * comparable time and login cannot be used to probe which addresses exist.
 */
export const DUMMY_PASSWORD_HASH = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);

const t = initTRPC.context<PublicContext>().create();

async function currentIdentity(ctx: PublicContext): Promise<{ row: IdentityRow; token: string }> {
  const token = parseCookies(ctx.request.headers.get('cookie'))[sessionCookieName()];
  if (!token) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Сессия не активна' });

  const resolved = await ctx.repo.resolveSession(token);
  if (!resolved || resolved.identity.blocked_at !== null) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Сессия не активна' });
  }
  return { row: resolved.identity, token };
}

function appUrl(path: string, token: string): string {
  return `${publicSiteUrl()}/app/${path}?token=${encodeURIComponent(token)}`;
}

async function openSession(ctx: PublicContext, identityId: string): Promise<void> {
  const token = newSessionToken();
  const ttl = ctx.env.sessionTtlSeconds;
  await ctx.repo.createSession(identityId, token, ttl, ctx.request.headers.get('user-agent'));
  ctx.resHeaders.append('set-cookie', sessionCookie(token, ttl));
}

/**
 * The public surface, by name, and the widest of the three: Gateway performs no check on
 * `/service/auth/rpc`, so every procedure here is reachable by anyone on the internet and secures
 * itself. A name from the internal list appearing here would publish it to the world —
 * `resolveSession` turns a token into an identity.
 */
type PublicName =
  | 'register'
  | 'login'
  | 'logout'
  | 'currentSession'
  | 'listOwnSessions'
  | 'revokeOwnSessions'
  | 'requestPasswordReset'
  | 'resetPassword'
  | 'changePassword'
  | 'verifyEmail'
  | 'resendOwnVerification'
  | 'requestEmailChange'
  | 'confirmEmailChange';

export const publicRouter = t.router({
  register: t.procedure
    .input(z.object({ email: emailSchema, password: passwordSchema }))
    .output(z.object({ ok: z.literal(true), identity: identitySchema }))
    .mutation(
    async ({ input, ctx }): Promise<{ ok: true; identity: Identity }> => {
      const existing = await ctx.repo.findIdentityByEmail(input.email);
      if (existing) {
        /*
         * This does tell the caller that the address is taken, and there is no way around it that a
         * person would forgive: a form that silently pretends to succeed leaves someone who forgot
         * they had an account with no idea what happened. Sign-in and recovery are the flows that
         * must not disclose, and they do not; a project that needs this one not to either answers
         * `ok` and sends the existing account a "someone tried to register" message instead.
         */
        throw new TRPCError({ code: 'CONFLICT', message: 'Этот адрес уже занят' });
      }

      const identity = await ctx.repo.createIdentity(
        input.email,
        await hashPassword(input.password),
      );
      await ctx.repo.audit({ identityId: identity.id, action: 'identity.registered' });

      const token = newSessionToken();
      await ctx.repo.issueToken(identity.id, 'email-verification', token, VERIFICATION_TTL_SECONDS);

      await ctx.notifier.emit(
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

      await openSession(ctx, identity.id);
      return { ok: true, identity: toIdentity(identity) };
    },
  ),

  login: t.procedure
    .input(z.object({ email: emailSchema, password: z.string().min(1).max(200) }))
    .output(z.object({ ok: z.literal(true), identity: identitySchema }))
    .mutation(async ({ input, ctx }) => {
    const attemptKey = input.email.trim().toLowerCase();
    if (!ctx.loginAttempts.attempt(attemptKey)) {
      // Said the same way to everyone, so the answer still reveals nothing about the address.
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Слишком много попыток входа. Попробуйте позже',
      });
    }

    const identity = await ctx.repo.findIdentityByEmail(input.email);

    const valid = identity
      ? await verifyPassword(input.password, identity.password_hash)
      : await verifyPassword(input.password, DUMMY_PASSWORD_HASH);

    if (!identity || !valid) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Неверный адрес или пароль' });
    }
    if (identity.blocked_at !== null) {
      await ctx.repo.audit({ identityId: identity.id, action: 'login.blocked' });
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Аккаунт заблокирован' });
    }

    const token = newSessionToken();
    const ttl = ctx.env.sessionTtlSeconds;
    await ctx.repo.createSession(identity.id, token, ttl, ctx.request.headers.get('user-agent'));
    await ctx.repo.touchLogin(identity.id);
    await ctx.repo.audit({ identityId: identity.id, action: 'login.succeeded' });
    // Signing in successfully means the failures before it were this person mistyping.
    ctx.loginAttempts.clear(attemptKey);

    ctx.resHeaders.append('set-cookie', sessionCookie(token, ttl));
    return { ok: true as const, identity: toIdentity(identity) };
  }),

  /** Server-side logout: the session row is invalidated first, the cookie is cleared after. */
  logout: t.procedure
    .input(z.object({}))
    .output(okSchema)
    .mutation(async ({ ctx }) => {
    const token = parseCookies(ctx.request.headers.get('cookie'))[sessionCookieName()];
    if (token) await ctx.repo.revokeSessionByToken(token);
    ctx.resHeaders.append('set-cookie', expiredSessionCookie());
    return { ok: true as const };
  }),

  currentSession: t.procedure
    .input(z.object({}))
    .output(z.object({ identity: identitySchema.nullable() }))
    .query(
    async ({ ctx }) => {
      const token = parseCookies(ctx.request.headers.get('cookie'))[sessionCookieName()];
      if (!token) return { identity: null };

      const resolved = await ctx.repo.resolveSession(token);
      if (!resolved || resolved.identity.blocked_at !== null) return { identity: null };
      return { identity: toIdentity(resolved.identity) };
    },
  ),

  listOwnSessions: t.procedure
    .input(z.object({}))
    .output(z.object({ sessions: z.array(sessionSummarySchema) }))
    .query(
    async ({ ctx }) => {
      const { row, token } = await currentIdentity(ctx);
      const current = await ctx.repo.resolveSession(token);
      const sessions = await ctx.repo.listSessions(row.id);

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
    },
  ),

  revokeOwnSessions: t.procedure
    .input(z.object({}))
    .output(okSchema)
    .mutation(
    async ({ ctx }) => {
      const { row } = await currentIdentity(ctx);
      await ctx.repo.revokeAllSessions(row.id);
      await ctx.repo.audit({ identityId: row.id, action: 'sessions.revoked.self' });
      ctx.resHeaders.append('set-cookie', expiredSessionCookie());
      return { ok: true as const };
    },
  ),

  /** Always answers `ok`, so the flow never reveals whether an address is registered. */
  requestPasswordReset: t.procedure
    .input(z.object({ email: emailSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const identity = await ctx.repo.findIdentityByEmail(input.email);

      if (identity && identity.blocked_at === null) {
        const token = newSessionToken();
        await ctx.repo.issueToken(identity.id, 'password-reset', token, RESET_TTL_SECONDS);
        await ctx.repo.audit({ identityId: identity.id, action: 'password.reset.requested' });

        await ctx.notifier.emit(
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
    },
  ),

  resetPassword: t.procedure
    .input(z.object({ token: z.string().min(20).max(200), password: passwordSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const consumed = await ctx.repo.consumeToken(input.token, 'password-reset');
      if (!consumed)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ссылка больше не действует' });

      await ctx.repo.setPasswordHash(consumed.identity_id, await hashPassword(input.password));
      // A password change ends every existing session, including any an attacker may hold.
      await ctx.repo.revokeAllSessions(consumed.identity_id);
      await ctx.repo.audit({ identityId: consumed.identity_id, action: 'password.reset' });

      ctx.resHeaders.append('set-cookie', expiredSessionCookie());
      return { ok: true as const };
    },
  ),

  changePassword: t.procedure
    .input(z.object({ currentPassword: z.string().min(1).max(200), password: passwordSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const { row } = await currentIdentity(ctx);

      if (!(await verifyPassword(input.currentPassword, row.password_hash))) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Текущий пароль неверен' });
      }

      await ctx.repo.setPasswordHash(row.id, await hashPassword(input.password));
      await ctx.repo.revokeAllSessions(row.id);
      await ctx.repo.audit({ identityId: row.id, action: 'password.changed' });

      // The caller stays signed in on this device with a fresh session.
      await openSession(ctx, row.id);
      return { ok: true as const };
    },
  ),

  verifyEmail: t.procedure
    .input(z.object({ token: z.string().min(20).max(200) }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const consumed = await ctx.repo.consumeToken(input.token, 'email-verification');
      if (!consumed)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ссылка больше не действует' });

      await ctx.repo.markEmailVerified(consumed.identity_id);
      await ctx.repo.audit({ identityId: consumed.identity_id, action: 'email.verified' });
      return { ok: true as const };
    },
  ),

  resendOwnVerification: t.procedure
    .input(z.object({}))
    .output(okSchema)
    .mutation(async ({ ctx }) => {
    const { row } = await currentIdentity(ctx);
    if (row.email_verified_at !== null) return { ok: true as const };

    const token = newSessionToken();
    await ctx.repo.issueToken(row.id, 'email-verification', token, VERIFICATION_TTL_SECONDS);

    await ctx.notifier.emit(
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

  requestEmailChange: t.procedure
    .input(z.object({ email: emailSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const { row } = await currentIdentity(ctx);

      const taken = await ctx.repo.findIdentityByEmail(input.email);
      // Answering `ok` here too keeps the flow from confirming that an address is registered.
      if (taken) return { ok: true as const };

      const token = newSessionToken();
      await ctx.repo.issueToken(row.id, 'email-change', token, EMAIL_CHANGE_TTL_SECONDS, {
        email: input.email,
      });

      await ctx.notifier.emit(
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
    },
  ),

  confirmEmailChange: t.procedure
    .input(z.object({ token: z.string().min(20).max(200) }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const consumed = await ctx.repo.consumeToken(input.token, 'email-change');
      if (!consumed)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ссылка больше не действует' });

      const nextEmail = consumed.payload.email;
      if (typeof nextEmail !== 'string') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ссылка больше не действует' });
      }

      const previous = await ctx.repo.findIdentityById(consumed.identity_id);
      if (!previous)
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ссылка больше не действует' });

      await ctx.repo.setEmail(consumed.identity_id, nextEmail);
      await ctx.repo.audit({
        identityId: consumed.identity_id,
        action: 'email.changed',
        details: { previousEmail: previous.email },
      });

      // The previous address is told about the change, so a hijacked account is noticed.
      await ctx.notifier.emit(
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
    },
  ),
} satisfies Record<PublicName, unknown>);


/** The application's browser client is typed from this, and from nothing else. */
export type AuthPublicRouter = typeof publicRouter;
