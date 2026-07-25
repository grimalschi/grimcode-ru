import { ORPCError } from '@orpc/client';
import { implement } from '@orpc/server';
import {
  usersAdminContract,
  usersInternalContract,
  usersPublicContract,
  type AdminContext,
  type Identity,
} from '@template/contracts';
import { isCsrfValid } from '@template/shared';

import { toProfile, type UsersRepository } from './repository.js';

export interface PublicContext {
  repo: UsersRepository;
  /** Resolved through Auth on every call; `null` means no valid session. */
  identity: Identity | null;
}

export interface InternalContext {
  repo: UsersRepository;
}

export interface AdminRpcContext {
  repo: UsersRepository;
  request: Request;
  admin: AdminContext | null;
}

function requireIdentity(context: PublicContext): Identity {
  if (!context.identity) throw new ORPCError('UNAUTHORIZED', { message: 'No active session' });
  return context.identity;
}

const publicOs = implement(usersPublicContract).$context<PublicContext>();

export const publicRouter = publicOs.router({
  getOwnProfile: publicOs.getOwnProfile.handler(async ({ context }) => {
    const identity = requireIdentity(context);
    // The profile is created lazily on first access, so Auth never has to know about Users.
    return { profile: toProfile(await context.repo.ensure(identity.id)) };
  }),

  updateOwnProfile: publicOs.updateOwnProfile.handler(async ({ input, context }) => {
    const identity = requireIdentity(context);
    await context.repo.ensure(identity.id);
    return { ok: true as const, profile: toProfile(await context.repo.updateProfile(identity.id, input)) };
  }),

  updateOwnPreferences: publicOs.updateOwnPreferences.handler(async ({ input, context }) => {
    const identity = requireIdentity(context);
    await context.repo.ensure(identity.id);
    return {
      ok: true as const,
      profile: toProfile(await context.repo.updatePreferences(identity.id, input)),
    };
  }),

  completeOnboarding: publicOs.completeOnboarding.handler(async ({ input, context }) => {
    const identity = requireIdentity(context);
    await context.repo.ensure(identity.id);
    const row = await context.repo.completeOnboarding(identity.id, input.displayName, input.timeZone);
    return { ok: true as const, profile: toProfile(row) };
  }),
});

const internalOs = implement(usersInternalContract).$context<InternalContext>();

export const internalRouter = internalOs.router({
  ensureProfile: internalOs.ensureProfile.handler(async ({ input, context }) => ({
    profile: toProfile(await context.repo.ensure(input.identityId)),
  })),

  getProfileByIdentityId: internalOs.getProfileByIdentityId.handler(async ({ input, context }) => {
    const row = await context.repo.findByIdentityId(input.identityId);
    return { profile: row ? toProfile(row) : null };
  }),
});

const adminOs = implement(usersAdminContract).$context<AdminRpcContext>();

function requireAdmin(context: AdminRpcContext): AdminContext {
  if (!context.admin) throw new ORPCError('FORBIDDEN', { message: 'Administrator context missing' });
  return context.admin;
}

export const adminRouter = adminOs.router({
  listProfiles: adminOs.listProfiles.handler(async ({ input, context }) => {
    requireAdmin(context);
    const { rows, total } = await context.repo.list(input.query, input.limit, input.offset);
    return {
      items: rows.map((row) => ({ ...toProfile(row), email: null })),
      total,
      limit: input.limit,
      offset: input.offset,
    };
  }),

  getProfile: adminOs.getProfile.handler(async ({ input, context }) => {
    requireAdmin(context);
    const row = await context.repo.findById(input.id);
    if (!row) throw new ORPCError('NOT_FOUND', { message: 'Profile not found' });
    return { profile: { ...toProfile(row), email: null } };
  }),

  resetOnboarding: adminOs.resetOnboarding.handler(async ({ input, context }) => {
    requireAdmin(context);
    if (!isCsrfValid(context.request.headers)) {
      throw new ORPCError('FORBIDDEN', { message: 'CSRF token missing or invalid' });
    }
    const row = await context.repo.findById(input.id);
    if (!row) throw new ORPCError('NOT_FOUND', { message: 'Profile not found' });

    await context.repo.resetOnboarding(input.id);
    return { ok: true as const };
  }),
});
