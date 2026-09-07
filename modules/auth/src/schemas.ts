import { z } from 'zod';

import { emailSchema, idSchema, isoDateTimeSchema } from '@template/shared/vocabulary';

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

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

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

export const passwordSchema = z.string().min(12, 'Password must contain at least 12 characters').max(200);

/** One line of the audit log, as this module's own panel renders it. */
export type AuthAuditEntry = z.infer<typeof authAuditEntrySchema>;
