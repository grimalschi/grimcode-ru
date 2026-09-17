import { initTRPC, TRPCError } from '@trpc/server';
import type { AdminContext } from '@template/contracts/module-instance';
import type { ModuleContext } from '../context.js';
import type { AdminEnv } from '../env.js';
import { isCsrfValid } from '../http/csrf.js';

export interface AdminRpcContext extends ModuleContext {
  request: Request;
  resHeaders: Headers;
  adminContext: AdminContext;
  env: Pick<AdminEnv, 'sessionCookieName' | 'publicOrigin' | 'csrfCookieName'>;
}

// No stack in any answer — tRPC adds one outside production — and generic wording only for internal failures.
export const adminT = initTRPC.context<AdminRpcContext>().create({
  errorFormatter: ({ shape, error }): typeof shape => ({
    ...shape,
    message: error.code === 'INTERNAL_SERVER_ERROR' ? 'Внутренняя ошибка' : shape.message,
    data: { ...shape.data, stack: undefined },
  }),
});

/** Procedures declare their required role and whether they need CSRF. */
export const adminProcedure = adminT.procedure.use(({ ctx, next }) => {
  if (!ctx.adminContext) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Контекст администратора отсутствует' });
  }
  return next();
});

const requireCsrf = adminT.middleware(({ ctx, next }) => {
  if (!isCsrfValid(ctx.request.headers, ctx.env.csrfCookieName)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'CSRF-токен отсутствует или неверен' });
  }
  return next();
});

export const adminMutation = adminProcedure.use(requireCsrf);

export const ownerProcedure = adminProcedure.use(({ ctx, next }) => {
  if (ctx.adminContext.role !== 'owner') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Доступно только владельцу' });
  }
  return next();
});

export const ownerMutation = ownerProcedure.use(requireCsrf);
