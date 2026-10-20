import type { inferRouterInputs } from '@trpc/server';
import type { AuthPublicRouter as PublicContract, Identity } from '@template/contracts/modules/auth';
import { emailSchema, idSchema, okSchema } from '../primitives.js';
import { z } from 'zod';
import { expiredSessionCookie, parseCookies, sessionCookie } from '../http/cookies.js';
import type { RpcContext } from '../trpc/context.js';
import { initTRPC, TRPCError } from '@trpc/server';

import type { AuthEnv } from '../env.js';
import { hashPassword, newToken, sha256, verifyPassword } from '../crypto.js';
import type { RateLimiter } from '../rate-limit.js';
import type { Notifier } from '../notifier.js';
import type { AuthRepository, IdentityRow } from '../repository.js';
import { identitySchema, passwordSchema, sessionSummarySchema } from '../schemas.js';
import { toIdentity } from '../repository.js';

export interface PublicContext extends RpcContext {
  repo: AuthRepository;
  notifier: Notifier;
  /**
   * The part of `AuthEnv` these procedures need. Narrowed rather than passed whole: the connection
   * string beside it is this module's own, and no procedure has any use for it.
   */
  env: Required<Pick<AuthEnv, 'sessionTtlSeconds' | 'publicOrigin' | 'sessionCookieName'>>;
  /**
   * Password guessing, counted per address. Handed in rather than made here: one limiter per
   * application instead of one per module load, and its limits are constants in this surface’s factory.
   */
  loginAttempts: RateLimiter;
  /**
   * Guessing the current password from an open session, counted per account and shared by every
   * procedure that asks for it, so alternating them does not double the allowance. Separate from
   * sign-in: running out here does not lock the person out of signing in, nor the other way round.
   */
  passwordChecks: RateLimiter;
}

const VERIFICATION_TTL_SECONDS = 60 * 60 * 24;

const RESET_REQUEST_WINDOW_SECONDS = 15 * 60;
/**
 * Letters a signed-in person asks for — a fresh verification link, an email-change link — at most one
 * per account in this window, and an email-change link at most one per target address. Without it the
 * buttons mail any address in a loop.
 */
const RESEND_WINDOW_SECONDS = 5 * 60;
const RESEND_REFUSAL = 'Письмо уже отправлено. Новое можно запросить не раньше чем через 5 минут';

const RESET_TTL_SECONDS = 60 * 60;
const EMAIL_CHANGE_TTL_SECONDS = 60 * 60;

/**
 * A fixed hash verified when no identity was found, so a wrong email and a wrong password take
 * comparable time and login cannot be used to probe which addresses exist.
 */
export const DUMMY_PASSWORD_HASH = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);

const t = initTRPC.context<PublicContext>().create({
  errorFormatter: ({ shape, error }): typeof shape => ({
    ...shape,
    message: error.code === 'INTERNAL_SERVER_ERROR' ? 'Не удалось выполнить запрос' : shape.message,
    data: { ...shape.data, stack: undefined },
  }),
});

async function currentIdentity(ctx: PublicContext): Promise<{ row: IdentityRow; token: string; sessionId: string }> {
  const token = parseCookies(ctx.request.headers.get('cookie'))[ctx.env.sessionCookieName];
  if (!token) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Сессия не активна' });

  const resolved = await ctx.repo.resolveSession(token);
  if (!resolved || resolved.identity.blocked_at !== null) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Сессия не активна' });
  }
  return { row: resolved.identity, token, sessionId: resolved.session.id };
}

function appUrl(publicOrigin: string, path: string, token: string): string {
  return `${publicOrigin}/app/${path}?token=${encodeURIComponent(token)}`;
}

/**
 * Opens the session on the repository it is given — inside the caller's transaction — and returns
 * the cookie for it. The caller sets the cookie only once the transaction has committed: a rollback
 * takes the session row back, but not a header already added to the response, and a browser would
 * replace its working cookie with the token of a session that does not exist.
 */
/**
 * The current password, asked before changing what recovers the account. Past the allowance it is
 * not checked at all, as with sign-in; the first refusal in a window is journaled once, the ones
 * after it are not. A match clears the count.
 */
async function checkCurrentPassword(ctx: PublicContext, row: IdentityRow, password: string, procedure: string): Promise<void> {
  const allowance = ctx.passwordChecks.check(row.id);
  if (allowance !== 'allowed') {
    if (allowance === 'first-refusal') {
      await ctx.repo.audit({ identityId: row.id, action: 'password.check.limited', details: { procedure } });
    }
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Слишком много попыток. Попробуйте позже' });
  }
  if (!(await verifyPassword(password, row.password_hash))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Текущий пароль неверен' });
  }
  ctx.passwordChecks.clear(row.id);
}

async function openSession(ctx: PublicContext, repo: AuthRepository, identity: IdentityRow): Promise<string> {
  const token = newToken();
  const ttl = ctx.env.sessionTtlSeconds;
  const session = await repo.createSession(identity, token, ttl, ctx.request.headers.get('user-agent'));
  if (!session) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Данные входа изменились. Войдите снова' });
  return sessionCookie(token, ttl, ctx.env);
}

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

      // Hashing is slow on purpose; it happens before a connection is held.
      const passwordHash = await hashPassword(input.password);
      const token = newToken();
      const { identity, cookie } = await ctx.repo.withTransaction(async (repo) => {
        const created = await repo.createIdentity(input.email, passwordHash);
        await repo.audit({ identityId: created.id, action: 'identity.registered' });
        await repo.issueToken(created.id, 'email-verification', token, VERIFICATION_TTL_SECONDS);
        return { identity: created, cookie: await openSession(ctx, repo, created) };
      });
      ctx.resHeaders.append('set-cookie', cookie);

      // Committed above. The hand-off cannot be rolled back by the database, so it comes last.
      await ctx.notifier.emit(
        {
          type: 'auth.user.registered',
          recipient: {
            identityId: identity.id,
            email: identity.email,
          },
          payload: { verificationUrl: appUrl(ctx.env.publicOrigin, 'verify-email', token) },
        },
        `auth.user.registered:${identity.id}`,
      );

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

    const cookie = await ctx.repo.withTransaction(async (repo) => {
      const opened = await openSession(ctx, repo, identity);
      await repo.touchLogin(identity.id);
      await repo.audit({ identityId: identity.id, action: 'login.succeeded' });
      return opened;
    });
    ctx.resHeaders.append('set-cookie', cookie);
    // Signing in successfully means the failures before it were this person mistyping.
    ctx.loginAttempts.clear(attemptKey);

    return { ok: true as const, identity: toIdentity(identity) };
  }),

  /** Server-side logout: the session row is invalidated first, the cookie is cleared after. */
  logout: t.procedure
    .input(z.object({}))
    .output(okSchema)
    .mutation(async ({ ctx }) => {
    const token = parseCookies(ctx.request.headers.get('cookie'))[ctx.env.sessionCookieName];
    if (token) await ctx.repo.revokeSessionByToken(token);
    ctx.resHeaders.append('set-cookie', expiredSessionCookie(ctx.env));
    return { ok: true as const };
  }),

  currentSession: t.procedure
    .input(z.object({}))
    .output(z.object({ identity: identitySchema.nullable() }))
    .query(
    async ({ ctx }) => {
      const token = parseCookies(ctx.request.headers.get('cookie'))[ctx.env.sessionCookieName];
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

  /**
   * One sign-in of the caller's own, ended from the list — an unfamiliar device closed while every
   * other stays. Not this browser: that is "sign out". Another account's id, or one already ended in
   * another tab, matches nothing and still answers `ok`: nothing about other sessions is told.
   */
  revokeOwnSession: t.procedure
    .input(z.object({ id: idSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const { row, sessionId } = await currentIdentity(ctx);
      if (input.id === sessionId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Это текущий браузер — используйте «Выйти»' });
      }
      await ctx.repo.withTransaction(async (repo) => {
        if (await repo.revokeSession(row.id, input.id)) {
          await repo.audit({ identityId: row.id, action: 'session.revoked.self', details: { sessionId: input.id } });
        }
      });
      return { ok: true as const };
    },
  ),

  /** Every sign-in but this browser's: the answer to "someone else may have my session" that keeps you in. */
  revokeOtherSessions: t.procedure
    .input(z.object({}))
    .output(okSchema)
    .mutation(
    async ({ ctx }) => {
      const { row, sessionId } = await currentIdentity(ctx);
      await ctx.repo.withTransaction(async (repo) => {
        const count = await repo.revokeOtherSessions(row.id, sessionId);
        if (count) await repo.audit({ identityId: row.id, action: 'sessions.revoked.others', details: { count } });
      });
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
        const token = newToken();
        const issued = await ctx.repo.withTransaction(async (repo) => {
          // Too soon or not, the answer is the same `ok`: recovery never says whether an address is registered.
          const done = await repo.issueToken(identity.id, 'password-reset', token, RESET_TTL_SECONDS, {
            email: identity.email, resendAfterSeconds: RESET_REQUEST_WINDOW_SECONDS,
          }) === 'issued';
          if (done) await repo.audit({ identityId: identity.id, action: 'password.reset.requested' });
          return done;
        });
        if (!issued) return { ok: true as const };

        await ctx.notifier.emit(
          {
            type: 'auth.password.reset_requested',
            recipient: {
              identityId: identity.id,
              email: identity.email,
            },
            payload: { resetUrl: appUrl(ctx.env.publicOrigin, 'reset-password/confirm', token) },
          },
          `auth.password.reset_requested:${identity.id}:${sha256(token)}`,
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
      const passwordHash = await hashPassword(input.password);
      const identityId = await ctx.repo.withTransaction(async (repo) => {
        const reset = await repo.resetPassword(input.token, passwordHash);
        if (reset) await repo.audit({ identityId: reset, action: 'password.reset' });
        return reset;
      });
      if (!identityId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ссылка больше не действует' });

      ctx.resHeaders.append('set-cookie', expiredSessionCookie(ctx.env));
      return { ok: true as const };
    },
  ),

  changePassword: t.procedure
    .input(z.object({ currentPassword: z.string().min(1).max(200), password: passwordSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const { row } = await currentIdentity(ctx);
      await checkCurrentPassword(ctx, row, input.currentPassword, 'changePassword');

      const passwordHash = await hashPassword(input.password);
      const cookie = await ctx.repo.withTransaction(async (repo) => {
        if (!await repo.changePassword(row.id, row.password_hash, passwordHash)) {
          throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Данные входа изменились. Войдите снова' });
        }
        await repo.audit({ identityId: row.id, action: 'password.changed' });
        // The caller stays signed in on this device with a fresh session — or, if that fails, keeps
        // the old password and the old sessions, since all of it rolls back together.
        return openSession(ctx, repo, { ...row, password_hash: passwordHash });
      });
      ctx.resHeaders.append('set-cookie', cookie);
      return { ok: true as const };
    },
  ),

  verifyEmail: t.procedure
    .input(z.object({ token: z.string().min(20).max(200) }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const identityId = await ctx.repo.withTransaction(async (repo) => {
        const verified = await repo.verifyEmail(input.token);
        if (verified) await repo.audit({ identityId: verified, action: 'email.verified' });
        return verified;
      });
      if (!identityId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ссылка больше не действует' });
      return { ok: true as const };
    },
  ),

  resendOwnVerification: t.procedure
    .input(z.object({}))
    .output(okSchema)
    .mutation(async ({ ctx }) => {
    const { row } = await currentIdentity(ctx);
    if (row.email_verified_at !== null) return { ok: true as const };

    const token = newToken();
    const issued = await ctx.repo.issueToken(row.id, 'email-verification', token, VERIFICATION_TTL_SECONDS, {
      email: row.email, resendAfterSeconds: RESEND_WINDOW_SECONDS,
    });
    // Said plainly: the person is signed in and asks about their own address.
    if (issued === 'too-soon') throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: RESEND_REFUSAL });
    if (issued === 'stale') throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Данные входа изменились. Войдите снова' });

    await ctx.notifier.emit(
      {
        type: 'auth.email.verification_requested',
        recipient: {
          identityId: row.id,
          email: row.email,
        },
        payload: { verificationUrl: appUrl(ctx.env.publicOrigin, 'verify-email', token) },
      },
      `auth.email.verification_requested:${row.id}:${sha256(token)}`,
    );

    return { ok: true as const };
  }),

  requestEmailChange: t.procedure
    .input(z.object({ currentPassword: z.string().min(1).max(200), email: emailSchema }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const { row } = await currentIdentity(ctx);

      // An open session is not proof of who is at the keyboard, and the address is what recovers the
      // password. Asked first, before the address is looked at: without the password nothing about
      // the address is told. The token below is bound to this very hash, so a change in between fails.
      await checkCurrentPassword(ctx, row, input.currentPassword, 'requestEmailChange');

      const taken = await ctx.repo.findIdentityByEmail(input.email);
      if (taken) {
        // Said plainly, as registration says it: registration tells anyone, without a password, that an
        // address is taken, so hiding it here — behind the password and the five-minute window — would
        // protect nothing and only leave the person guessing why no letter came. The attempt is still
        // recorded; the entry is written on its own, outside any transaction the refusal could undo.
        await ctx.repo.audit({ identityId: row.id, action: 'email.change_requested', details: { email: input.email, taken: true } });
        throw new TRPCError({ code: 'CONFLICT', message: 'Этот адрес уже занят' });
      }

      // Another account mailed this address a moment ago: quietly `ok`, as for a taken address, so the
      // answer does not tell that someone asked for it. Many accounts cannot take turns at one mailbox.
      if (await ctx.repo.recentEmailChangeTo(input.email, row.id, RESEND_WINDOW_SECONDS)) {
        await ctx.repo.audit({ identityId: row.id, action: 'email.change_requested', details: { email: input.email, limited: 'address' } });
        return { ok: true as const };
      }

      const token = newToken();
      // Requested and changed are two entries, as with password recovery; the link and its entry commit together.
      const issued = await ctx.repo.withTransaction(async (repo) => {
        const outcome = await repo.issueToken(row.id, 'email-change', token, EMAIL_CHANGE_TTL_SECONDS, {
          payload: { email: input.email }, passwordHash: row.password_hash, email: row.email, resendAfterSeconds: RESEND_WINDOW_SECONDS,
        });
        if (outcome === 'issued') await repo.audit({ identityId: row.id, action: 'email.change_requested', details: { email: input.email } });
        return outcome;
      });
      if (issued === 'too-soon') {
        await ctx.repo.audit({ identityId: row.id, action: 'email.change_requested', details: { email: input.email, limited: 'account' } });
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: RESEND_REFUSAL });
      }
      if (issued === 'stale') throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Данные входа изменились. Войдите снова' });

      await ctx.notifier.emit(
        {
          type: 'auth.email.change_requested',
          recipient: {
            identityId: row.id,
            email: input.email,
          },
          payload: { confirmUrl: appUrl(ctx.env.publicOrigin, 'confirm-email-change', token) },
        },
        `auth.email.change_requested:${row.id}:${sha256(token)}`,
      );

      return { ok: true as const };
    },
  ),

  confirmEmailChange: t.procedure
    .input(z.object({ token: z.string().min(20).max(200) }))
    .output(okSchema)
    .mutation(
    async ({ input, ctx }) => {
      const changed = await ctx.repo.withTransaction(async (repo) => {
        const result = await repo.confirmEmailChange(input.token);
        if (result) {
          await repo.audit({
            identityId: result.identityId,
            action: 'email.changed',
            details: { previousEmail: result.previousEmail },
          });
        }
        return result;
      });
      if (!changed) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Ссылка больше не действует' });
      ctx.resHeaders.append('set-cookie', expiredSessionCookie(ctx.env));

      // The previous address is told about the change, so a hijacked account is noticed.
      await ctx.notifier.emit(
        {
          type: 'auth.email.changed',
          recipient: {
            identityId: changed.identityId,
            email: changed.previousEmail,
          },
          payload: { previousEmail: changed.previousEmail },
        },
        `auth.email.changed:${changed.tokenId}`,
      );

      return { ok: true as const };
    },
  ),
} satisfies PublicContract['_def']['record']) satisfies PublicContract<PublicContext>;

// Native router assignability permits narrower inputs; require the declared inputs to match.
export interface PublicInputsCheck extends inferRouterInputs<typeof publicRouter>, inferRouterInputs<PublicContract> {}
