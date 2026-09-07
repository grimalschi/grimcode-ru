import type { AdminContext } from '../vocabulary.js';
import { TRPCError } from '@trpc/server';

import { isCsrfValid } from '../http/csrf.js';

/**
 * What every procedure in this template can count on having.
 *
 * `request` is how a procedure reaches the cookies and the CSRF header, `resHeaders` how it writes
 * one back. tRPC carries no response headers of its own, so the mount merges them afterwards.
 */
export interface RpcContext {
  request: Request;
  resHeaders: Headers;
}

export interface AdminAwareContext extends RpcContext {
  admin: AdminContext | null;
}

/**
 * The two guards every admin surface is built from, and the only copies of them.
 *
 * Plain functions rather than ready-made procedure builders, because a factory does not survive
 * tRPC's types: `initTRPC.context<TContext>()` inside a generic function produces builders that
 * cannot be composed. Each surface calls `initTRPC` with its own context and pipes these two in.
 */

/** The verified administrator, or a refusal. Used by every admin procedure, reads included. */
export function verifiedAdmin(ctx: AdminAwareContext): AdminContext {
  if (!ctx.admin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Контекст администратора отсутствует' });
  }
  return ctx.admin;
}

/**
 * The CSRF token of one surface, or a refusal. Used by every admin procedure that **changes**
 * something, and by no other — that difference is the whole rule.
 *
 * The scope is the surface, because they share an origin: a single cookie name would mean whichever
 * asked last overwrites the others, and the first is refused on its next change with nothing to say.
 */
export function requireCsrf(ctx: RpcContext, scope: string): void {
  if (!isCsrfValid(ctx.request.headers, scope)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'CSRF-токен отсутствует или неверен' });
  }
}
