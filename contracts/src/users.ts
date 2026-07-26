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

/**
 * Product profile. Users never stores passwords, OAuth identities, sessions or admin rights.
 *
 * It is deliberately small. A product adds the fields it actually has; a template that guessed at
 * them would leave every project deleting things before adding its own.
 *
 * `locale` is not something a person sets here — one language is the common case — but Email needs
 * it to choose which version of a template to send, so it is stored with a default.
 */
export const userProfileSchema = z.object({
  id: idSchema,
  identityId: idSchema,
  displayName: z.string().min(1).max(120).nullable(),
  locale: localeSchema,
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
    .input(z.object({ displayName: z.string().min(1).max(120).nullable() }))
    .output(z.object({ ok: z.literal(true), profile: userProfileSchema })),

};

export const usersInternalContract = {
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
