import type { AdminRole, AdminTarget, AuthorizationResult } from '@template/contracts/modules/admin';
import type { CatalogueEntry } from './vocabulary.js';

import type { ModuleContext } from './context.js';

/**
 * The single decision Router asks for on every `/admin/**` request. Nothing is cached, so a changed
 * role or grant takes effect on the next one; what is known about the user comes from Auth through
 * its contract, never from its database.
 */
export async function authorize(
  { sessionToken, target }: { sessionToken: string | null; target: AdminTarget },
  deps: ModuleContext,
): Promise<AuthorizationResult> {
  const module = target.area === 'module' ? deps.catalogue.find(({ id }) => id === target.module) : undefined;
  if (target.area === 'module' && !module) {
    return { state: 'denied', reason: 'unknown-module' };
  }

  if (!sessionToken) {
    return (await nobodyHasRegistered(deps))
      ? { state: 'awaiting-first-user' }
      : { state: 'denied', reason: 'no-session' };
  }

  const { identity } = await deps.auth.resolveSession({ sessionToken: sessionToken });
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
    email: identity.email,
    role: administrator.role,
  } as const;

  // The panel itself is open to any enabled administrator; the sidebar then shows only what their
  // role and grants allow.
  if (target.area === 'panel') return allowed;

  if (administrator.role === 'owner') return allowed;
  if (module?.admin.assignable === false) {
    return { state: 'denied', reason: 'owner-only' };
  }

  const grants = administrator.grants ?? [];
  return grants.includes(target.module) ? allowed : { state: 'denied', reason: 'no-grant' };
}

/**
 * A fresh installation: the one case where a request without a session gets something other than a
 * refusal — the panel says it is waiting for the first user. The cheap question comes first, so a
 * running installation answers `false` before anything is asked of Auth.
 */
async function nobodyHasRegistered(deps: ModuleContext): Promise<boolean> {
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
async function bootstrapFirstOwner(deps: ModuleContext): Promise<void> {
  const { identity: first } = await deps.auth.getFirstIdentity({});
  if (!first) return;

  // The result says whether this call created the owner or found one; nothing reports it any more.
  await deps.repo.bootstrapOwner(first.id, first.email);
}

/** Admin modules this administrator may open, used to build the shell's sidebar. */
export function visibleModules(
  role: AdminRole,
  grants: readonly string[],
  catalogue: readonly CatalogueEntry[],
): string[] {
  return catalogue.filter(({ id, admin }) =>
    role === 'owner' || (admin.assignable !== false && grants.includes(id)),
  ).map(({ id }) => id);
}
