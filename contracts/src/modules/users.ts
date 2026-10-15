import type { TRPCBuiltRouter, TRPCDefaultErrorShape, TRPCMutationProcedure, TRPCQueryProcedure } from '@trpc/server';

export interface UserProfile {
  id: string;
  identityId: string;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserProfile extends UserProfile {
  email: string | null;
  /** Auth's blocking state of the account, read with the address; `null` when Auth has no such identity. */
  blockedAt: string | null;
  /** Since when the panel protects the account from blocking (an owner); the screen offers no blocking then. */
  blockingProtectedAt: string | null;
}

/** Browser HTTP contract; runtime validation is implemented by Users. */
export type UsersPublicRouter<Context extends object = object> = TRPCBuiltRouter<{
  ctx: Context;
  meta: object;
  errorShape: TRPCDefaultErrorShape;
  transformer: false;
}, {
  getOwnProfile: TRPCQueryProcedure<{ input: Record<string, never>; output: { profile: UserProfile }; meta: object }>;
  updateOwnProfile: TRPCMutationProcedure<{ input: { displayName: string | null }; output: { ok: true; profile: UserProfile }; meta: object }>;
}>;
