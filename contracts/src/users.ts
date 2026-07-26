import { oc } from '@orpc/contract';
import { z } from 'zod';

import {
  emailSchema,
  idSchema,
  isoDateTimeSchema,
  localeSchema,
  pageOf,
  paginationInputSchema,
} from './common.js';

export const themePreferenceSchema = z.enum(['light', 'dark', 'system']);

export const userPreferencesSchema = z.object({
  locale: localeSchema,
  theme: themePreferenceSchema,
  productEmails: z.boolean(),
});

/** Product profile. Users never stores passwords, OAuth identities, sessions or admin rights. */
export const userProfileSchema = z.object({
  id: idSchema,
  identityId: idSchema,
  displayName: z.string().min(1).max(120).nullable(),
  timeZone: z.string().max(64).nullable(),
  preferences: userPreferencesSchema,
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

export const usersPublicContract = {
  /** Profile of the caller. Requires a valid user session, verified through Auth. */
  getOwnProfile: oc.input(z.object({})).output(z.object({ profile: userProfileSchema })),

  updateOwnProfile: oc
    .input(
      z.object({
        displayName: z.string().min(1).max(120).nullable().optional(),
        timeZone: z.string().max(64).nullable().optional(),
      }),
    )
    .output(z.object({ ok: z.literal(true), profile: userProfileSchema })),

  updateOwnPreferences: oc
    .input(userPreferencesSchema.partial())
    .output(z.object({ ok: z.literal(true), profile: userProfileSchema })),

};

export const usersInternalContract = {
  /** Idempotently creates the product profile bound to an Auth identity. */
  ensureProfile: oc
    .input(z.object({ identityId: idSchema }))
    .output(z.object({ profile: userProfileSchema })),

  getProfileByIdentityId: oc
    .input(z.object({ identityId: idSchema }))
    .output(z.object({ profile: userProfileSchema.nullable() })),
};

export const usersAdminContract = {
  listProfiles: oc.input(paginationInputSchema).output(pageOf(adminUserProfileSchema)),

  getProfile: oc
    .input(z.object({ id: idSchema }))
    .output(z.object({ profile: adminUserProfileSchema })),

};

export const usersContract = {
  public: usersPublicContract,
  internal: usersInternalContract,
  admin: usersAdminContract,
};
