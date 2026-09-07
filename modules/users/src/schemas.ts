import { z } from 'zod';

import { emailSchema, idSchema, isoDateTimeSchema } from '@template/shared/vocabulary';

/**
 * Product profile. Users never stores passwords, OAuth identities, sessions or admin rights.
 *
 * It is deliberately small. A product adds the fields it actually has; a template that guessed at
 * them would leave every project deleting things before adding its own.
 */
export const userProfileSchema = z.object({
  id: idSchema,
  identityId: idSchema,
  displayName: z.string().min(1).max(120).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type UserProfile = z.infer<typeof userProfileSchema>;

/**
 * A profile as an administrator sees it, with the sign-in address Auth holds.
 *
 * Users does not store the address — Auth owns it — so this is filled in per request from Auth.
 * It is `null` when Auth no longer has that identity, which is how a profile left behind by a
 * deleted account shows up rather than looking like an ordinary one.
 */
export const adminUserProfileSchema = userProfileSchema.extend({
  email: emailSchema.nullable(),
});

/** The profile as an administrator sees it: the product fields plus the account they belong to. */
export type AdminUserProfile = z.infer<typeof adminUserProfileSchema>;
