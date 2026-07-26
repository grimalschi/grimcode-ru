import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
  emailSchema,
  idSchema,
  isoDateTimeSchema,
  okSchema,
  pageOf,
  paginationInputSchema,
} from './common.js';

/** Minimal identity Auth owns. It is never a product profile — Users owns that. */
export const identitySchema = z.object({
  id: idSchema,
  email: emailSchema,
  emailVerifiedAt: isoDateTimeSchema.nullable(),
  blockedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export type Identity = z.infer<typeof identitySchema>;

export const sessionSummarySchema = z.object({
  id: idSchema,
  createdAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  userAgent: z.string().max(400).nullable(),
  current: z.boolean(),
});

export const adminIdentitySchema = identitySchema.extend({
  activeSessionCount: z.number().int().min(0),
  lastLoginAt: isoDateTimeSchema.nullable(),
});

/** Identity as an administrator sees it, with the counters the admin list shows. */
export type AdminIdentity = z.infer<typeof adminIdentitySchema>;

export const authAuditEntrySchema = z.object({
  id: idSchema,
  identityId: idSchema.nullable(),
  action: z.string().max(80),
  actorUserId: idSchema.nullable(),
  actorRole: z.string().max(20).nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: isoDateTimeSchema,
});

const passwordSchema = z
  .string()
  .min(12, 'Password must contain at least 12 characters')
  .max(200);

/**
 * Public Auth surface. Reachable through Gateway as `/service/auth/rpc`.
 * Gateway performs no authorization here: securing these endpoints is Auth's own responsibility.
 */
export const authPublicContract = {
  register: oc.input(z.object({ email: emailSchema, password: passwordSchema })).output(
    z.object({ ok: z.literal(true), identity: identitySchema }),
  ),

  login: oc
    .input(z.object({ email: emailSchema, password: z.string().min(1).max(200) }))
    .output(z.object({ ok: z.literal(true), identity: identitySchema })),

  /** Server-side logout: the session row is invalidated before the cookie is cleared. */
  logout: oc.input(z.object({})).output(okSchema),

  currentSession: oc
    .input(z.object({}))
    .output(z.object({ identity: identitySchema.nullable() })),

  listOwnSessions: oc
    .input(z.object({}))
    .output(z.object({ sessions: z.array(sessionSummarySchema) })),

  /** Revokes every session of the caller, including the current one. */
  revokeOwnSessions: oc.input(z.object({})).output(okSchema),

  /** Always answers `ok` so that the flow never reveals whether the email exists. */
  requestPasswordReset: oc.input(z.object({ email: emailSchema })).output(okSchema),

  resetPassword: oc
    .input(z.object({ token: z.string().min(20).max(200), password: passwordSchema }))
    .output(okSchema),

  changePassword: oc
    .input(z.object({ currentPassword: z.string().min(1).max(200), password: passwordSchema }))
    .output(okSchema),

  verifyEmail: oc.input(z.object({ token: z.string().min(20).max(200) })).output(okSchema),

  resendOwnVerification: oc.input(z.object({})).output(okSchema),

  requestEmailChange: oc.input(z.object({ email: emailSchema })).output(okSchema),

  confirmEmailChange: oc.input(z.object({ token: z.string().min(20).max(200) })).output(okSchema),
};

/**
 * Internal Auth surface. Mounted on the internal RPC path only and never proxied by Gateway,
 * so it stays reachable exclusively from inside the Docker network.
 */
export const authInternalContract = {
  resolveSession: oc
    .input(z.object({ sessionToken: z.string().min(1).max(400) }))
    .output(z.object({ identity: identitySchema.nullable() })),

  /**
   * Earliest registered identity in a deterministic order. Admin uses it to bootstrap the very
   * first owner; ownership follows registration order, not who opened the admin panel first.
   */
  getFirstIdentity: oc
    .input(z.object({}))
    .output(z.object({ identity: identitySchema.nullable() })),

  /**
   * Several identities at once.
   *
   * Users needs the address for a page of profiles; asking one at a time would be a request per
   * row. Unknown ids are simply absent from the answer.
   */
  getIdentitiesByIds: oc
    .input(z.object({ ids: z.array(idSchema).max(200) }))
    .output(z.object({ identities: z.array(identitySchema) })),

  /**
   * Identities matching a fragment of an address.
   *
   * Admin needs it to let an owner pick a person instead of typing an address exactly right. It is
   * internal: the search itself is not something a client may reach.
   */
  searchIdentities: oc
    .input(z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(20).default(10) }))
    .output(z.object({ identities: z.array(identitySchema) })),

  getIdentityByEmail: oc
    .input(z.object({ email: emailSchema }))
    .output(z.object({ identity: identitySchema.nullable() })),
};

/**
 * Auth service admin surface. Reachable as `/admin/service/auth/rpc` only after Gateway has
 * verified the session, the admin role and the grant on Auth.
 */
export const authAdminContract = {
  listIdentities: oc.input(paginationInputSchema).output(pageOf(adminIdentitySchema)),

  getIdentity: oc
    .input(z.object({ id: idSchema }))
    .output(z.object({ identity: adminIdentitySchema })),

  /** Sends the ordinary time-limited one-time recovery link. The token is never shown to admins. */
  sendRecovery: oc.input(z.object({ id: idSchema })).output(okSchema),

  resendVerification: oc.input(z.object({ id: idSchema })).output(okSchema),

  revokeSessions: oc.input(z.object({ id: idSchema })).output(okSchema),

  /** Owner-only. An owner can never block their own identity. */
  setBlocked: oc
    .input(z.object({ id: idSchema, blocked: z.boolean() }))
    .output(z.object({ ok: z.literal(true), identity: adminIdentitySchema })),

  listAudit: oc.input(paginationInputSchema).output(pageOf(authAuditEntrySchema)),
};

export const authContract = {
  public: authPublicContract,
  internal: authInternalContract,
  admin: authAdminContract,
};
