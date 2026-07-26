import { implement } from '@orpc/server';
import { authInternalContract } from '@template/contracts';

import { toIdentity, type AuthRepository } from '../repository.js';

export interface InternalContext {
  repo: AuthRepository;
}

/**
 * Reachable only on `/internal/rpc`, which Gateway never proxies, so these procedures stay inside
 * the Docker network. Admin depends on them to resolve the current user and to bootstrap the very
 * first owner.
 */
const os = implement(authInternalContract).$context<InternalContext>();

export const internalRouter = os.router({
  resolveSession: os.resolveSession.handler(async ({ input, context }) => {
    const resolved = await context.repo.resolveSession(input.sessionToken);
    // A blocked identity has no usable session, even if the row itself has not expired yet.
    if (!resolved || resolved.identity.blocked_at !== null) return { identity: null };
    return { identity: toIdentity(resolved.identity) };
  }),

  getFirstIdentity: os.getFirstIdentity.handler(async ({ context }) => {
    const row = await context.repo.findFirstIdentity();
    return { identity: row ? toIdentity(row) : null };
  }),


  getIdentitiesByIds: os.getIdentitiesByIds.handler(async ({ input, context }) => {
    const rows = await context.repo.findIdentitiesByIds(input.ids);
    return { identities: rows.map(toIdentity) };
  }),

  searchIdentities: os.searchIdentities.handler(async ({ input, context }) => {
    const rows = await context.repo.searchIdentities(input.query, input.limit);
    return { identities: rows.map(toIdentity) };
  }),

  getIdentityByEmail: os.getIdentityByEmail.handler(async ({ input, context }) => {
    const row = await context.repo.findIdentityByEmail(input.email);
    return { identity: row ? toIdentity(row) : null };
  }),
});
