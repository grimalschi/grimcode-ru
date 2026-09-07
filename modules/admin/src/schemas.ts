import { z } from 'zod';

import {
  adminRoleSchema,
  assignableServiceIdSchema,
  emailSchema,
  idSchema,
  isoDateTimeSchema,
} from '@template/shared/vocabulary';

export const administratorSchema = z.object({
  id: idSchema,
  userId: idSchema,
  email: emailSchema,
  role: adminRoleSchema,
  enabled: z.boolean(),
  grants: z.array(assignableServiceIdSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Administrator = z.infer<typeof administratorSchema>;

export const adminAuditEntrySchema = z.object({
  id: idSchema,
  action: z.string().max(80),
  actorUserId: idSchema.nullable(),
  subjectUserId: idSchema.nullable(),
  details: z.record(z.string(), z.unknown()),
  createdAt: isoDateTimeSchema,
});

/**
 * Result of the single authorization method Gateway calls on every `/admin/**` request.
 *
 * `state` is deliberately explicit so Gateway never has to interpret an error: it either denies,
 * or forwards a verified administrator context it did not compute itself.
 */
export const authorizationResultSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('allowed'),
    userId: idSchema,
    email: emailSchema,
    role: adminRoleSchema,
  }),
  z.object({
    state: z.literal('denied'),
    reason: z.enum([
      'no-session',
      'not-an-administrator',
      'disabled',
      'no-grant',
      'owner-only',
      'unknown-service',
    ]),
  }),
  /** Auth has no users yet, so no owner can be bootstrapped. */
  z.object({ state: z.literal('awaiting-first-user') }),
]);

export type AuthorizationResult = z.infer<typeof authorizationResultSchema>;
