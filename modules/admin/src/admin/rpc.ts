import { initTRPC, TRPCError } from '@trpc/server';
import type { AdminContext } from '@template/contracts/modules/admin';
import type { ModuleContext } from '../context.js';
import type { AdminEnv } from '../env.js';
import { isCsrfValid } from '../http/csrf.js';

export interface AdminRpcContext extends ModuleContext {
  request: Request;
  resHeaders: Headers;
  admin: AdminContext | null;
  env: Pick<AdminEnv, 'sessionCookieName' | 'publicOrigin' | 'csrfCookieName'>;
}

export const adminT = initTRPC.context<AdminRpcContext>().create({
  errorFormatter: ({ shape, error }) => error.code === 'INTERNAL_SERVER_ERROR'
    ? { ...shape, message: 'Внутренняя ошибка', data: { ...shape.data, stack: undefined } }
    : shape,
});

/** Procedures declare their required role and whether they need CSRF. */
export const adminProcedure = adminT.procedure.use(({ ctx, next }) => {
  if (!ctx.admin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Контекст администратора отсутствует' });
  }
  return next({ ctx: { admin: ctx.admin } });
});

const requireCsrf = adminT.middleware(({ ctx, next }) => {
  if (!isCsrfValid(ctx.request.headers, ctx.env.csrfCookieName)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'CSRF-токен отсутствует или неверен' });
  }
  return next();
});

export const adminMutation = adminProcedure.use(requireCsrf);

export const ownerProcedure = adminProcedure.use(({ ctx, next }) => {
  if (ctx.admin.role !== 'owner') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Доступно только владельцу' });
  }
  return next();
});

export const ownerMutation = ownerProcedure.use(requireCsrf);
