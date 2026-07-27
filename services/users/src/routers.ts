import { ORPCError } from '@orpc/client';
import { implement } from '@orpc/server';
import {
  usersAdminContract,
  usersInternalContract,
  usersPublicContract,
  type AdminContext,
  type authInternalContract,
  type ContractRouterClient,
  type Identity,
} from '@template/contracts';
import { createRpcClient, internalServiceUrl } from '@template/shared';

import { toProfile, type ProfileRow, type UsersRepository } from './repository.js';

type AuthClient = ContractRouterClient<typeof authInternalContract>;

/**
 * Fills in the sign-in address for a page of profiles.
 *
 * Users does not store it — Auth owns the identity — so it is fetched per request, in one call for
 * the whole page rather than one per row. An id Auth does not know stays `null`, which is how a
 * profile left behind by a deleted account is visible as exactly that.
 */
async function withEmails(rows: ProfileRow[]) {
  const profiles = rows.map((row) => ({ ...toProfile(row), email: null as string | null }));
  if (profiles.length === 0) return profiles;

  try {
    const auth = createRpcClient<AuthClient>({
      url: `${internalServiceUrl('auth')}/internal/rpc`,
    });

    const { identities } = await auth.getIdentitiesByIds({
      ids: [...new Set(rows.map((row) => row.identity_id))],
    });

    const byId = new Map(identities.map((identity) => [identity.id, identity.email]));
    for (const profile of profiles) profile.email = byId.get(profile.identityId) ?? null;
  } catch {
    // Auth being briefly unreachable is not a reason to refuse the whole page: the profiles are
    // still worth showing, and a missing address reads as missing.
  }

  return profiles;
}

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
  if (!context.identity) throw new ORPCError('UNAUTHORIZED', { message: 'Сессия не активна' });
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
    const row = await context.repo.updateProfile(identity.id, input.displayName);
    return { ok: true as const, profile: toProfile(row) };
  }),

});

const internalOs = implement(usersInternalContract).$context<InternalContext>();

export const internalRouter = internalOs.router({

  getProfileByIdentityId: internalOs.getProfileByIdentityId.handler(async ({ input, context }) => {
    const row = await context.repo.findByIdentityId(input.identityId);
    return { profile: row ? toProfile(row) : null };
  }),
});

const adminOs = implement(usersAdminContract).$context<AdminRpcContext>();

function requireAdmin(context: AdminRpcContext): AdminContext {
  if (!context.admin) throw new ORPCError('FORBIDDEN', { message: 'Контекст администратора отсутствует' });
  return context.admin;
}

export const adminRouter = adminOs.router({
  listProfiles: adminOs.listProfiles.handler(async ({ input, context }) => {
    requireAdmin(context);
    const { rows, total } = await context.repo.list(input.query, input.limit, input.offset);
    return {
      items: await withEmails(rows),
      total,
      limit: input.limit,
      offset: input.offset,
    };
  }),

  getProfile: adminOs.getProfile.handler(async ({ input, context }) => {
    requireAdmin(context);
    const row = await context.repo.findById(input.id);
    if (!row) throw new ORPCError('NOT_FOUND', { message: 'Профиль не найден' });

    const [profile] = await withEmails([row]);
    return { profile: profile! };
  }),

});
