import type { AuthInternalCaller } from '@template/auth/contract';
import {
  ADMIN_SERVICE_IDS,
  type AdminTarget,
  type AdminServiceId,
} from '@template/shared/vocabulary';

import type { AdminRepository } from './repository.js';
import type { AuthorizationResult } from './schemas.js';

export type AuthCaller = AuthInternalCaller;

export interface AuthorizeDeps {
  repo: AdminRepository;
  auth: AuthCaller;
}


/**
 * The single decision Gateway asks for on every `/admin/**` request. Nothing is cached, so a changed
 * role or grant takes effect on the next one; what is known about the user comes from Auth through
 * its contract, never from its database.
 */
export async function authorize(
  input: { sessionToken: string | null; target: AdminTarget },
  deps: AuthorizeDeps,
): Promise<AuthorizationResult> {
  if (input.target.area === 'service' && !ADMIN_SERVICE_IDS.includes(input.target.service)) {
    return { state: 'denied', reason: 'unknown-service' };
  }

  if (!input.sessionToken) {
    return (await nobodyHasRegistered(deps))
      ? { state: 'awaiting-first-user' }
      : { state: 'denied', reason: 'no-session' };
  }

  const { identity } = await deps.auth.resolveSession({ sessionToken: input.sessionToken });
  if (!identity) return { state: 'denied', reason: 'no-session' };

  if (await deps.repo.isRegistryEmpty()) await bootstrapFirstOwner(deps);

  const administrator = await deps.repo.findByUserId(identity.id);
  // Ownership follows registration order in Auth, not who opened the admin panel first. If someone
  // else opened it, the first Auth user still became owner and this request is refused.
  if (!administrator) return { state: 'denied', reason: 'not-an-administrator' };
  if (!administrator.enabled) return { state: 'denied', reason: 'disabled' };

  const allowed = {
    state: 'allowed',
    userId: administrator.user_id,
    email: administrator.email,
    role: administrator.role,
  } as const;

  // The panel itself is open to any enabled administrator; the sidebar then shows only what their
  // role and grants allow.
  if (input.target.area === 'panel') return allowed;

  /*
   * The database browser is part of the panel rather than a service admin, and it reads every
   * service's data at once. That is why it is the owner's alone and appears in no grant: there is
   * nothing to hand out, so nothing can be handed out by mistake.
   */
  if (input.target.area === 'database') {
    return administrator.role === 'owner' ? allowed : { state: 'denied', reason: 'owner-only' };
  }

  if (administrator.role === 'owner') return allowed;

  const grants = administrator.grants ?? [];
  return grants.includes(input.target.service) ? allowed : { state: 'denied', reason: 'no-grant' };
}

/**
 * A fresh installation: the one case where a request without a session gets something other than a
 * refusal — the panel says it is waiting for the first user. The cheap question comes first, so a
 * running installation answers `false` before anything is asked of Auth.
 */
async function nobodyHasRegistered(deps: AuthorizeDeps): Promise<boolean> {
  if (!(await deps.repo.isRegistryEmpty())) return false;

  const { identity } = await deps.auth.getFirstIdentity({});
  return identity === null;
}

/**
 * Promotes the earliest registered Auth identity to owner. Idempotent and safe under concurrency: the
 * insert is conditional, only the request that created the row writes the audit entry, and once any
 * administrator exists this stops being attempted at all.
 *
 * A caller that got here holds a resolved session, so Auth has at least one identity and the empty
 * answer below cannot happen; it leaves the registry empty, and the request is refused as any
 * non-administrator's would be.
 */
async function bootstrapFirstOwner(deps: AuthorizeDeps): Promise<void> {
  const { identity: first } = await deps.auth.getFirstIdentity({});
  if (!first) return;

  // The result says whether this call created the owner or found one; nothing reports it any more.
  await deps.repo.bootstrapOwner(first.id, first.email);
}

/** Admin services this administrator may open, used to build the shell's sidebar. */
export function visibleServices(
  role: 'owner' | 'admin',
  grants: readonly string[],
): AdminServiceId[] {
  if (role === 'owner') return [...ADMIN_SERVICE_IDS];
  return ADMIN_SERVICE_IDS.filter((service) => grants.includes(service));
}

/** Whether the panel should offer its database browser at all. */
export function canOpenDatabase(role: 'owner' | 'admin'): boolean {
  return role === 'owner';
}
