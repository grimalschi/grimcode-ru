import type { TRPCBuiltRouter, TRPCDefaultErrorShape, TRPCMutationProcedure, TRPCQueryProcedure } from '@trpc/server';

/** Auth identity; product profile and administrator rights belong to other APIs. */
export interface Identity {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  blockedAt: string | null;
  createdAt: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  current: boolean;
}

export interface AdminIdentity extends Identity {
  activeSessionCount: number;
  lastLoginAt: string | null;
}

export interface AuthAuditEntry {
  id: string;
  identityId: string | null;
  action: string;
  actorUserId: string | null;
  actorRole: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AuthApi {
  setIdentityBlocked: (input: { userId: string; blocked: boolean }) => Promise<{ ok: true }>;
  resolveSession: (input: { sessionToken: string }) => Promise<{ identity: Identity | null }>;
  revokeSessionByToken: (input: { sessionToken: string }) => Promise<{ ok: true }>;
  getFirstIdentity: (input: Record<string, never>) => Promise<{ identity: Identity | null }>;
  getIdentitiesByIds: (input: { ids: string[] }) => Promise<{ identities: Identity[] }>;
  searchIdentities: (input: { query: string; limit?: number }) => Promise<{ identities: Identity[] }>;
  getIdentityByEmail: (input: { email: string }) => Promise<{ identity: Identity | null }>;
}

/** Browser HTTP contract; runtime validation is implemented by Auth. */
export type AuthPublicRouter<Context extends object = object> = TRPCBuiltRouter<{
  ctx: Context;
  meta: object;
  errorShape: TRPCDefaultErrorShape;
  transformer: false;
}, {
  register: TRPCMutationProcedure<{ input: { email: string; password: string }; output: { ok: true; identity: Identity }; meta: object }>;
  login: TRPCMutationProcedure<{ input: { email: string; password: string }; output: { ok: true; identity: Identity }; meta: object }>;
  logout: TRPCMutationProcedure<{ input: Record<string, never>; output: { ok: true }; meta: object }>;
  currentSession: TRPCQueryProcedure<{ input: Record<string, never>; output: { identity: Identity | null }; meta: object }>;
  listOwnSessions: TRPCQueryProcedure<{ input: Record<string, never>; output: { sessions: SessionSummary[] }; meta: object }>;
  revokeOwnSessions: TRPCMutationProcedure<{ input: Record<string, never>; output: { ok: true }; meta: object }>;
  requestPasswordReset: TRPCMutationProcedure<{ input: { email: string }; output: { ok: true }; meta: object }>;
  resetPassword: TRPCMutationProcedure<{ input: { token: string; password: string }; output: { ok: true }; meta: object }>;
  changePassword: TRPCMutationProcedure<{ input: { currentPassword: string; password: string }; output: { ok: true }; meta: object }>;
  verifyEmail: TRPCMutationProcedure<{ input: { token: string }; output: { ok: true }; meta: object }>;
  resendOwnVerification: TRPCMutationProcedure<{ input: Record<string, never>; output: { ok: true }; meta: object }>;
  requestEmailChange: TRPCMutationProcedure<{ input: { email: string }; output: { ok: true }; meta: object }>;
  confirmEmailChange: TRPCMutationProcedure<{ input: { token: string }; output: { ok: true }; meta: object }>;
}>;
